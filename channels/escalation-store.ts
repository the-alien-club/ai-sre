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

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Escalation {
  alertFingerprint: string;
  alertName: string;
  severity: string;
  environment: string; // "dev", "staging", "prod"
  slackThreadTs: string | undefined; // thread to nag in
  slackChannel: string | undefined; // channel to nag in
  escalatedAt: number; // timestamp of first escalation
  lastNagAt: number; // timestamp of last nag
  acknowledged: boolean; // an operator replied
  acknowledgedBy: string | undefined; // display name of whoever acknowledged
  nagCount: number;
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

function isEscalation(value: unknown): value is Escalation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.alertFingerprint === "string" &&
    typeof candidate.alertName === "string" &&
    typeof candidate.severity === "string" &&
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
    typeof candidate.nagCount === "number"
  );
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
        if (!isEscalation(entry)) {
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
        // current shape does not.
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
