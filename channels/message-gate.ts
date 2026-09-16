// Channel message gating — decides whether an inbound Slack message is addressed
// to the SRE agent and should be forwarded into its Claude session.
//
// This is the rule that keeps the agent alive. The team channel carries ordinary
// human conversation; every message forwarded into the session consumes context,
// and a long-running agent that fills its context window dies and must restart.
// So a channel message reaches the agent only when it is genuinely addressed to it.
//
// Kept pure and dependency-free so it can be reasoned about and tested in isolation.

export interface InboundMessage {
  /** True for direct messages — those are always addressed to the agent. */
  isDirectMessage: boolean;
  /** Raw message text, including any Slack mention tokens. */
  text: string;
  /** The bot's own Slack user ID, resolved at startup via auth.test. */
  botUserId: string;
  /** Parent thread timestamp, if this message is a threaded reply. */
  parentThreadTs: string | undefined;
  /** Whether the given thread is one the agent itself started. */
  isAgentThread: (threadTs: string) => boolean;
}

/**
 * A message is addressed to the agent when it is a DM, when it @-mentions the bot,
 * or when it is a reply inside a thread the agent started (so escalation
 * conversations flow without re-mentioning the bot on every turn).
 */
export function isAddressedToAgent(message: InboundMessage): boolean {
  if (message.isDirectMessage) return true;

  if (mentionsBot(message.text, message.botUserId)) return true;

  if (
    message.parentThreadTs !== undefined &&
    message.isAgentThread(message.parentThreadTs)
  ) {
    return true;
  }

  return false;
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
