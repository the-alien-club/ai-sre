// Tests for the session heartbeat and GET /health/session. Run with: npm test
//
// Sentinel's `sre_agent` hop probes /health/session and restarts the agent on a 503, so the
// contract is what is under test: 503 `never_acked` until the session first answers, 200 `ok`
// while the last ack is younger than 12 min, 503 `stale` after, and `age_seconds` in the body.
// The clock and the timer are injected; nothing here waits on a real 5-min interval.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionHeartbeat,
  HEARTBEAT_FIRST_DELAY_MS,
  HEARTBEAT_INTERVAL_MS,
  SESSION_MAX_AGE_MS,
  type SessionHeartbeatDeps,
} from "./session-heartbeat.js";

const START = Date.parse("2026-10-28T09:00:00Z");

interface Scheduled {
  callback: () => void;
  delayMs: number;
  cancelled: boolean;
}

function harness(overrides: Partial<SessionHeartbeatDeps> = {}) {
  let clock = START;
  let counter = 0;
  const pushes: Array<{ content: string; meta: Record<string, string> }> = [];
  const scheduled: Scheduled[] = [];
  const logs: string[] = [];
  const heartbeat = createSessionHeartbeat({
    push: async (content, meta) => {
      pushes.push({ content, meta });
    },
    now: () => clock,
    newNonce: () => `nonce-${++counter}`,
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  return {
    heartbeat,
    pushes,
    scheduled,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("/health/session answers 503 never_acked before any ack", () => {
  const { heartbeat } = harness();

  assert.deepEqual(heartbeat.health(), {
    httpStatus: 503,
    body: { status: "never_acked", last_ack_at: null, age_seconds: null, max_age_seconds: 720, heartbeat_interval_seconds: 300 },
  });
});

test("after a heartbeat is pushed and acked, it answers 200 ok with the age of the ack", async () => {
  const h = harness();

  await h.heartbeat.beat();
  assert.deepEqual(h.pushes, [{ content: "heartbeat nonce-1", meta: { kind: "heartbeat", nonce: "nonce-1" } }]);

  h.advance(5_000);
  assert.deepEqual(h.heartbeat.ack("nonce-1"), { ok: true });
  h.advance(90_500);

  assert.deepEqual(h.heartbeat.health(), {
    httpStatus: 200,
    body: {
      status: "ok",
      last_ack_at: new Date(START + 5_000).toISOString(),
      age_seconds: 90,
      max_age_seconds: 720,
      heartbeat_interval_seconds: 300,
    },
  });
});

test("with the clock past 12 min since the last ack, it answers 503 stale", async () => {
  const h = harness();
  await h.heartbeat.beat();
  h.heartbeat.ack("nonce-1");

  h.advance(SESSION_MAX_AGE_MS - 1);
  assert.equal(h.heartbeat.health().httpStatus, 200);

  h.advance(1);
  const { httpStatus, body } = h.heartbeat.health();
  assert.equal(httpStatus, 503);
  assert.equal(body.status, "stale");
  assert.equal(body.age_seconds, 720);
  assert.equal(body.last_ack_at, new Date(START).toISOString());
});

test("an unknown nonce is an error result and leaves the last ack unchanged", async () => {
  const h = harness();
  await h.heartbeat.beat();
  h.heartbeat.ack("nonce-1");

  h.advance(60_000);
  const result = h.heartbeat.ack("not-a-nonce-we-sent");

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /^unknown nonce/);
  const { body } = h.heartbeat.health();
  assert.equal(body.last_ack_at, new Date(START).toISOString());
  assert.equal(body.age_seconds, 60);
});

test("a malformed nonce is an error result, never a throw", () => {
  const { heartbeat } = harness();

  for (const nonce of [undefined, null, 42, ""]) {
    const result = heartbeat.ack(nonce);
    assert.equal(result.ok, false);
  }
  assert.equal(heartbeat.health().body.status, "never_acked");
});

test("a nonce older than 2 intervals is rejected", async () => {
  const h = harness();
  await h.heartbeat.beat();

  h.advance(2 * HEARTBEAT_INTERVAL_MS + 1);
  const result = h.heartbeat.ack("nonce-1");

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /^unknown nonce nonce-1/);
  assert.equal(h.heartbeat.health().body.status, "never_acked");
});

test("the previous nonce is still accepted, the one before it is not", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    await h.heartbeat.beat();
    h.advance(HEARTBEAT_INTERVAL_MS / 10);
  }

  assert.equal(h.heartbeat.ack("nonce-1").ok, false);
  assert.equal(h.heartbeat.ack("nonce-2").ok, true);
  assert.equal(h.heartbeat.ack("nonce-3").ok, true);
});

test("heartbeats start after 60 s, repeat every 5 min, and stop on stop()", async () => {
  const h = harness();
  h.heartbeat.start();
  h.heartbeat.start(); // idempotent

  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].delayMs, HEARTBEAT_FIRST_DELAY_MS);

  h.scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.pushes.length, 1);
  assert.equal(h.scheduled.length, 2);
  assert.equal(h.scheduled[1].delayMs, HEARTBEAT_INTERVAL_MS);

  h.heartbeat.stop();
  assert.equal(h.scheduled[1].cancelled, true);
});

test("a stop() while a heartbeat is in flight schedules nothing more", async () => {
  let release: () => void = () => {};
  const h = harness({
    push: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  h.heartbeat.start();
  h.scheduled[0].callback();

  h.heartbeat.stop();
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.scheduled.length, 1);
});

test("a failed push is logged, never thrown, and the nonce stays acceptable", async () => {
  const h = harness({
    push: async () => {
      throw new Error("heartbeat notification timed out after 10000 ms");
    },
  });

  await h.heartbeat.beat();

  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /could not push heartbeat nonce-1: heartbeat notification timed out/);
  assert.equal(h.heartbeat.ack("nonce-1").ok, true);
});

test("a heartbeat that is pushed and acked logs nothing", async () => {
  const h = harness();

  await h.heartbeat.beat();
  h.heartbeat.ack("nonce-1");
  h.heartbeat.health();

  assert.deepEqual(h.logs, []);
});
