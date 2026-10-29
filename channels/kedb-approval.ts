// What a Slack message means for the runbook proposals (plan §4, "Approval detection").
//
// Pure: given a message and the proposals, say whether it approves one, rejects one, needs an
// explanatory note, is feedback the agent should see as such, or has nothing to do with them.
// slack-sre.ts calls it after the permission-verdict check and before addressing; kedb-loop.ts
// acts on the answer. Only a fresh message counts: slack-sre already drops every edit.

import type { Proposal } from "./proposal-store.js";

/** "yes", "ok" or "approve", then "downgrade" when the change lowers severity, then the id. */
export const APPROVE_RE = /^\s*(yes|ok|approve)(\s+downgrade)?(\s+kb-(\d+))?\s*[.!]?\s*$/i;
/** "no", optionally the id, then the reason. */
export const REJECT_RE = /^\s*no(?:\s+kb-(\d+))?\b[\s.,:;!-]*(.*)$/is;

export interface InboundMessage {
  user: string;
  text: string;
  channel: string;
  ts: string;
  /** The thread the message is in; undefined for a top-level message. */
  threadTs: string | undefined;
}

export type ReplyMeaning =
  | { kind: "approve"; proposal: Proposal }
  | { kind: "reject"; proposal: Proposal; reason: string }
  /** Post `text` in the thread; nothing changes. */
  | { kind: "notice"; text: string }
  /** Forward to the agent as runbook_feedback; `notice`, when set, is posted in the thread too. */
  | { kind: "feedback"; proposal: Proposal; notice?: string }
  | { kind: "none" };

/** -1, 0 or 1. Slack ts strings are "<seconds>.<micros>"; a float would lose the micros. */
export function compareSlackTs(a: string, b: string): number {
  const big = (ts: string) => {
    const [s, us = "0"] = ts.split(".");
    return BigInt(s) * 1_000_000n + BigInt(us.padEnd(6, "0").slice(0, 6));
  };
  const x = big(a);
  const y = big(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * A message's permalink, in the form Slack's chat.getPermalink returns, from the workspace
 * URL auth.test gives (e.g. https://alien.slack.com/).
 */
export function slackPermalink(teamUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = teamUrl.endsWith("/") ? teamUrl : `${teamUrl}/`;
  const link = `${base}archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs === undefined || threadTs === ts ? link : `${link}?thread_ts=${threadTs}&cid=${channel}`;
}

export interface ClassifyOptions {
  /** Slack user id → display name of the people who may approve (SRE_KEDB_APPROVERS). */
  approvers: ReadonlyMap<string, string>;
  /** The newest revision of every proposal. */
  proposals: Proposal[];
}

function approverNames(approvers: ReadonlyMap<string, string>): string {
  return [...approvers.values()].join(" or ");
}

export function classifyReply(message: InboundMessage, options: ClassifyOptions): ReplyMeaning {
  const { approvers, proposals } = options;
  const yes = APPROVE_RE.exec(message.text);
  const no = yes ? null : REJECT_RE.exec(message.text);
  const namedNumber = yes?.[4] ?? no?.[1];
  const namedId = namedNumber === undefined ? undefined : `KB-${Number(namedNumber)}`;

  const inThread =
    message.threadTs === undefined
      ? []
      : proposals.filter((p) => p.status === "pending" && p.slack_channel === message.channel && p.thread_ts === message.threadTs);

  if (!yes && !no) {
    // Anything else in a thread with a pending proposal is feedback on it (plan §4).
    const target = inThread[inThread.length - 1];
    return target === undefined ? { kind: "none" } : { kind: "feedback", proposal: target };
  }
  if (namedId === undefined && inThread.length === 0) return { kind: "none" };

  let target: Proposal | undefined;
  if (namedId !== undefined) {
    target = proposals.find((p) => p.id === namedId);
    if (target === undefined) return { kind: "notice", text: `:grey_question: There is no runbook proposal ${namedId}.` };
  } else if (inThread.length === 1) {
    target = inThread[0];
  } else {
    return {
      kind: "notice",
      text: `:grey_question: ${inThread.length} runbook proposals are pending in this thread (${inThread.map((p) => p.id).join(", ")}). Name the one you mean, e.g. \`yes ${inThread[0].id}\`.`,
    };
  }

  if (!approvers.has(message.user)) {
    if (yes) {
      return { kind: "feedback", proposal: target, notice: `:lock: Only ${approverNames(approvers)} can approve runbook changes; I passed your reply on to the agent as feedback.` };
    }
    return { kind: "feedback", proposal: target };
  }

  if (target.status !== "pending") {
    return { kind: "notice", text: `:grey_question: ${target.id} rev ${target.rev} is ${target.status}; there is nothing to ${yes ? "approve" : "reject"}.` };
  }
  if (target.slack_channel !== message.channel) {
    return { kind: "notice", text: `:grey_question: Answer ${target.id} in its own thread, in the channel it was posted in.` };
  }

  if (no) return { kind: "reject", proposal: target, reason: no[2].trim() };

  if (target.post_ts === null || compareSlackTs(message.ts, target.post_ts) <= 0) {
    return { kind: "notice", text: `:grey_question: That reply predates ${target.id} rev ${target.rev}; answer the current revision.` };
  }
  const saidDowngrade = yes?.[2] !== undefined;
  if (target.downgrade !== null && (!saidDowngrade || namedId === undefined)) {
    return {
      kind: "notice",
      text: `:warning: ${target.id} is a severity downgrade. To accept it, reply exactly \`yes downgrade ${target.id}\`.`,
    };
  }
  if (target.downgrade === null && saidDowngrade) {
    return { kind: "notice", text: `:grey_question: ${target.id} is not a severity downgrade. To accept it, reply \`yes ${target.id}\`.` };
  }
  return { kind: "approve", proposal: target };
}
