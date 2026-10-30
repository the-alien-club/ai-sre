// The daily digest of unacknowledged escalations.
//
// Warnings and info are no longer nagged in their threads (escalation-nag.ts). They are
// listed here once a day instead: one top-level message, no mention, every live escalation
// still waiting for an answer, critical first, oldest first, each linking its thread. Nothing
// waiting, nothing posted.
//
// When it last went out is persisted, so the nightly restart neither skips nor repeats it.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isTrivyEscalation } from "./escalation-policy.js";
import { compareSeverity, type Escalation } from "./escalation-store.js";
import { escapeSlackText } from "./slack-text.js";

/** At most this many escalations are listed; the rest are counted. */
const DIGEST_LISTED = 20;

/** Live, unacknowledged escalations, in the order the digest lists them. */
export function waitingEscalations(escalations: Iterable<Escalation>): Escalation[] {
  return [...escalations]
    .filter((e) => !e.acknowledged && !e.superseded && !isTrivyEscalation(e.alertFingerprint))
    .sort((a, b) => compareSeverity(b.severity, a.severity) || a.escalatedAt - b.escalatedAt);
}

function age(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const EMOJI = { critical: ":rotating_light:", warning: ":warning:", info: ":information_source:" } as const;

/**
 * The digest's text, or undefined when nothing is waiting. Alert names come from the agent,
 * which read them from alerts: escaped, so the digest can never mention anyone.
 */
export function buildEscalationDigest(
  escalations: Iterable<Escalation>,
  now: number,
  threadLink: (channel: string, ts: string) => string
): string | undefined {
  const waiting = waitingEscalations(escalations);
  if (waiting.length === 0) return undefined;

  const lines = [
    `:clipboard: *Unacknowledged escalations* — ${new Date(now).toISOString().slice(0, 10)}`,
    `${waiting.length} waiting for an answer. A reply in a thread acknowledges it. Posted once a day, pages no one; ` +
      `warnings are not reminded in their threads.`,
    "",
  ];
  for (const e of waiting.slice(0, DIGEST_LISTED)) {
    const thread = e.slackChannel !== undefined && e.slackThreadTs !== undefined ? ` <${threadLink(e.slackChannel, e.slackThreadTs)}|thread>` : "";
    lines.push(
      `• ${EMOJI[e.severity]} *${escapeSlackText(e.alertName)}* [${escapeSlackText(e.environment.toUpperCase())}] ${e.severity}, ` +
        `waiting ${age(now - e.escalatedAt)}${thread}`
    );
  }
  if (waiting.length > DIGEST_LISTED) lines.push(`• … and ${waiting.length - DIGEST_LISTED} more`);
  return lines.join("\n");
}

export interface DigestClock {
  /** When the digest last went out (ms), 0 when it never has. */
  lastPostedAt(): number;
  markPosted(at: number): void;
}

/**
 * The digest's clock, persisted at `path`. Unreadable or malformed, it says so and counts as
 * never posted: one extra digest is better than a channel that will not start.
 */
export function createDigestClock(path: string): DigestClock {
  let last = 0;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "lastPostedAt" in parsed && typeof parsed.lastPostedAt === "number") {
      last = parsed.lastPostedAt;
    } else {
      console.error(`[escalation-digest] ${path} has no numeric lastPostedAt; treating the digest as never posted`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `[escalation-digest] could not read ${path}; treating the digest as never posted:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    lastPostedAt: () => last,
    markPosted(at) {
      last = at;
      const temp = `${path}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temp, JSON.stringify({ lastPostedAt: at }), "utf8");
        renameSync(temp, path);
      } catch (err) {
        // In memory it is still marked, so this process will not repeat it; a restart might.
        console.error(`[escalation-digest] failed to persist ${path}:`, err instanceof Error ? err.message : String(err));
        try {
          unlinkSync(temp);
        } catch {
          // Nothing to clean up, or the directory is unwritable: the error above says which.
        }
      }
    },
  };
}
