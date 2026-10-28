// Bounded, single-attempt Slack posting for the slack-sre channel.
//
// Bolt's default WebClient has no request timeout and retries a failed call for about 30
// minutes. Every post of this channel (escalate, reply, resolve, the nag loop, permission
// relays) awaited it bare: a hung Slack call wedged the tool call that made it
// (CLAUDE_ERROR_PATTERNS.md §14), and a retry the client made after the caller had given up
// could post the same message twice. So posts go through a client built with a timeout and no
// retries, wrapped in withTimeout, and this process decides whether to try again.
//
// A failed post is one of two kinds, and the caller must be able to tell them apart:
// - SlackPostRejected: Slack answered and refused (an API error, a rate limit). Nothing was
//   posted; trying again is safe.
// - anything else (a timeout, a dropped connection, a 5xx): the message may or may not be
//   visible. Trying again blindly can post it twice.

import { ErrorCode, WebClient } from "@slack/web-api";
import { withTimeout } from "./with-timeout.js";

/** The slice of @slack/web-api's WebClient this module needs. Narrow, so tests can stub it. */
export interface ChatClient {
  chat: {
    postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
  conversations: {
    history(args: { channel: string; oldest: string; limit: number }): Promise<{
      ok?: boolean;
      error?: string;
      messages?: Array<{ ts?: string; text?: string; user?: string }>;
    }>;
  };
}

/** Slack answered and refused the post: nothing was posted. */
export class SlackPostRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackPostRejected";
  }
}

export interface SlackMessage {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackPoster {
  /**
   * Posts once and returns the message ts.
   * @throws SlackPostRejected when Slack refused it (nothing was posted).
   * @throws any other error when the outcome is unknown (it may be visible).
   */
  post(message: SlackMessage): Promise<string>;
  /**
   * The ts of the newest message posted by `author` in `channel` since `oldestMs` whose text
   * contains `needle`, or undefined when there is none.
   * @throws when the history cannot be read.
   */
  findRecent(channel: string, author: string, needle: string, oldestMs: number): Promise<string | undefined>;
}

/**
 * The client posts go through: a request timeout, no retries, and a rate limit is an error
 * rather than a wait. `slackApiUrl` is for tests only.
 */
export function createSlackPostClient(token: string, timeoutMs: number, slackApiUrl?: string): WebClient {
  return new WebClient(token, {
    timeout: timeoutMs,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    ...(slackApiUrl === undefined ? {} : { slackApiUrl }),
  });
}

/** How far back findRecent looks, at most. */
const HISTORY_LIMIT = 100;

function isRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return err.code === ErrorCode.PlatformError || err.code === ErrorCode.RateLimitedError;
}

export function createSlackPoster(client: ChatClient, timeoutMs: number): SlackPoster {
  return {
    async post(message) {
      let result: Awaited<ReturnType<ChatClient["chat"]["postMessage"]>>;
      try {
        result = await withTimeout(client.chat.postMessage(message), timeoutMs, "slack chat.postMessage");
      } catch (err) {
        if (isRejection(err)) throw new SlackPostRejected(`slack chat.postMessage refused: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (!result.ok) throw new SlackPostRejected(`slack chat.postMessage refused: ${result.error ?? "ok=false"}`);
      if (!result.ts) throw new Error("slack chat.postMessage returned no ts; the message may be visible");
      return result.ts;
    },

    async findRecent(channel, author, needle, oldestMs) {
      const oldest = (Math.max(0, oldestMs) / 1000).toFixed(6);
      const result = await withTimeout(
        client.conversations.history({ channel, oldest, limit: HISTORY_LIMIT }),
        timeoutMs,
        "slack conversations.history"
      );
      if (!result.ok) throw new Error(`slack conversations.history failed: ${result.error ?? "ok=false"}`);
      // Newest first, as Slack returns them
      return result.messages?.find((m) => m.user === author && m.ts !== undefined && m.text?.includes(needle) === true)?.ts;
    },
  };
}
