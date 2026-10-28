// Remediation persistence: which sentinel alert episodes this agent has already acted on.
//
// A stage-1 `remediable` alert is re-notified by AM-S every hour while its condition holds
// (sentinel catalog/routing.yaml, class `remediable`, repeat_interval 1h), and the agent is
// restarted nightly by pm2. The rule is one Rundeck run per firing episode, whatever came of
// it, so the record of that run has to outlive the process.
//
// Same file discipline as escalation-store.ts: atomic write (temp file + rename), and a
// corrupt or unreadable file is logged and treated as empty rather than stopping the channel.
// Starting empty is safe: the job's own breaker refuses a fingerprint past its limits.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * - `claimed`: recorded before the first Rundeck call; a record left in this state means the
 *   process died mid-attempt, which still counts as the attempt.
 * - `started`: Rundeck created an execution (`executionId`).
 * - `refused`: Rundeck, or the live job definition, said no; never retried.
 * - `failed`: Rundeck could not be asked (timeout, network, 5xx); not retried either, because a
 *   timed-out run may still have started, and stage 2 escalates by persistence.
 */
export type RemediationOutcome = "claimed" | "started" | "refused" | "failed";

export interface RemediationRecord {
  fingerprint: string; // Alertmanager fingerprint
  startsAt: string; // the episode: Alertmanager keeps startsAt across re-notifications
  alertName: string;
  action: string;
  target: string;
  claimedAt: number;
  outcome: RemediationOutcome;
  executionId: number | undefined;
  executionUrl: string | undefined;
  detail: string | undefined; // why it was refused or failed
}

export interface RemediationStoreOptions {
  /** Where the JSON lives. Its directory is created if missing. */
  path: string;
  /** Records older than this are dropped on load. */
  maxAgeMs?: number;
  /** Injectable clock, so staleness is testable without waiting. */
  now?: () => number;
}

export interface RemediationStore {
  load(): Map<string, RemediationRecord>;
  /** @throws Error when the records cannot be written; the caller decides what that means. */
  save(records: Map<string, RemediationRecord>): void;
}

// Far longer than any episode lives: stage 2 takes over 45-60 min after stage 1 fires, and
// stage 2 inhibits stage 1 on the same scope.
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const OUTCOMES: readonly RemediationOutcome[] = ["claimed", "started", "refused", "failed"];

function isOptional(value: unknown, type: "string" | "number"): boolean {
  return value === undefined || typeof value === type;
}

function isRemediationRecord(value: unknown): value is RemediationRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.fingerprint === "string" &&
    typeof candidate.startsAt === "string" &&
    typeof candidate.alertName === "string" &&
    typeof candidate.action === "string" &&
    typeof candidate.target === "string" &&
    typeof candidate.claimedAt === "number" &&
    OUTCOMES.includes(candidate.outcome as RemediationOutcome) &&
    isOptional(candidate.executionId, "number") &&
    isOptional(candidate.executionUrl, "string") &&
    isOptional(candidate.detail, "string")
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createRemediationStore(options: RemediationStoreOptions): RemediationStore {
  const { path, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now } = options;
  const tempPath = `${path}.tmp`;

  return {
    load() {
      const restored = new Map<string, RemediationRecord>();

      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        // A missing file is the normal first-run case and says nothing worth logging.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[remediation-store] could not read ${path}, starting with no records: ${errorMessage(err)}`);
        }
        return restored;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(`[remediation-store] ${path} is not valid JSON, starting with no records: ${errorMessage(err)}`);
        return restored;
      }

      if (!Array.isArray(parsed)) {
        console.error(`[remediation-store] ${path} is not an array, starting with no records`);
        return restored;
      }

      const cutoff = now() - maxAgeMs;
      let dropped = 0;

      for (const entry of parsed) {
        if (!isRemediationRecord(entry) || entry.claimedAt < cutoff) {
          dropped++;
          continue;
        }
        // Rebuilt field by field: JSON drops undefined keys, and anything the file has that
        // the current shape does not is left behind.
        restored.set(entry.fingerprint, {
          fingerprint: entry.fingerprint,
          startsAt: entry.startsAt,
          alertName: entry.alertName,
          action: entry.action,
          target: entry.target,
          claimedAt: entry.claimedAt,
          outcome: entry.outcome,
          executionId: entry.executionId,
          executionUrl: entry.executionUrl,
          detail: entry.detail,
        });
      }

      if (dropped > 0) {
        console.error(`[remediation-store] dropped ${dropped} stale or malformed record(s) from ${path}`);
      }

      return restored;
    },

    save(records) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tempPath, JSON.stringify([...records.values()], null, 2), "utf8");
        renameSync(tempPath, path);
      } catch (err) {
        // Leave no half-written temp file behind to confuse the next write.
        try {
          unlinkSync(tempPath);
        } catch {
          // Nothing to clean up, or the directory itself is unwritable: the error below is
          // the one worth reporting.
        }
        throw new Error(`[remediation-store] failed to persist ${path}: ${errorMessage(err)}`);
      }
    },
  };
}
