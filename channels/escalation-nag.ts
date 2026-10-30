// Which escalations the nag loop pokes, and how.
//
// By 2026-10-30 the channel held 42 unanswered escalations, several nagged 17-26 times
// in-thread. An in-thread reply notifies nobody who is not following the thread, so those
// nags were noise only the agent's own context paid for, and they trained everyone to ignore
// the channel the morning prod Postgres went read-only. So:
// - a warning or info escalation is never nagged in its thread; it is listed in the daily
//   digest instead (escalation-digest.ts);
// - a critical one keeps nagging in its thread, and in prod every `broadcastEvery`-th nag is
//   also sent to the channel, so it shows up for people who are not in the thread;
// - a superseded or acknowledged one, and a Trivy finding, is never nagged.

import { isTrivyEscalation } from "./escalation-policy.js";
import type { Escalation } from "./escalation-store.js";

export interface NagSettings {
  /** Between nags of a critical prod escalation. */
  prodIntervalMs: number;
  /** Between nags of a critical dev or staging escalation. */
  nonProdIntervalMs: number;
  /** Between nags once the agent has been told `maxAgentNags` times. */
  slackOnlyIntervalMs: number;
  /** After this many nags the agent is no longer told; Slack nags go on at the slower cadence. */
  maxAgentNags: number;
  /** Every this-many-th nag of a critical prod escalation is broadcast to the channel. */
  broadcastEvery: number;
  /** The @-mentions that page every operator. */
  operatorMentions: string;
}

export interface Nag {
  /** The escalation's nag count once this nag is sent. */
  nagCount: number;
  minutesWaiting: number;
  /** The in-thread reminder. */
  text: string;
  /** Also show it in the channel. */
  broadcast: boolean;
  /** Tell the agent (type="escalation_timeout"). */
  notifyAgent: boolean;
  /** The last nag the agent is told about. */
  finalAgentNag: boolean;
}

/** Whether the nag loop follows this escalation at all, whatever its timers say. */
export function isNagged(escalation: Escalation): boolean {
  return (
    escalation.severity === "critical" &&
    !escalation.acknowledged &&
    !escalation.superseded &&
    !isTrivyEscalation(escalation.alertFingerprint)
  );
}

/** The nag due for `escalation` at `now`, or undefined when none is. Changes nothing. */
export function dueNag(escalation: Escalation, now: number, settings: NagSettings): Nag | undefined {
  if (!isNagged(escalation)) return undefined;

  // Once maxAgentNags is reached, only Slack-nag at a slower cadence: the agent's context
  // window is not spent on a team that is offline.
  const agentExhausted = escalation.nagCount >= settings.maxAgentNags;
  const prod = escalation.environment === "prod";
  const interval = agentExhausted ? settings.slackOnlyIntervalMs : prod ? settings.prodIntervalMs : settings.nonProdIntervalMs;
  if (now - escalation.lastNagAt < interval) return undefined;

  const nagCount = escalation.nagCount + 1;
  const minutesWaiting = Math.round((now - escalation.escalatedAt) / (60 * 1000));
  const urgency = prod
    ? `:rotating_light: *STILL WAITING* (${minutesWaiting} min) ${settings.operatorMentions}`
    : `:bell: Reminder (${minutesWaiting} min)`;
  const slackOnlyNote = agentExhausted ? " _(Slack-only nag — agent standing by silently)_" : "";

  return {
    nagCount,
    minutesWaiting,
    text: `${urgency} — alert *${escalation.alertName}* [${escalation.environment.toUpperCase()}] is still unacknowledged. Nag #${nagCount}.${slackOnlyNote}`,
    broadcast: prod && nagCount % settings.broadcastEvery === 0,
    notifyAgent: !agentExhausted,
    finalAgentNag: nagCount === settings.maxAgentNags,
  };
}
