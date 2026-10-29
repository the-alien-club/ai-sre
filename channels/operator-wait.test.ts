// Tests for the per-thread operator wait: the "On it", the one follow-up, and what cancels
// them. Run with: npm test
//
// Time is a fake: scheduled callbacks run only when the test advances the clock past them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperatorWait, type OperatorWait, type WaitingThread } from "./operator-wait.js";

const CHANNEL = "C09MWNB6WL8";
const THREAD = "1793201688.848269";
const OTHER = "1793201999.000100";
const ACK_MS = 20_000;
const FOLLOW_UP_MS = 5 * 60_000;

interface Harness {
  wait: OperatorWait;
  acks: WaitingThread[];
  followUps: Array<{ thread: WaitingThread; waitedMs: number }>;
  signals: Array<{ thread: WaitingThread; waitedMs: number }>;
  logs: string[];
  advance(ms: number): Promise<void>;
  pending(): number;
}

function harness(overrides: { ackDelayMs?: number; failPosts?: boolean } = {}): Harness {
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const acks: WaitingThread[] = [];
  const followUps: Harness["followUps"] = [];
  const signals: Harness["signals"] = [];
  const logs: string[] = [];
  const fail = overrides.failPosts === true;

  const wait = createOperatorWait({
    ackDelayMs: overrides.ackDelayMs ?? ACK_MS,
    followUpMs: FOLLOW_UP_MS,
    postAck: async (thread) => {
      acks.push({ ...thread });
      if (fail) throw new Error("slack is down");
    },
    postFollowUp: async (thread, waitedMs) => {
      followUps.push({ thread: { ...thread }, waitedMs });
      if (fail) throw new Error("slack is down");
    },
    signalAgent: async (thread, waitedMs) => {
      signals.push({ thread: { ...thread }, waitedMs });
    },
    log: (line) => logs.push(line),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { at: clock + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  return {
    wait,
    acks,
    followUps,
    signals,
    logs,
    async advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        clock = due.at;
        due.fn();
        // Let the posts' promise callbacks run
        await new Promise((resolve) => setImmediate(resolve));
      }
      clock = target;
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  };
}

test("no answer: one On it, then exactly one follow-up and one agent signal, never repeated", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS);
  assert.equal(h.acks.length, 1);
  assert.equal(h.followUps.length, 0);

  await h.advance(FOLLOW_UP_MS);
  assert.equal(h.followUps.length, 1);
  assert.equal(h.signals.length, 1);
  assert.equal(h.followUps[0].waitedMs, ACK_MS + FOLLOW_UP_MS);
  assert.deepEqual(h.followUps[0].thread, { channel: CHANNEL, threadTs: THREAD, senderName: "Leo", since: 0 });
  assert.match(h.logs.join("\n"), /Leo has had no answer in thread 1793201688\.848269 for 320 s/);

  // Hours pass, and Leo writes twice more in the same thread: nothing new is posted
  await h.advance(6 * 60 * 60_000);
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  h.wait.messageReceived(CHANNEL, THREAD, "Adrien");
  await h.advance(60 * 60_000);
  assert.equal(h.acks.length, 1, "one On it per unanswered stretch");
  assert.equal(h.followUps.length, 1, "one follow-up per unanswered stretch");
  assert.equal(h.signals.length, 1);
  assert.equal(h.pending(), 0, "no timer left armed");
  assert.equal(h.wait.isWaiting(THREAD), true);
});

test("an agent reply before the On it cancels both", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS - 1);
  h.wait.answered(THREAD);
  await h.advance(60 * 60_000);
  assert.equal(h.acks.length, 0);
  assert.equal(h.followUps.length, 0);
  assert.equal(h.signals.length, 0);
  assert.equal(h.wait.isWaiting(THREAD), false);
});

test("an agent reply after the On it cancels the follow-up", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS + FOLLOW_UP_MS - 1);
  assert.equal(h.acks.length, 1);
  h.wait.answered(THREAD);
  await h.advance(60 * 60_000);
  assert.equal(h.followUps.length, 0);
  assert.equal(h.signals.length, 0);
  assert.equal(h.pending(), 0);
});

test("after an answer, a new question in the thread starts a new stretch", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS + FOLLOW_UP_MS);
  h.wait.answered(THREAD);
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS + FOLLOW_UP_MS);
  assert.equal(h.acks.length, 2);
  assert.equal(h.followUps.length, 2);
});

test("a second message before the On it restarts its delay, without a second On it", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS - 1_000);
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS - 1);
  assert.equal(h.acks.length, 0);
  await h.advance(1);
  assert.equal(h.acks.length, 1);
  await h.advance(FOLLOW_UP_MS);
  assert.equal(h.followUps.length, 1);
  assert.equal(h.followUps[0].waitedMs, 2 * ACK_MS - 1_000 + FOLLOW_UP_MS, "measured from the first unanswered message");
});

test("threads are independent: an answer in one does not cancel another", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  h.wait.messageReceived(CHANNEL, OTHER, "Adrien");
  h.wait.answered(OTHER);
  await h.advance(ACK_MS + FOLLOW_UP_MS);
  assert.deepEqual(h.followUps.map((f) => f.thread.threadTs), [THREAD]);
});

test("without the On it (ACK_DELAY_MS=0), the follow-up still fires once", async () => {
  const h = harness({ ackDelayMs: 0 });
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(FOLLOW_UP_MS);
  assert.equal(h.acks.length, 0);
  assert.equal(h.followUps.length, 1);
  assert.equal(h.signals.length, 1);
});

test("a failed post is logged, not thrown, and the agent is still told", async () => {
  const h = harness({ failPosts: true });
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS + FOLLOW_UP_MS);
  assert.equal(h.signals.length, 1);
  assert.match(h.logs.join("\n"), /could not post the receipt acknowledgement in thread .*: slack is down/);
  assert.match(h.logs.join("\n"), /could not post the follow-up in thread .*: slack is down/);
});

test("prune forgets followed-up threads only after the given age", async () => {
  const h = harness();
  h.wait.messageReceived(CHANNEL, THREAD, "Leo");
  await h.advance(ACK_MS + FOLLOW_UP_MS);
  h.wait.prune(60_000);
  assert.equal(h.wait.isWaiting(THREAD), true);
  await h.advance(60_001);
  h.wait.prune(60_000);
  assert.equal(h.wait.isWaiting(THREAD), false);
});

test("a follow-up delay that is not a positive integer is refused", () => {
  for (const followUpMs of [0, -1, Number.NaN, 1.5]) {
    assert.throws(
      () =>
        createOperatorWait({
          ackDelayMs: ACK_MS,
          followUpMs,
          postAck: async () => {},
          postFollowUp: async () => {},
          signalAgent: async () => {},
        }),
      RangeError
    );
  }
});
