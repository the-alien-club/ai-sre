// Escalation persistence.
//
// An unacknowledged critical prod alert nags the team in-thread every 10 minutes until
// somebody answers. That timer lived only in process memory, and the VM restarts the agent
// nightly (`0 3 * * * pm2 restart sre-agent`) — so any escalation still waiting at 03:00
// UTC stopped nagging forever, silently, and nobody was poked again.
//
// Unlike thread ownership, there is no Slack-side truth to re-derive this from: whether an
// alert was acknowledged, how many nags it has had, and which fingerprint it belongs to are
// facts only this process ever knew. So they go to disk.
//
// The file is written atomically (temp file + rename) because the process can be killed
// mid-write by pm2 at any moment, and a half-written JSON file on startup would be worse
// than no file at all.
//
// scripts/incidents.sh reads this file too: it refuses to record an incident as escalated
// unless a live record here shows the operators were told (see `mark-escalated` there).
// Field names are therefore an interface, not an implementation detail.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Escalation {
  alertFingerprint: string;
  alertName: string;
  severity: Severity;
  environment: string; // "dev", "staging", "prod"
  slackThreadTs: string | undefined; // thread to nag in
  slackChannel: string | undefined; // channel to nag in
  escalatedAt: number; // timestamp of first escalation
  lastNagAt: number; // timestamp of last nag
  acknowledged: boolean; // an operator replied
  acknowledgedBy: string | undefined; // display name of whoever acknowledged
  nagCount: number;
  /**
   * No longer nags and no longer absorbs new escalations of its fingerprint: either a newer
   * top-level escalation replaced it (escalator.ts), or it outlived SUPERSEDE_AFTER_MS.
   * Kept so a reply in its thread still acknowledges, and so incidents.sh can tell it apart
   * from a live page.
   */
  superseded: boolean;
  /** Threads (in slackChannel) of earlier escalations of this fingerprint that this one replaced. */
  earlierThreadTs: string[];
  /** When the escalate tool was last called for this fingerprint, posting or not. */
  lastRequestedAt: number;
}

/**
 * The severities, lowest first. The escalate tool accepts only these, so a record carrying
 * anything else was written by hand and is dropped on load.
 */
export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isSeverity(value: string): value is Severity {
  return SEVERITIES.some((severity) => severity === value);
}

/** Positive when `a` is more severe than `b`. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITIES.indexOf(a) - SEVERITIES.indexOf(b);
}

export interface EscalationStoreOptions {
  /** Where the JSON lives. Its directory is created if missing. */
  path: string;
  /** Escalations older than this are dropped on load, so none can nag forever. */
  maxAgeMs?: number;
  /** Injectable clock, so staleness is testable without waiting. */
  now?: () => number;
}

export interface EscalationStore {
  load(): Map<string, Escalation>;
  save(escalations: Map<string, Escalation>): void;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * An escalation older than this is superseded at startup (supersedeOlderThan). On 2026-10-30
 * 42 records, several nagged 17-26 times in-thread and never answered, kept absorbing new
 * alerts of their fingerprints, so the read-only Postgres outage paged nobody.
 */
export const SUPERSEDE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The fields 0.10.0 added. A record written before it has none of them. */
type AddedIn010 = "superseded" | "earlierThreadTs" | "lastRequestedAt";

type StoredEscalation = Omit<Escalation, AddedIn010> & Partial<Pick<Escalation, AddedIn010>>;

function isStoredEscalation(value: unknown): value is StoredEscalation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.alertFingerprint === "string" &&
    typeof candidate.alertName === "string" &&
    typeof candidate.severity === "string" &&
    isSeverity(candidate.severity) &&
    typeof candidate.environment === "string" &&
    (candidate.slackThreadTs === undefined ||
      typeof candidate.slackThreadTs === "string") &&
    (candidate.slackChannel === undefined ||
      typeof candidate.slackChannel === "string") &&
    typeof candidate.escalatedAt === "number" &&
    typeof candidate.lastNagAt === "number" &&
    typeof candidate.acknowledged === "boolean" &&
    (candidate.acknowledgedBy === undefined ||
      typeof candidate.acknowledgedBy === "string") &&
    typeof candidate.nagCount === "number" &&
    (candidate.superseded === undefined || typeof candidate.superseded === "boolean") &&
    (candidate.earlierThreadTs === undefined ||
      (Array.isArray(candidate.earlierThreadTs) && candidate.earlierThreadTs.every((ts) => typeof ts === "string"))) &&
    (candidate.lastRequestedAt === undefined || typeof candidate.lastRequestedAt === "number")
  );
}

/**
 * The escalations a reply in `threadTs` acknowledges: the one posted there, and the one that
 * replaced it (an operator answering the earlier, quieter thread has still answered).
 */
export function escalationsForThread(escalations: Map<string, Escalation>, threadTs: string): Escalation[] {
  return [...escalations.values()].filter((e) => e.slackThreadTs === threadTs || e.earlierThreadTs.includes(threadTs));
}

/**
 * Marks every live escalation posted before `now - ageMs` as superseded, and returns how many
 * it marked. Idempotent: a superseded one stays as it is. Run once at startup, so the nightly
 * restart retires what nobody answered in a day; the escalate tool's staleness window
 * (escalator.ts) is what stops a stale thread from absorbing a new alert in between.
 */
export function supersedeOlderThan(escalations: Map<string, Escalation>, now: number, ageMs: number): number {
  const cutoff = now - ageMs;
  let marked = 0;
  for (const escalation of escalations.values()) {
    if (escalation.superseded || escalation.escalatedAt >= cutoff) continue;
    escalation.superseded = true;
    marked++;
  }
  return marked;
}

export function createEscalationStore(
  options: EscalationStoreOptions
): EscalationStore {
  const { path, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now } = options;
  const tempPath = `${path}.tmp`;

  return {
    load() {
      const restored = new Map<string, Escalation>();

      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        // A missing file is the normal first-run case and says nothing worth logging.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(
            `[escalation-store] could not read ${path} — starting with no escalations:`,
            err instanceof Error ? err.message : String(err)
          );
        }
        return restored;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Losing nag timers is recoverable; refusing to start would take the agent's
        // whole Slack channel offline over a corrupt bookkeeping file.
        console.error(
          `[escalation-store] ${path} is not valid JSON — starting with no escalations:`,
          err instanceof Error ? err.message : String(err)
        );
        return restored;
      }

      if (!Array.isArray(parsed)) {
        console.error(
          `[escalation-store] ${path} is not an array — starting with no escalations`
        );
        return restored;
      }

      const cutoff = now() - maxAgeMs;
      let dropped = 0;

      for (const entry of parsed) {
        if (!isStoredEscalation(entry)) {
          dropped++;
          continue;
        }
        if (entry.escalatedAt < cutoff) {
          dropped++;
          continue;
        }
        // Rebuild rather than adopt the parsed object: JSON.stringify omits undefined
        // properties, so a round-tripped entry is missing the optional keys the type
        // declares. Copying field by field also drops anything the file has that the
        // current shape does not. A record from before 0.10.0 lacks the fields it added: it was
        // live (nothing superseded anything then), replaced no thread, and was last asked for
        // when it was posted.
        restored.set(entry.alertFingerprint, {
          alertFingerprint: entry.alertFingerprint,
          alertName: entry.alertName,
          severity: entry.severity,
          environment: entry.environment,
          slackThreadTs: entry.slackThreadTs,
          slackChannel: entry.slackChannel,
          escalatedAt: entry.escalatedAt,
          lastNagAt: entry.lastNagAt,
          acknowledged: entry.acknowledged,
          acknowledgedBy: entry.acknowledgedBy,
          nagCount: entry.nagCount,
          superseded: entry.superseded ?? false,
          earlierThreadTs: [...(entry.earlierThreadTs ?? [])],
          lastRequestedAt: entry.lastRequestedAt ?? entry.escalatedAt,
        });
      }

      if (dropped > 0) {
        console.error(
          `[escalation-store] dropped ${dropped} stale or malformed escalation(s) from ${path}`
        );
      }

      return restored;
    },

    save(escalations) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tempPath, JSON.stringify([...escalations.values()], null, 2), "utf8");
        renameSync(tempPath, path);
      } catch (err) {
        console.error(
          `[escalation-store] failed to persist escalations to ${path}:`,
          err instanceof Error ? err.message : String(err)
        );
        // Leave no half-written temp file behind to confuse the next write.
        try {
          unlinkSync(tempPath);
        } catch {
          // Nothing to clean up, or the directory itself is unwritable — either way the
          // error above is the one worth reporting.
        }
      }
    },
  };
}
