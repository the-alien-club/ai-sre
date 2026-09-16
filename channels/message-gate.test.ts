// Tests for the channel gating rule. Run with: npm test
//
// These cover the rule that protects the agent's context window: in a shared team
// channel the agent must hear what is addressed to it, and nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAddressedToAgent,
  mentionsBot,
  stripBotMention,
  type InboundMessage,
} from "./message-gate.js";

const BOT = "U0AU7UH148Y";
const noThreads = () => false;

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    isDirectMessage: false,
    text: "",
    botUserId: BOT,
    parentThreadTs: undefined,
    isAgentThread: noThreads,
    ...overrides,
  };
}

test("direct messages always reach the agent", () => {
  assert.equal(
    isAddressedToAgent(message({ isDirectMessage: true, text: "status?" })),
    true
  );
});

test("a channel message that mentions the bot reaches the agent", () => {
  assert.equal(
    isAddressedToAgent(message({ text: `<@${BOT}> what broke?` })),
    true
  );
});

test("ordinary channel chatter is dropped", () => {
  assert.equal(
    isAddressedToAgent(message({ text: "anyone up for lunch?" })),
    false
  );
});

test("a mention of someone else does not reach the agent", () => {
  assert.equal(
    isAddressedToAgent(message({ text: "<@U059X19MH8U> can you look?" })),
    false
  );
});

test("a threaded reply in an agent thread reaches the agent without a mention", () => {
  assert.equal(
    isAddressedToAgent(
      message({
        text: "go ahead",
        parentThreadTs: "1757580000.000100",
        isAgentThread: (ts) => ts === "1757580000.000100",
      })
    ),
    true
  );
});

test("a threaded reply in someone else's thread is dropped", () => {
  assert.equal(
    isAddressedToAgent(
      message({
        text: "agreed",
        parentThreadTs: "1757580000.000999",
        isAgentThread: (ts) => ts === "1757580000.000100",
      })
    ),
    false
  );
});

test("an unresolved bot user ID never matches a mention", () => {
  // Guards against a startup path where auth.test failed to yield an ID: the agent
  // must not start treating every message as addressed to it.
  assert.equal(mentionsBot("<@> hello", ""), false);
  assert.equal(
    isAddressedToAgent(message({ botUserId: "", text: `<@${BOT}> hello` })),
    false
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
