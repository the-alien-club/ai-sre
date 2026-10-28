// The escalate tool: one top-level thread per unacknowledged alert.
//
// The agent can call `escalate` twice for one fingerprint: the second Alertmanager's copy of
// an alert that slipped past the channel's dedupe (a restart in between), or a re-notification
// it decided to escalate again. Posting a second top-level message and overwriting the record
// would orphan the first thread: operators reply there, and the reply would no longer stop the
// nag loop, which now follows the second thread. So while an escalation for the fingerprint is
// still waiting (in the map, not acknowledged), escalate answers with that thread instead and
// leaves its record untouched. An acknowledged one can be escalated afresh.
//
// A post that timed out may still have landed (slack-poster.ts). If the agent then escalates
// the same fingerprint again, posting blindly could put two threads in the channel. So the
// escalation text carries its fingerprint, and the next escalate after an uncertain post
// first looks for it in the channel's recent history: found, it adopts that thread; not
// found, it posts; history unreadable, it refuses rather than guess.

import type { Escalation } from "./escalation-store.js";
import { SlackPostRejected, type SlackPoster } from "./slack-poster.js";
import { escapeSlackText } from "./slack-text.js";

export interface EscalateRequest {
  alertFingerprint: string;
  alertName: string;
  severity: string;
  environment: string;
  message: string;
}

export interface EscalateOutcome {
  channel: string;
  ts: string;
  /** True when no message was posted because the alert already has a waiting thread. */
  deduplicated: boolean;
}

export interface EscalatorDeps {
  /** The team channel escalations are posted to. */
  channel: string;
  /** The @-mentions that page every operator, used for critical alerts only. */
  operatorMentions: string;
  /** fingerprint → escalation, shared with the nag loop and the acknowledgement handler. */
  escalations: Map<string, Escalation>;
  persist: () => void;
  /** Bounded, single-attempt Slack posting. */
  poster: SlackPoster;
  /** The bot's own user id, whose messages the history lookup matches. */
  botUserId: () => string;
  /** Marks a thread as the agent's, so replies in it reach the session. */
  rememberThread: (ts: string) => void;
  now?: () => number;
}

export interface Escalator {
  /**
   * Rejects when Slack could not be posted to, or when an earlier post's outcome is unknown
   * and cannot be checked; the tool handler turns that into an error result.
   */
  escalate(request: EscalateRequest): Promise<EscalateOutcome>;
}

/** The line that identifies an escalation's thread in the channel history. */
export function fingerprintMarker(alertFingerprint: string): string {
  return `Alert fingerprint: \`${escapeSlackText(alertFingerprint)}\``;
}

/** How long before an uncertain post the history lookup starts, for clock skew with Slack. */
const LOOKUP_SKEW_MS = 60 * 1000;

function escalationText(request: EscalateRequest, operatorMentions: string): string {
  const { alertName, severity, environment, message } = request;
  const severityEmoji = severity === "critical" ? ":rotating_light:" : severity === "warning" ? ":warning:" : ":information_source:";
  // Only critical alerts page the whole team — warnings and info post quietly.
  const page = severity === "critical" ? `${operatorMentions}\n` : "";

  return (
    `${severityEmoji} *SRE Alert Escalation* [${environment.toUpperCase()}]\n` +
    page +
    `\n*Alert:* ${alertName}\n` +
    `*Severity:* ${severity}\n` +
    `*Environment:* ${environment}\n\n` +
    `${message}\n\n` +
    `_Reply in this thread to talk to the SRE agent._\n` +
    `_${fingerprintMarker(request.alertFingerprint)}_`
  );
}

export function createEscalator(deps: EscalatorDeps): Escalator {
  const { channel, operatorMentions, escalations, persist, poster, botUserId, rememberThread, now = Date.now } = deps;
  // fingerprint → the post in flight, so two concurrent calls cannot both post
  const inFlight = new Map<string, Promise<EscalateOutcome>>();
  // fingerprint → when a post whose outcome is unknown was attempted
  const uncertain = new Map<string, number>();

  function waitingThread(fingerprint: string): EscalateOutcome | undefined {
    const existing = escalations.get(fingerprint);
    if (!existing || existing.acknowledged) return undefined;
    // A record without a thread (restored from an older file) has nothing to point at
    if (existing.slackChannel === undefined || existing.slackThreadTs === undefined) return undefined;
    return { channel: existing.slackChannel, ts: existing.slackThreadTs, deduplicated: true };
  }

  function record(request: EscalateRequest, ts: string, at: number): EscalateOutcome {
    rememberThread(ts);
    escalations.set(request.alertFingerprint, {
      alertFingerprint: request.alertFingerprint,
      alertName: request.alertName,
      severity: request.severity,
      environment: request.environment,
      slackThreadTs: ts,
      slackChannel: channel,
      escalatedAt: at,
      lastNagAt: at,
      acknowledged: false,
      acknowledgedBy: undefined,
      nagCount: 0,
    });
    persist();
    return { channel, ts, deduplicated: false };
  }

  async function post(request: EscalateRequest): Promise<EscalateOutcome> {
    const fingerprint = request.alertFingerprint;
    const attemptedAt = uncertain.get(fingerprint);
    if (attemptedAt !== undefined) {
      let found: string | undefined;
      try {
        found = await poster.findRecent(channel, botUserId(), fingerprintMarker(fingerprint), attemptedAt - LOOKUP_SKEW_MS);
      } catch (err) {
        throw new Error(
          `an earlier escalation of ${fingerprint} timed out and may be visible, and the channel history could not be checked ` +
            `(${err instanceof Error ? err.message : String(err)}); not posting again, try later`
        );
      }
      uncertain.delete(fingerprint);
      if (found !== undefined) return { ...record(request, found, attemptedAt), deduplicated: true };
    }

    const startedAt = now();
    let ts: string;
    try {
      ts = await poster.post({ channel, text: escalationText(request, operatorMentions) });
    } catch (err) {
      if (!(err instanceof SlackPostRejected)) uncertain.set(fingerprint, startedAt);
      throw err;
    }
    return record(request, ts, startedAt);
  }

  return {
    async escalate(request) {
      const waiting = waitingThread(request.alertFingerprint);
      if (waiting) return waiting;

      const pending = inFlight.get(request.alertFingerprint);
      if (pending) {
        const first = await pending;
        return { ...first, deduplicated: true };
      }

      const posting = post(request);
      inFlight.set(request.alertFingerprint, posting);
      try {
        return await posting;
      } finally {
        inFlight.delete(request.alertFingerprint);
      }
    },
  };
}
