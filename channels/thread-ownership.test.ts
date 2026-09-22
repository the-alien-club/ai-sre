// Tests for thread ownership. Run with: npm test
//
// The decisive case is "restart amnesia": a thread the agent posted in yesterday, whose
// cache entry no longer exists, must still be recognised. That is the defect this module
// was written to kill — operators replying into escalation threads opened before the
// nightly `pm2 restart` were silently ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createThreadOwnership,
  type ThreadReplyReader,
} from "./thread-ownership.js";

const BOT = "U0AU7UH148Y";
const LEO = "U054PDMV69X";
const CHANNEL = "C09MWNB6WL8";

interface StubCall {
  channel: string;
  ts: string;
}

/** A Slack stand-in that records its calls and serves canned threads. */
function stubClient(threads: Record<string, Array<{ user?: string }>>): {
  client: ThreadReplyReader;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  return {
    calls,
    client: {
      conversations: {
        async replies({ channel, ts }) {
          calls.push({ channel, ts });
          return { messages: threads[ts] };
        },
      },
    },
  };
}

/** A Slack stand-in that always fails. */
function failingClient(): { client: ThreadReplyReader; calls: StubCall[] } {
  const calls: StubCall[] = [];
  return {
    calls,
    client: {
      conversations: {
        async replies({ channel, ts }) {
          calls.push({ channel, ts });
          throw new Error("slack is down");
        },
      },
    },
  };
}

test("a thread the agent opened is owned, with no cache priming", async () => {
  // This is the regression test for the nightly-restart defect: nothing was remembered,
  // and the answer still has to be yes.
  const { client, calls } = stubClient({
    "1790024827.569549": [{ user: BOT }, { user: LEO }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  assert.equal(calls.length, 1);
});

test("a thread the agent merely replied in is owned", async () => {
  // Leo @-mentions the bot top-level, the agent answers in-thread, Leo replies again with
  // no mention. The parent is Leo's — ownership is about participation, not authorship.
  const { client } = stubClient({
    "1790063614.624009": [{ user: LEO }, { user: BOT }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790063614.624009"), true);
});

test("a thread with no agent message is not owned", async () => {
  const { client } = stubClient({
    "1790000000.000100": [{ user: LEO }, { user: "U059X19MH8U" }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), false);
});

test("an empty thread response is not owned", async () => {
  const { client } = stubClient({});
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790000000.000404"), false);
});

test("remember() answers without calling Slack", async () => {
  const { client, calls } = stubClient({});
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  ownership.remember("1790024827.569549");

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  assert.equal(calls.length, 0);
});

test("remember(undefined) is a no-op", async () => {
  const { client } = stubClient({});
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  ownership.remember(undefined);

  assert.deepEqual(ownership.stats(), { owned: 0, foreign: 0 });
});

test("a foreign thread is looked up once, not once per reply", async () => {
  // Ordinary human threads in a busy channel must not cost an API call per message.
  const { client, calls } = stubClient({
    "1790000000.000100": [{ user: LEO }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), false);
  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), false);
  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), false);
  assert.equal(calls.length, 1);
});

test("an owned thread is looked up once", async () => {
  const { client, calls } = stubClient({
    "1790024827.569549": [{ user: BOT }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  assert.equal(calls.length, 1);
});

test("remember() overrides an earlier foreign verdict", async () => {
  // The agent joins a thread it had previously never posted in. The stale "not ours"
  // answer must not outlive that.
  const { client } = stubClient({ "1790000000.000100": [{ user: LEO }] });
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), false);
  ownership.remember("1790000000.000100");

  assert.equal(await ownership.owns(CHANNEL, "1790000000.000100"), true);
  assert.deepEqual(ownership.stats(), { owned: 1, foreign: 0 });
});

test("a failed lookup is not addressed and is not cached", async () => {
  // Caching a transient Slack failure would pin a live escalation thread as foreign for
  // the whole TTL. Dropping one message is recoverable; going deaf for a week is not.
  const { client, calls } = failingClient();
  const ownership = createThreadOwnership({ client, botUserId: () => BOT });

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), false);
  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), false);
  assert.equal(calls.length, 2);
  assert.deepEqual(ownership.stats(), { owned: 0, foreign: 0 });
});

test("an unresolved bot ID never claims ownership", async () => {
  const { client, calls } = stubClient({
    "1790024827.569549": [{ user: BOT }],
  });
  const ownership = createThreadOwnership({ client, botUserId: () => "" });

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), false);
  assert.equal(calls.length, 0);
});

test("a cached answer expires and is re-asked", async () => {
  let clock = 1_000_000;
  const { client, calls } = stubClient({
    "1790024827.569549": [{ user: BOT }],
  });
  const ownership = createThreadOwnership({
    client,
    botUserId: () => BOT,
    ttlMs: 1000,
    now: () => clock,
  });

  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  clock += 1001;
  assert.equal(await ownership.owns(CHANNEL, "1790024827.569549"), true);
  assert.equal(calls.length, 2);
});

test("prune() drops expired entries from both caches", async () => {
  let clock = 1_000_000;
  const { client } = stubClient({ "1790000000.000100": [{ user: LEO }] });
  const ownership = createThreadOwnership({
    client,
    botUserId: () => BOT,
    ttlMs: 1000,
    now: () => clock,
  });

  ownership.remember("1790024827.569549");
  await ownership.owns(CHANNEL, "1790000000.000100");
  assert.deepEqual(ownership.stats(), { owned: 1, foreign: 1 });

  clock += 1001;
  ownership.prune();
  assert.deepEqual(ownership.stats(), { owned: 0, foreign: 0 });
});

test("the owned cache evicts the least recently touched thread", async () => {
  const { client } = stubClient({});
  const ownership = createThreadOwnership({
    client,
    botUserId: () => BOT,
    maxEntries: 2,
  });

  ownership.remember("a");
  ownership.remember("b");
  ownership.remember("a"); // re-touch: "b" is now the oldest
  ownership.remember("c");

  assert.deepEqual(ownership.stats(), { owned: 2, foreign: 0 });
  // "b" was evicted, so answering it now costs a lookup that finds nothing.
  assert.equal(await ownership.owns(CHANNEL, "b"), false);
  assert.equal(await ownership.owns(CHANNEL, "a"), true);
});

test("human chatter cannot evict the agent's own threads", async () => {
  // The two caches have separate budgets on purpose: a burst of replies in an unrelated
  // human thread must not push a live escalation thread out of the owned set.
  const { client } = stubClient({
    "h1": [{ user: LEO }],
    "h2": [{ user: LEO }],
    "h3": [{ user: LEO }],
  });
  const ownership = createThreadOwnership({
    client,
    botUserId: () => BOT,
    maxEntries: 2,
  });

  ownership.remember("escalation");
  await ownership.owns(CHANNEL, "h1");
  await ownership.owns(CHANNEL, "h2");
  await ownership.owns(CHANNEL, "h3");

  assert.deepEqual(ownership.stats(), { owned: 1, foreign: 2 });
  assert.equal(await ownership.owns(CHANNEL, "escalation"), true);
});
