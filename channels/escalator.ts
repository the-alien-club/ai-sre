// The escalate tool: one top-level thread per unacknowledged alert, and a page whenever the
// operators need one.
//
// The agent can call `escalate` twice for one fingerprint: the second Alertmanager's copy of
// an alert that slipped past the channel's dedupe (a restart in between), or a re-notification
// it decided to escalate again. Posting a second top-level message every time would bury the
// channel, so while an escalation for the fingerprint is still waiting (in the map, not
// acknowledged, not superseded), escalate joins that thread instead. An acknowledged one can be
// escalated afresh.
//
// Joining is not always right. On 2026-10-30 prod Postgres went read-only for 1 h 40 and
// nobody was paged: "Postgres Disk Above 85%" joined a 27-hour-old thread opened as a warning,
// so without a mention, and nagged 20 times in-thread unanswered. So a waiting thread is
// re-paged, with a NEW top-level message, when:
// - the request is more severe than the thread (a warning thread, now critical), or
// - the thread is older than the staleness window for the request's severity.
// The new message links the earlier thread and replaces its record: the nag loop follows the
// new thread, the old one stops nagging, and a reply in either thread acknowledges
// (earlierThreadTs).
//
// A prod critical that does join a fresh waiting thread still pages: its message goes into the
// thread with the operators mentioned and broadcast to the channel, so it is seen.
//
// A post that timed out may still have landed (slack-poster.ts). If the agent then escalates
// the same fingerprint again, posting blindly could put two threads in the channel. So the
// escalation text carries its fingerprint, and the next escalate after an uncertain post
// first looks for it in the channel's recent history: found, it adopts that thread; not
// found, it posts; history unreadable, it refuses rather than guess. Broadcast pages never
// carry the fingerprint line, so that lookup cannot mistake one for an escalation.

import { z } from "zod";
import { compareSeverity, SEVERITIES, type Escalation, type Severity } from "./escalation-store.js";
import { describePostFailure, SlackPostRejected, type SlackPoster } from "./slack-poster.js";
import { escapeSlackText } from "./slack-text.js";

export const ENVIRONMENTS = ["dev", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export interface EscalateRequest {
  alertFingerprint: string;
  alertName: string;
  severity: Severity;
  environment: Environment;
  message: string;
  /**
   * The alert's own label severity, when the agent raised it: a prod warning that is
   * user-facing impact ("disk at 98%, cause of the read-only outage") is escalated as critical.
   */
  raisedFrom: { severity: Severity; reason: string } | undefined;
}

/** What joining a waiting thread did about paging. */
export type ThreadPage =
  | { status: "not_needed" }
  | { status: "sent" }
  | { status: "failed"; reason: string };

export type EscalateOutcome =
  /** A new top-level message, which pages on critical. */
  | {
      kind: "posted";
      channel: string;
      ts: string;
      /** The waiting or retired thread this one replaced, and why. */
      superseded: { ts: string; reason: string } | undefined;
      /** True when an earlier attempt whose outcome was unknown turned out to have landed. */
      recovered: boolean;
    }
  /** No new top-level message: the alert already has a fresh waiting thread. */
  | { kind: "deduplicated"; channel: string; ts: string; page: ThreadPage };

/** How old a waiting thread may be before an escalation of that severity re-pages. */
export interface StalenessWindows {
  /** For a critical request. 2 h in prod: one quiet thread must not hide a new outage. */
  criticalMs: number;
  /** For a warning or info request. */
  otherMs: number;
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
  /** A permalink to a top-level message, for the re-page to link the thread it replaces. */
  threadLink: (channel: string, ts: string) => string;
  staleAfter: StalenessWindows;
  now?: () => number;
}

export interface Escalator {
  /**
   * Rejects when Slack could not be posted to, or when an earlier post's outcome is unknown
   * and cannot be checked; the tool handler turns that into an error result. A failed page
   * into a waiting thread does not reject: the thread stands, and the outcome says so.
   */
  escalate(request: EscalateRequest): Promise<EscalateOutcome>;
}

/** The line that identifies an escalation's thread in the channel history. */
export function fingerprintMarker(alertFingerprint: string): string {
  return `Alert fingerprint: \`${escapeSlackText(alertFingerprint)}\``;
}

/** How long before an uncertain post the history lookup starts, for clock skew with Slack. */
const LOOKUP_SKEW_MS = 60 * 1000;

// Unknown keys are dropped, not refused: an escalation must not fail over an extra argument.
const ARGS = z.object({
  alert_fingerprint: z.string().trim().min(1),
  alert_name: z.string().trim().min(1),
  severity: z.enum(SEVERITIES),
  environment: z.enum(ENVIRONMENTS),
  message: z.string().trim().min(1),
  raised_from: z.enum(SEVERITIES).optional(),
  raise_reason: z.string().trim().min(1).optional(),
});

/**
 * The escalate tool's arguments as a request, or why they are refused, worded for the agent.
 * A raised severity must say what it was raised from and why, and must actually be higher.
 */
export function parseEscalateArgs(args: unknown): { request: EscalateRequest } | { error: string } {
  const parsed = ARGS.safeParse(args);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
    return { error: `escalate refused, nothing was posted: ${problems}` };
  }
  const { alert_fingerprint, alert_name, severity, environment, message, raised_from, raise_reason } = parsed.data;

  if ((raised_from === undefined) !== (raise_reason === undefined)) {
    return {
      error:
        "escalate refused, nothing was posted: raised_from and raise_reason go together. Pass both when you escalate " +
        "above the alert's label severity (raise_reason says what the impact is), or neither.",
    };
  }
  if (raised_from !== undefined && compareSeverity(severity, raised_from) <= 0) {
    return {
      error: `escalate refused, nothing was posted: severity ${severity} is not above raised_from ${raised_from}. Omit both raise fields when you keep the alert's severity.`,
    };
  }

  return {
    request: {
      alertFingerprint: alert_fingerprint,
      alertName: alert_name,
      severity,
      environment,
      message,
      raisedFrom: raised_from === undefined || raise_reason === undefined ? undefined : { severity: raised_from, reason: raise_reason },
    },
  };
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / (60 * 1000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function severityEmoji(severity: Severity): string {
  return severity === "critical" ? ":rotating_light:" : severity === "warning" ? ":warning:" : ":information_source:";
}

type ThreadedEscalation = Escalation & { slackChannel: string; slackThreadTs: string };

interface Replacing {
  record: ThreadedEscalation;
  reason: string;
}

function escalationText(request: EscalateRequest, operatorMentions: string, repage: { reason: string; link: string } | undefined): string {
  const { alertName, severity, environment, message, raisedFrom } = request;
  // Only critical alerts page the whole team — warnings and info post quietly.
  const page = severity === "critical" ? `${operatorMentions}\n` : "";
  const raised = raisedFrom ? `*Severity raised from ${raisedFrom.severity}:* ${raisedFrom.reason}\n` : "";
  const repaged = repage
    ? `*Re-paged:* ${repage.reason}. Earlier thread: <${repage.link}|here>; a reply in either thread acknowledges.\n`
    : "";

  return (
    `${severityEmoji(severity)} *SRE Alert Escalation* [${environment.toUpperCase()}]\n` +
    page +
    `\n*Alert:* ${alertName}\n` +
    `*Severity:* ${severity}\n` +
    raised +
    `*Environment:* ${environment}\n` +
    repaged +
    `\n${message}\n\n` +
    `_Reply in this thread to talk to the SRE agent._\n` +
    `_${fingerprintMarker(request.alertFingerprint)}_`
  );
}

/** The page a prod critical posts into the waiting thread it joins. No fingerprint line. */
function threadPageText(request: EscalateRequest, operatorMentions: string): string {
  const raised = request.raisedFrom ? `\n*Severity raised from ${request.raisedFrom.severity}:* ${request.raisedFrom.reason}` : "";
  return (
    `${operatorMentions} :rotating_light: *Still critical* [${request.environment.toUpperCase()}] — *${request.alertName}*${raised}\n\n` +
    `${request.message}\n\n` +
    `_Reply in this thread to acknowledge._`
  );
}

/** Whether escalations of this request page the operators even inside an existing thread. */
function pagesInThread(request: EscalateRequest): boolean {
  return request.severity === "critical" && request.environment === "prod";
}

function hasThread(record: Escalation): record is ThreadedEscalation {
  return record.slackChannel !== undefined && record.slackThreadTs !== undefined;
}

export function createEscalator(deps: EscalatorDeps): Escalator {
  const { channel, operatorMentions, escalations, persist, poster, botUserId, rememberThread, threadLink, staleAfter, now = Date.now } = deps;
  // fingerprint → the escalation in flight, so two concurrent calls cannot both post
  const inFlight = new Map<string, Promise<EscalateOutcome>>();
  // fingerprint → when a post whose outcome is unknown was attempted
  const uncertain = new Map<string, number>();

  /** Why a waiting thread must be re-paged for this request, or undefined to join it. */
  function repageReason(waiting: Escalation, request: EscalateRequest, at: number): string | undefined {
    if (compareSeverity(request.severity, waiting.severity) > 0) {
      return `severity raised from ${waiting.severity} to ${request.severity}`;
    }
    const age = at - waiting.escalatedAt;
    const window = request.severity === "critical" ? staleAfter.criticalMs : staleAfter.otherMs;
    if (age > window) return `the earlier thread has waited ${formatAge(age)} unacknowledged`;
    return undefined;
  }

  /**
   * The record a new top-level post replaces, when it should link it and inherit its thread
   * for acknowledgement: one still waiting, or one retired unanswered. An acknowledged one
   * is history, not a page to carry on.
   */
  function replaceable(fingerprint: string): ThreadedEscalation | undefined {
    const existing = escalations.get(fingerprint);
    if (!existing || existing.acknowledged || !hasThread(existing) || existing.slackChannel !== channel) return undefined;
    return existing;
  }

  function record(request: EscalateRequest, ts: string, at: number, replacing: ThreadedEscalation | undefined): void {
    rememberThread(ts);
    const earlier = replacing === undefined ? [] : [...replacing.earlierThreadTs, replacing.slackThreadTs];
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
      superseded: false,
      earlierThreadTs: earlier,
      lastRequestedAt: now(),
    });
    persist();
  }

  async function postNew(request: EscalateRequest, replacing: Replacing | undefined): Promise<EscalateOutcome> {
    const startedAt = now();
    const repage = replacing && { reason: replacing.reason, link: threadLink(channel, replacing.record.slackThreadTs) };
    let ts: string;
    try {
      ts = await poster.post({ channel, text: escalationText(request, operatorMentions, repage) });
    } catch (err) {
      if (!(err instanceof SlackPostRejected)) uncertain.set(request.alertFingerprint, startedAt);
      throw err;
    }
    record(request, ts, startedAt, replacing?.record);
    const superseded = replacing && { ts: replacing.record.slackThreadTs, reason: replacing.reason };
    return { kind: "posted", channel, ts, superseded, recovered: false };
  }

  async function join(waiting: ThreadedEscalation, request: EscalateRequest): Promise<EscalateOutcome> {
    waiting.lastRequestedAt = now();
    persist();
    const joined = { kind: "deduplicated" as const, channel: waiting.slackChannel, ts: waiting.slackThreadTs };
    if (!pagesInThread(request)) return { ...joined, page: { status: "not_needed" } };

    try {
      await poster.post({
        channel: waiting.slackChannel,
        thread_ts: waiting.slackThreadTs,
        text: threadPageText(request, operatorMentions),
        reply_broadcast: true,
      });
      return { ...joined, page: { status: "sent" } };
    } catch (err) {
      return { ...joined, page: { status: "failed", reason: describePostFailure(err) } };
    }
  }

  async function settle(request: EscalateRequest): Promise<EscalateOutcome> {
    const fingerprint = request.alertFingerprint;
    const previous = replaceable(fingerprint);

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
      // The thread it would replace carries the same marker and can be young enough to match:
      // finding that one means the uncertain post did not land.
      if (found !== undefined && found !== previous?.slackThreadTs) {
        record(request, found, attemptedAt, previous);
        const superseded = previous && { ts: previous.slackThreadTs, reason: "replaced by the earlier attempt that landed" };
        return { kind: "posted", channel, ts: found, superseded, recovered: true };
      }
    }

    if (previous === undefined) return postNew(request, undefined);
    if (previous.superseded) return postNew(request, { record: previous, reason: "the earlier thread was retired unanswered" });

    const reason = repageReason(previous, request, now());
    if (reason === undefined) return join(previous, request);
    return postNew(request, { record: previous, reason });
  }

  return {
    async escalate(request) {
      const pending = inFlight.get(request.alertFingerprint);
      if (pending) {
        // The call in flight posts, or pages, for both
        const first = await pending;
        return { kind: "deduplicated", channel: first.channel, ts: first.ts, page: { status: "not_needed" } };
      }

      const settling = settle(request);
      inFlight.set(request.alertFingerprint, settling);
      try {
        return await settling;
      } finally {
        inFlight.delete(request.alertFingerprint);
      }
    },
  };
}
