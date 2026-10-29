// How long an operator waits for the agent, per Slack thread.
//
// An operator's message arms two timers for its thread; an agent reply in that thread disarms
// both:
//
//   ack       after ackDelayMs (20 s): the channel posts ":eyes: On it" on the agent's behalf, so
//             the operator knows the message landed.
//   follow-up followUpMs after the ack (5 min): the channel posts that there is still no
//             answer, tells the agent with type="operator_waiting", and logs it.
//
// The follow-up exists because of 2026-10-29: Leo asked for a runbook proposal, got the "On
// it", and then nothing for 13 minutes while the agent ran foreground sub-agents on unrelated
// alerts and silently retried a refused tool call. The "On it" alone promised an answer that
// never came.
//
// No loop, no spam: a thread gets at most one "On it" and one follow-up per unanswered
// stretch. Further operator messages in a thread that is already waiting post nothing new;
// only an agent reply in the thread ends the stretch. Nothing here is persisted: a restart
// ends the Claude session too, and with it every question it was answering.
//
// Every post and notification is the caller's, bounded there. Their failures are logged here,
// never thrown: a timer callback has nobody to throw to.

export interface WaitingThread {
  channel: string;
  threadTs: string;
  /** Who wrote the first unanswered message of this stretch. */
  senderName: string;
  /** When that message arrived (ms). */
  since: number;
}

export interface OperatorWaitOptions {
  /** Delay before the "On it"; 0 or less skips it and arms the follow-up at once. */
  ackDelayMs: number;
  /** Delay from the "On it" (or from the message, without one) to the follow-up. Positive. */
  followUpMs: number;
  postAck(thread: WaitingThread): Promise<void>;
  postFollowUp(thread: WaitingThread, waitedMs: number): Promise<void>;
  /** Tells the Claude session that an operator is still waiting. */
  signalAgent(thread: WaitingThread, waitedMs: number): Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel function. Defaults to an unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

export interface OperatorWait {
  /** An operator's message was handed to the agent in this thread. */
  messageReceived(channel: string, threadTs: string, senderName: string): void;
  /** The agent (or code acting for it, like a runbook proposal post) answered in this thread. */
  answered(threadTs: string): void;
  /** True while an operator's message in this thread has no answer. */
  isWaiting(threadTs: string): boolean;
  /** Forgets threads whose follow-up went out more than `olderThanMs` ago. */
  prune(olderThanMs: number): void;
}

type Phase = "ack-pending" | "acked" | "followed-up";

interface State {
  thread: WaitingThread;
  phase: Phase;
  followedUpAt?: number;
  cancel?: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // A pending reminder must never be what keeps the process alive.
  timer.unref();
  return () => clearTimeout(timer);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createOperatorWait(options: OperatorWaitOptions): OperatorWait {
  const { ackDelayMs, followUpMs, now = Date.now, log = (line) => console.error(line), schedule = defaultSchedule } = options;
  if (!Number.isInteger(followUpMs) || followUpMs <= 0) {
    throw new RangeError(`followUpMs must be a positive integer of ms, got ${followUpMs}`);
  }
  const threads = new Map<string, State>();

  function armFollowUp(state: State): void {
    state.phase = "acked";
    state.cancel = schedule(() => followUp(state), followUpMs);
  }

  function followUp(state: State): void {
    // Answered (and possibly re-asked) since this timer was armed: not ours any more.
    if (threads.get(state.thread.threadTs) !== state) return;
    state.phase = "followed-up";
    state.cancel = undefined;
    state.followedUpAt = now();
    const waited = state.followedUpAt - state.thread.since;
    const { threadTs, senderName } = state.thread;
    log(`[operator-wait] ${senderName} has had no answer in thread ${threadTs} for ${Math.round(waited / 1000)} s; posting the follow-up and telling the agent`);
    void options.postFollowUp(state.thread, waited).catch((err: unknown) => {
      log(`[operator-wait] could not post the follow-up in thread ${threadTs}: ${errorMessage(err)}`);
    });
    void options.signalAgent(state.thread, waited).catch((err: unknown) => {
      log(`[operator-wait] could not tell the agent that ${senderName} is waiting in thread ${threadTs}: ${errorMessage(err)}`);
    });
  }

  function ack(state: State): void {
    if (threads.get(state.thread.threadTs) !== state) return;
    armFollowUp(state);
    void options.postAck(state.thread).catch((err: unknown) => {
      log(`[operator-wait] could not post the receipt acknowledgement in thread ${state.thread.threadTs}: ${errorMessage(err)}`);
    });
  }

  return {
    messageReceived(channel, threadTs, senderName) {
      const existing = threads.get(threadTs);
      if (existing !== undefined && existing.phase !== "ack-pending") {
        // Already acknowledged and still unanswered: the follow-up (pending or sent) covers it.
        return;
      }
      if (existing !== undefined) {
        // Another message before the "On it" went out: restart its delay, keep the stretch.
        existing.cancel?.();
        existing.cancel = schedule(() => ack(existing), ackDelayMs);
        return;
      }
      const state: State = { thread: { channel, threadTs, senderName, since: now() }, phase: "ack-pending" };
      threads.set(threadTs, state);
      if (ackDelayMs > 0) state.cancel = schedule(() => ack(state), ackDelayMs);
      else armFollowUp(state);
    },

    answered(threadTs) {
      const state = threads.get(threadTs);
      if (state === undefined) return;
      state.cancel?.();
      threads.delete(threadTs);
    },

    isWaiting(threadTs) {
      return threads.has(threadTs);
    },

    prune(olderThanMs) {
      const cutoff = now() - olderThanMs;
      for (const [threadTs, state] of threads) {
        if (state.phase === "followed-up" && state.followedUpAt !== undefined && state.followedUpAt < cutoff) threads.delete(threadTs);
      }
    },
  };
}
