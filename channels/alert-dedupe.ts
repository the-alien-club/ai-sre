// Dedupe of alert deliveries across the two Alertmanagers.
//
// Sentinel's AM-S (VM-A) and AM-R (Railway) both deliver every alert to POST /alert. The two
// copies carry the same per-alert `fingerprint`, the same `status` and a byte-identical
// `startsAt` (both relays pass SigNoz's through verbatim); only the payload's `receiver` and
// `groupKey` differ, and they arrive seconds to minutes apart. Without this, every alert
// reaches the session twice and costs it a second triage.
//
// - The key is (fingerprint, status, startsAt): a resolve is never swallowed by its firing,
//   and `receiver` / `groupKey` are never part of it, because they are what differs.
// - A key is a duplicate for DEDUPE_WINDOW_MS after it was accepted. A re-notification of the
//   same episode hours later (repeat_interval) is past the window and reaches the session
//   again, which is the behaviour before this existed.
// - In memory only: a restart loses at most one window, and the runbook's own
//   "Duplicate/flapping" rule is the backstop for that.
// - An alert without a fingerprint or startsAt is never deduped, so a malformed sender cannot
//   suppress real alerts.

/** 10 min: one relay cycle (60 s), plus group_wait (up to 5 min), plus group_interval jitter. */
export const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/** A flood of distinct alerts cannot grow the store past this; the oldest entries go first. */
export const DEDUPE_MAX_ENTRIES = 10_000;

/** The fields of one Alertmanager alert the key is made of; `status` is the effective one. */
export interface AlertIdentity {
  fingerprint: unknown;
  status: unknown;
  startsAt: unknown;
}

export type DedupeVerdict =
  /** First delivery in the window: push it. `key` is what `release` takes if the push fails. */
  | { kind: "first"; key: string }
  /** Already accepted `ageMs` ago: do not push. */
  | { kind: "duplicate"; key: string; ageMs: number }
  /** Cannot be keyed: push it, and nothing was recorded. */
  | { kind: "unkeyed"; reason: string };

export interface AlertDedupe {
  /** Classifies one delivery, and records it when it is the first of its key. */
  claim(alert: AlertIdentity): DedupeVerdict;
  /** Forgets a key whose push failed, so the other Alertmanager's copy is not dropped. */
  release(key: string): void;
  /** The number of keys currently held. */
  size(): number;
}

export interface AlertDedupeOptions {
  windowMs?: number;
  maxEntries?: number;
  now?: () => number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The key of a delivery, or why it has none. */
export function dedupeKey(alert: AlertIdentity): { key: string } | { reason: string } {
  if (!nonEmptyString(alert.fingerprint)) return { reason: "the alert has no fingerprint" };
  if (!nonEmptyString(alert.startsAt)) return { reason: "the alert has no startsAt" };
  if (!nonEmptyString(alert.status)) return { reason: "the alert has no status" };
  return { key: `${alert.fingerprint}|${alert.status}|${alert.startsAt}` };
}

export function createAlertDedupe(options: AlertDedupeOptions = {}): AlertDedupe {
  const { windowMs = DEDUPE_WINDOW_MS, maxEntries = DEDUPE_MAX_ENTRIES, now = Date.now } = options;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError(`dedupe window must be a positive number of ms, got ${windowMs}`);
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new RangeError(`dedupe capacity must be a positive integer, got ${maxEntries}`);

  // key → accepted-at ms. A Map iterates in insertion order and a key is only ever inserted
  // when it is accepted, so the first entries are always the oldest.
  const accepted = new Map<string, number>();

  function prune(at: number): void {
    for (const [key, acceptedAt] of accepted) {
      if (at - acceptedAt < windowMs) break;
      accepted.delete(key);
    }
  }

  return {
    claim(alert) {
      const at = now();
      prune(at);

      const identity = dedupeKey(alert);
      if ("reason" in identity) return { kind: "unkeyed", reason: identity.reason };
      const { key } = identity;

      const acceptedAt = accepted.get(key);
      if (acceptedAt !== undefined) return { kind: "duplicate", key, ageMs: at - acceptedAt };

      while (accepted.size >= maxEntries) {
        const oldest = accepted.keys().next();
        if (oldest.done) break;
        accepted.delete(oldest.value);
      }
      accepted.set(key, at);
      return { kind: "first", key };
    },

    release(key) {
      accepted.delete(key);
    },

    size() {
      return accepted.size;
    },
  };
}
