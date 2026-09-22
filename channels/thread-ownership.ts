// Thread ownership — "has the agent posted in this thread?"
//
// A reply in one of the agent's threads reaches it without an @-mention, so escalation
// conversations flow naturally. Answering that question from an in-process Set is what
// broke: the VM restarts the agent nightly (`0 3 * * * pm2 restart sre-agent`), and every
// thread opened before the restart became silently unreachable. Operators replied into
// threads the agent could no longer recognise and got nothing back, with no log line to
// show for it.
//
// Slack already knows who posted in a thread. Asking it is ground truth: it survives a
// restart, a redeploy, and a wiped data directory, and there is no second copy of the
// answer to drift out of date. The in-memory maps below are a cache in front of that
// truth, not the truth itself.
//
// Ownership means "the agent has posted at least once in this thread" — not "the agent
// wrote the parent message". An operator can @-mention the bot top-level, get an in-thread
// answer, and then keep replying in a thread whose parent is theirs.

/** The slice of the Slack web client this module needs. Narrow, so tests can stub it. */
export interface ThreadReplyReader {
  conversations: {
    replies(args: {
      channel: string;
      ts: string;
      limit?: number;
    }): Promise<{ messages?: Array<{ user?: string }> }>;
  };
}

export interface ThreadOwnershipOptions {
  client: ThreadReplyReader;
  /**
   * The bot's own Slack user ID. Read lazily rather than captured, because it is only
   * known once startup validation has called auth.test — after this object is built.
   */
  botUserId: () => string;
  /** How long a cached answer stays trustworthy. */
  ttlMs?: number;
  /** Cap on each cache, so a process running for weeks cannot leak. */
  maxEntries?: number;
  /** Injectable clock, so TTL behaviour is testable without waiting. */
  now?: () => number;
}

export interface ThreadOwnership {
  /** Record that the agent has posted in this thread. */
  remember(threadTs: string | undefined): void;
  /** Whether the agent has posted in this thread. Consults Slack on a cache miss. */
  owns(channel: string, threadTs: string): Promise<boolean>;
  /** Drop expired cache entries. Call periodically. */
  prune(): void;
  /** Cache sizes, for tests and diagnostics. */
  stats(): { owned: number; foreign: number };
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_ENTRIES = 500;
// One page covers every thread this agent has ever produced by a wide margin; the longest
// on record is ~20 replies. Paginating further would cost calls to answer a question the
// first page has already answered in practice.
const REPLY_PAGE_SIZE = 200;

export function createThreadOwnership(
  options: ThreadOwnershipOptions
): ThreadOwnership {
  const {
    client,
    botUserId,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    now = Date.now,
  } = options;

  // thread_ts -> time the answer was learned. Two maps rather than one boolean-valued map
  // so each side gets its own eviction budget: a burst of human chatter must not evict the
  // agent's own live escalation threads.
  const owned = new Map<string, number>();
  const foreign = new Map<string, number>();

  function record(cache: Map<string, number>, threadTs: string): void {
    // Re-insert rather than overwrite: Map.set on an existing key keeps its original
    // position, which would let a busy thread be evicted as the "oldest" one below.
    cache.delete(threadTs);
    cache.set(threadTs, now());

    // Map preserves insertion order — evict oldest entries when over the cap.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function isFresh(cache: Map<string, number>, threadTs: string): boolean {
    const learnedAt = cache.get(threadTs);
    if (learnedAt === undefined) return false;
    if (now() - learnedAt < ttlMs) return true;
    cache.delete(threadTs);
    return false;
  }

  async function agentPostedIn(
    channel: string,
    threadTs: string,
    selfId: string
  ): Promise<boolean> {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: REPLY_PAGE_SIZE,
    });
    // The parent message is the first element, so this covers both "the agent opened the
    // thread" and "the agent joined a thread someone else opened".
    return (result.messages ?? []).some((message) => message.user === selfId);
  }

  return {
    remember(threadTs) {
      if (!threadTs) return;
      foreign.delete(threadTs);
      record(owned, threadTs);
    },

    async owns(channel, threadTs) {
      if (isFresh(owned, threadTs)) return true;
      if (isFresh(foreign, threadTs)) return false;

      // An unresolved bot ID would make every thread look foreign; say so loudly rather
      // than quietly going deaf to the whole team.
      const selfId = botUserId();
      if (!selfId) {
        console.error(
          "[thread-ownership] bot user ID is unresolved — cannot determine thread ownership"
        );
        return false;
      }

      let agentPosted: boolean;
      try {
        agentPosted = await agentPostedIn(channel, threadTs, selfId);
      } catch (err) {
        // Cache nothing: a transient Slack failure must not pin this thread as foreign for
        // the next seven days. Dropping one message is recoverable; silently deafening the
        // agent to a live escalation thread is not.
        console.error(
          `[thread-ownership] lookup failed for thread ${threadTs} in ${channel} — treating as not addressed:`,
          err instanceof Error ? err.message : String(err)
        );
        return false;
      }

      record(agentPosted ? owned : foreign, threadTs);
      return agentPosted;
    },

    prune() {
      const cutoff = now() - ttlMs;
      for (const cache of [owned, foreign]) {
        for (const [threadTs, learnedAt] of cache) {
          if (learnedAt < cutoff) cache.delete(threadTs);
        }
      }
    },

    stats() {
      return { owned: owned.size, foreign: foreign.size };
    },
  };
}
