// Channel message gating — decides whether an inbound Slack message is addressed
// to the SRE agent and should be forwarded into its Claude session.
//
// This is the rule that keeps the agent alive. The team channel carries ordinary
// human conversation; every message forwarded into the session consumes context,
// and a long-running agent that fills its context window dies and must restart.
// So a channel message reaches the agent only when it is genuinely addressed to it.
//
// This module classifies; it does not decide. Three of the four outcomes are settled
// from the message alone, but "a reply in one of the agent's threads" needs to know who
// has posted in that thread — a question only Slack can answer, and answering it costs a
// round-trip. Returning the classification lets the caller pay that cost on the one
// branch that needs it, and keeps this module pure, synchronous and testable.

export interface ClassifiableMessage {
  /** True for direct messages — those are always addressed to the agent. */
  isDirectMessage: boolean;
  /** Raw message text, including any Slack mention tokens. */
  text: string;
  /** The bot's own Slack user ID, resolved at startup via auth.test. */
  botUserId: string;
  /** Parent thread timestamp, if this message is a threaded reply. */
  parentThreadTs: string | undefined;
}

/** Why a message is (or might be) addressed to the agent. */
export type MessageAddressing =
  /** A DM. Always addressed. */
  | { kind: "direct_message" }
  /** Contains an @-mention of the bot. Always addressed. */
  | { kind: "mention" }
  /** A threaded reply — addressed only if the agent has posted in that thread. */
  | { kind: "thread_reply"; threadTs: string }
  /** Ordinary channel chatter. Never addressed. */
  | { kind: "unaddressed" };

/**
 * Classify how — if at all — a message reaches the agent.
 *
 * Order matters: a DM outranks everything, and an explicit @-mention outranks the thread
 * check so that mentioning the bot inside a stranger's thread still gets through without
 * a Slack lookup.
 */
export function classifyAddressing(
  message: ClassifiableMessage
): MessageAddressing {
  if (message.isDirectMessage) return { kind: "direct_message" };

  if (mentionsBot(message.text, message.botUserId)) return { kind: "mention" };

  if (message.parentThreadTs !== undefined) {
    return { kind: "thread_reply", threadTs: message.parentThreadTs };
  }

  return { kind: "unaddressed" };
}

/** Whether the text contains an @-mention of the bot. */
export function mentionsBot(text: string, botUserId: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

/**
 * Remove the bot's own mention tokens from a message. The agent already knows it
 * was addressed; carrying the raw `<@U0AU7UH148Y>` token into the session is noise.
 */
export function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replaceAll(`<@${botUserId}>`, " ").replace(/\s+/g, " ").trim();
}
