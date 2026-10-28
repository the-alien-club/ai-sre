// The escalate tool: one top-level thread per unacknowledged alert.
//
// The agent can call `escalate` twice for one fingerprint: the second Alertmanager's copy of
// an alert that slipped past the channel's dedupe (a restart in between), or a re-notification
// it decided to escalate again. Posting a second top-level message and overwriting the record
// would orphan the first thread: operators reply there, and the reply would no longer stop the
// nag loop, which now follows the second thread. So while an escalation for the fingerprint is
// still waiting (in the map, not acknowledged), escalate answers with that thread instead and
// leaves its record untouched. An acknowledged one can be escalated afresh.

import type { Escalation } from "./escalation-store.js";

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
  /** Posts a top-level message. Rejects when Slack refused it. */
  postMessage: (message: { channel: string; text: string }) => Promise<{ ts?: string }>;
  /** Marks a thread as the agent's, so replies in it reach the session. */
  rememberThread: (ts: string) => void;
  now?: () => number;
}

export interface Escalator {
  /** Rejects when Slack could not be posted to; the tool handler turns that into an error result. */
  escalate(request: EscalateRequest): Promise<EscalateOutcome>;
}

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
    `_Reply in this thread to talk to the SRE agent._`
  );
}

export function createEscalator(deps: EscalatorDeps): Escalator {
  const { channel, operatorMentions, escalations, persist, postMessage, rememberThread, now = Date.now } = deps;
  // fingerprint → the post in flight, so two concurrent calls cannot both post
  const inFlight = new Map<string, Promise<EscalateOutcome>>();

  function waitingThread(fingerprint: string): EscalateOutcome | undefined {
    const existing = escalations.get(fingerprint);
    if (!existing || existing.acknowledged) return undefined;
    // A record without a thread (restored from an older file) has nothing to point at
    if (existing.slackChannel === undefined || existing.slackThreadTs === undefined) return undefined;
    return { channel: existing.slackChannel, ts: existing.slackThreadTs, deduplicated: true };
  }

  async function post(request: EscalateRequest): Promise<EscalateOutcome> {
    const result = await postMessage({ channel, text: escalationText(request, operatorMentions) });
    if (!result.ts) throw new Error("Slack accepted the escalation but returned no message ts");

    rememberThread(result.ts);
    const at = now();
    escalations.set(request.alertFingerprint, {
      alertFingerprint: request.alertFingerprint,
      alertName: request.alertName,
      severity: request.severity,
      environment: request.environment,
      slackThreadTs: result.ts,
      slackChannel: channel,
      escalatedAt: at,
      lastNagAt: at,
      acknowledged: false,
      acknowledgedBy: undefined,
      nagCount: 0,
    });
    persist();
    return { channel, ts: result.ts, deduplicated: false };
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
