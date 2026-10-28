// Tests for the escalate tool's one-thread-per-alert rule. Run with: npm test
//
// A second escalate for a fingerprint that is still waiting used to post a new top-level
// message and overwrite the record, orphaning the first thread: replies there no longer
// stopped the nag loop. It must answer with the first thread and leave the record alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Escalation } from "./escalation-store.js";
import { createEscalator, type EscalateRequest } from "./escalator.js";

const CHANNEL = "C0TEAM";

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

function harness(options: { postDelay?: Promise<void> } = {}) {
  let clock = Date.parse("2026-10-28T09:00:00Z");
  let ts = 1_730_000_000;
  const posts: Array<{ channel: string; text: string }> = [];
  const remembered: string[] = [];
  const escalations = new Map<string, Escalation>();
  let persisted = 0;
  const escalator = createEscalator({
    channel: CHANNEL,
    operatorMentions: "<@U1> <@U2>",
    escalations,
    persist: () => {
      persisted++;
    },
    postMessage: async (message) => {
      posts.push(message);
      await options.postDelay;
      return { ts: `${++ts}.000100` };
    },
    rememberThread: (thread) => remembered.push(thread),
    now: () => clock,
  });
  return {
    escalator,
    escalations,
    posts,
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
