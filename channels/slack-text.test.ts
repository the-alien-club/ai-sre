// Tests for Slack text helpers. Run with: npm test
//
// The Trivy digest must never page anyone, and scanned images supply its text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkLines, escapeSlackText } from "./slack-text.js";

test("scanned text cannot mention anyone", () => {
  assert.equal(escapeSlackText("pkg <@U054PDMV69X> <!channel> & <!here>"), "pkg &lt;@U054PDMV69X&gt; &lt;!channel&gt; &amp; &lt;!here&gt;");
});

test("lines are chunked under the limit, never mid-line", () => {
  assert.deepEqual(chunkLines(["aaaa", "bbbb", "cc"], 9), ["aaaa\nbbbb", "cc"]);
  assert.deepEqual(chunkLines([], 9), []);

  const [cut] = chunkLines(["x".repeat(20)], 9);
  assert.equal(cut.length, 9);
});
