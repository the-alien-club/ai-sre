// Tests for the channel gating rule. Run with: npm test
//
// These cover the rule that protects the agent's context window: in a shared team
// channel the agent must hear what is addressed to it, and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAddressing,
  mentionsBot,
  stripBotMention,
  type ClassifiableMessage,
} from "./message-gate.js";

const BOT = "U0AU7UH148Y";

function message(
  overrides: Partial<ClassifiableMessage> = {}
): ClassifiableMessage {
  return {
    isDirectMessage: false,
    text: "",
    botUserId: BOT,
    parentThreadTs: undefined,
    ...overrides,
  };
}

test("direct messages always reach the agent", () => {
  assert.deepEqual(
    classifyAddressing(message({ isDirectMessage: true, text: "status?" })),
    { kind: "direct_message" }
  );
});

test("a channel message that mentions the bot reaches the agent", () => {
  assert.deepEqual(
    classifyAddressing(message({ text: `<@${BOT}> what broke?` })),
    { kind: "mention" }
  );
});

test("ordinary channel chatter is dropped", () => {
  assert.deepEqual(
    classifyAddressing(message({ text: "anyone up for lunch?" })),
    { kind: "unaddressed" }
  );
});

test("a mention of someone else does not reach the agent", () => {
  assert.deepEqual(
    classifyAddressing(message({ text: "<@U059X19MH8U> can you look?" })),
    { kind: "unaddressed" }
  );
});

test("a threaded reply defers to a thread-ownership check", () => {
  // The classifier deliberately does not decide this one: whether the agent has posted in
  // the thread is a question only Slack can answer, and the caller pays for that lookup.
  assert.deepEqual(
    classifyAddressing(
      message({ text: "go ahead", parentThreadTs: "1757580000.000100" })
    ),
    { kind: "thread_reply", threadTs: "1757580000.000100" }
  );
});

test("a mention inside a thread short-circuits the ownership check", () => {
  // Mentioning the bot in a stranger's thread must get through without a Slack round-trip.
  assert.deepEqual(
    classifyAddressing(
      message({ text: `<@${BOT}> look here`, parentThreadTs: "1757580000.000999" })
    ),
    { kind: "mention" }
  );
});

test("a DM outranks everything else", () => {
  assert.deepEqual(
    classifyAddressing(
      message({
        isDirectMessage: true,
        text: "ping",
        parentThreadTs: "1757580000.000100",
      })
    ),
    { kind: "direct_message" }
  );
});

test("an unresolved bot user ID never matches a mention", () => {
  // Guards against a startup path where auth.test failed to yield an ID: the agent
  // must not start treating every message as addressed to it.
  assert.equal(mentionsBot("<@> hello", ""), false);
  assert.deepEqual(
    classifyAddressing(message({ botUserId: "", text: `<@${BOT}> hello` })),
    { kind: "unaddressed" }
  );
});

test("stripBotMention removes the mention and normalises whitespace", () => {
  assert.equal(stripBotMention(`<@${BOT}> check prod please`, BOT), "check prod please");
  assert.equal(stripBotMention(`hey <@${BOT}> check prod`, BOT), "hey check prod");
  assert.equal(stripBotMention(`<@${BOT}>`, BOT), "");
});

test("stripBotMention leaves other mentions intact", () => {
  assert.equal(
    stripBotMention(`<@${BOT}> ask <@U059X19MH8U>`, BOT),
    "ask <@U059X19MH8U>"
  );
});
