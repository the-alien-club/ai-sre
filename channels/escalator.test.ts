// Tests for the escalate tool's one-thread-per-alert rule. Run with: npm test
//
// A second escalate for a fingerprint that is still waiting used to post a new top-level
// message and overwrite the record, orphaning the first thread: replies there no longer
// stopped the nag loop. It must answer with the first thread and leave the record alone.
//
// A post that timed out may have landed anyway. The error goes back to the agent as a tool
// result, and a later escalate must find the landed message rather than post a second one.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Escalation } from "./escalation-store.js";
import { createEscalator, fingerprintMarker, type EscalateRequest } from "./escalator.js";
import { SlackPostRejected, type SlackMessage, type SlackPoster } from "./slack-poster.js";
import { OperationTimeoutError } from "./with-timeout.js";

const CHANNEL = "C0TEAM";
const BOT = "U0BOT";

function request(overrides: Partial<EscalateRequest> = {}): EscalateRequest {
  return {
    alertFingerprint: "a1b2c3d4e5f60718",
    alertName: "High Error Rate",
    severity: "critical",
    environment: "prod",
    message: "5xx above 5% on backend-prod since 08:40.",
    ...overrides,
  };
}

/** What one post does: land and answer, land but time out, or be refused. */
type PostBehaviour = "ok" | "timeout_but_landed" | "timeout_lost" | "rejected";

function harness(options: { postDelay?: Promise<void>; behaviours?: PostBehaviour[]; historyFails?: boolean } = {}) {
  let clock = Date.parse("2026-10-28T09:00:00Z");
  let ts = 1_730_000_000;
  const behaviours = [...(options.behaviours ?? [])];
  const posts: SlackMessage[] = [];
  // What is visible in the channel, newest first, as conversations.history returns it
  const channel: Array<{ ts: string; text: string; user: string }> = [];
  const lookups: Array<{ needle: string; oldestMs: number }> = [];
  const remembered: string[] = [];
  const escalations = new Map<string, Escalation>();
  let persisted = 0;
  const poster: SlackPoster = {
    async post(message) {
      posts.push(message);
      await options.postDelay;
      const behaviour = behaviours.shift() ?? "ok";
      if (behaviour === "rejected") throw new SlackPostRejected("slack chat.postMessage refused: channel_not_found");
      if (behaviour === "timeout_lost") throw new OperationTimeoutError("slack chat.postMessage", 20_000);
      const posted = { ts: `${++ts}.000100`, text: message.text, user: BOT };
      channel.unshift(posted);
      if (behaviour === "timeout_but_landed") throw new OperationTimeoutError("slack chat.postMessage", 20_000);
      return posted.ts;
    },
    async findRecent(_channel, author, needle, oldestMs) {
      lookups.push({ needle, oldestMs });
      if (options.historyFails) throw new Error("slack conversations.history timed out after 20000 ms");
      return channel.find((m) => m.user === author && m.text.includes(needle))?.ts;
    },
  };
  const escalator = createEscalator({
    channel: CHANNEL,
    operatorMentions: "<@U1> <@U2>",
    escalations,
    persist: () => {
      persisted++;
    },
    poster,
    botUserId: () => BOT,
    rememberThread: (thread) => remembered.push(thread),
    now: () => clock,
  });
  return {
    escalator,
    escalations,
    posts,
    lookups,
    remembered,
    persisted: () => persisted,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("escalate twice for one fingerprint posts once; the second call returns the first thread, deduplicated", async () => {
  const h = harness();

  const first = await h.escalator.escalate(request());
  const record = structuredClone(h.escalations.get("a1b2c3d4e5f60718"));
  h.advance(10 * 60 * 1000);
  const second = await h.escalator.escalate(request({ message: "still broken" }));

  assert.equal(h.posts.length, 1);
  assert.deepEqual(first, { channel: CHANNEL, ts: "1730000001.000100", deduplicated: false });
  assert.deepEqual(second, { channel: CHANNEL, ts: "1730000001.000100", deduplicated: true });
  // The nag record is untouched: same thread, same timers, same count
  assert.deepEqual(h.escalations.get("a1b2c3d4e5f60718"), record);
  assert.equal(h.persisted(), 1);
});

test("the first escalation is recorded for the nag loop and its thread remembered", async () => {
  const h = harness();

  await h.escalator.escalate(request());

  assert.deepEqual(h.escalations.get("a1b2c3d4e5f60718"), {
    alertFingerprint: "a1b2c3d4e5f60718",
    alertName: "High Error Rate",
    severity: "critical",
    environment: "prod",
    slackThreadTs: "1730000001.000100",
    slackChannel: CHANNEL,
    escalatedAt: Date.parse("2026-10-28T09:00:00Z"),
    lastNagAt: Date.parse("2026-10-28T09:00:00Z"),
    acknowledged: false,
    acknowledgedBy: undefined,
    nagCount: 0,
  });
  assert.deepEqual(h.remembered, ["1730000001.000100"]);
  assert.match(h.posts[0].text, /<@U1> <@U2>/);
});

test("two concurrent escalations for one fingerprint post once", async () => {
  let release: () => void = () => {};
  const h = harness({ postDelay: new Promise<void>((resolve) => (release = resolve)) });

  const first = h.escalator.escalate(request());
  const second = h.escalator.escalate(request());
  release();

  assert.deepEqual(await Promise.all([first, second]), [
    { channel: CHANNEL, ts: "1730000001.000100", deduplicated: false },
    { channel: CHANNEL, ts: "1730000001.000100", deduplicated: true },
  ]);
  assert.equal(h.posts.length, 1);
});

test("an acknowledged escalation can be escalated afresh", async () => {
  const h = harness();
  await h.escalator.escalate(request());
  const record = h.escalations.get("a1b2c3d4e5f60718");
  assert.ok(record);
  record.acknowledged = true;
  record.acknowledgedBy = "Leo";

  const again = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.deepEqual(again, { channel: CHANNEL, ts: "1730000002.000100", deduplicated: false });
  assert.equal(h.escalations.get("a1b2c3d4e5f60718")?.acknowledged, false);
});

test("different fingerprints get their own threads", async () => {
  const h = harness();

  await h.escalator.escalate(request());
  await h.escalator.escalate(request({ alertFingerprint: "ffff0000ffff0000" }));

  assert.equal(h.posts.length, 2);
  assert.equal(h.escalations.size, 2);
});

test("a warning does not page the operators", async () => {
  const h = harness();

  await h.escalator.escalate(request({ severity: "warning" }));

  assert.doesNotMatch(h.posts[0].text, /<@U1>/);
});

test("the escalation names its fingerprint, so a timed-out post can be found later", async () => {
  const h = harness();

  await h.escalator.escalate(request());

  assert.ok(h.posts[0].text.includes(fingerprintMarker("a1b2c3d4e5f60718")));
});

test("a timed-out escalate rejects, records nothing, and a later retry adopts the landed thread instead of posting again", async () => {
  const h = harness({ behaviours: ["timeout_but_landed"] });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  assert.equal(h.escalations.size, 0);
  assert.equal(h.posts.length, 1);

  h.advance(2 * 60 * 1000);
  const retry = await h.escalator.escalate(request({ message: "retrying after a timeout" }));

  assert.equal(h.posts.length, 1, "no second message in the channel");
  assert.deepEqual(retry, { channel: CHANNEL, ts: "1730000001.000100", deduplicated: true });
  assert.equal(h.escalations.get("a1b2c3d4e5f60718")?.slackThreadTs, "1730000001.000100");
  assert.deepEqual(h.remembered, ["1730000001.000100"]);
  // The lookup starts before the first attempt, so Slack's clock may lag ours
  assert.equal(h.lookups.length, 1);
  assert.ok(h.lookups[0].oldestMs < Date.parse("2026-10-28T09:00:00Z"));
});

test("a timed-out escalate that never landed is posted on the retry", async () => {
  const h = harness({ behaviours: ["timeout_lost", "ok"] });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  const retry = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.equal(h.lookups.length, 1);
  assert.equal(retry.deduplicated, false);
  assert.ok(h.escalations.has("a1b2c3d4e5f60718"));
});

test("after a timeout, an unreadable history refuses the retry instead of risking a second thread", async () => {
  const h = harness({ behaviours: ["timeout_but_landed"], historyFails: true });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  await assert.rejects(h.escalator.escalate(request()), /may be visible, and the channel history could not be checked/);

  assert.equal(h.posts.length, 1);
  assert.equal(h.escalations.size, 0);
});

test("a refused post is certain: the retry posts without a history lookup", async () => {
  const h = harness({ behaviours: ["rejected", "ok"] });

  await assert.rejects(h.escalator.escalate(request()), SlackPostRejected);
  await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.equal(h.lookups.length, 0);
});
