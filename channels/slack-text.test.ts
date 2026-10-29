// Tests for Slack text helpers. Run with: npm test
//
// The Trivy digest must never page anyone, and scanned images supply its text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkLines, escapeSlackText, normalizeReplyText } from "./slack-text.js";

test("scanned text cannot mention anyone", () => {
  assert.equal(escapeSlackText("pkg <@U054PDMV69X> <!channel> & <!here>"), "pkg &lt;@U054PDMV69X&gt; &lt;!channel&gt; &amp; &lt;!here&gt;");
});

test("lines are chunked under the limit, never mid-line", () => {
  assert.deepEqual(chunkLines(["aaaa", "bbbb", "cc"], 9), ["aaaa\nbbbb", "cc"]);
  assert.deepEqual(chunkLines([], 9), []);

  const [cut] = chunkLines(["x".repeat(20)], 9);
  assert.equal(cut.length, 9);
});

test("normalizeReplyText peels Slack formatting around a whole reply, and nothing else", () => {
  const cases: Array<[string, string]> = [
    ["`yes downgrade KB-1`", "yes downgrade KB-1"],
    ["```yes abcde```", "yes abcde"],
    ["```\nyes abcde\n```", "yes abcde"],
    ["*`no abcde`*", "no abcde"],
    ["_yes_", "yes"],
    ["&gt; yes KB-1", "yes KB-1"],
    ["> `yes KB-1`.", "yes KB-1"],
    ["  yes  ", "yes"],
    ["yes!", "yes"],
    // Left alone: strikethrough, formatting inside the reply, empty markers
    ["~yes~", "~yes~"],
    ["`yes` KB-1", "`yes` KB-1"],
    ["**", "**"],
    ["``", "``"],
    ["", ""],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeReplyText(input), expected, JSON.stringify(input));
});

test("normalizeReplyText stops after a bounded number of layers", () => {
  const deep = `${"*".repeat(20)}yes${"*".repeat(20)}`;
  assert.equal(normalizeReplyText(deep), `${"*".repeat(12)}yes${"*".repeat(12)}`);
});
