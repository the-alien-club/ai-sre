// Tests for the operator roster. Run with: npm test
//
// The roster decides who can reach the agent and who gets paged, so a malformed entry must
// refuse to start rather than quietly drop an operator.

import { test } from "node:test";
import assert from "node:assert/strict";
import { operatorMentions, operatorRoster, parseOperators } from "./operators.js";

test("parses the roster in order, trimming whitespace", () => {
  const operators = parseOperators(" U1:Leo , U2:Adrien,");

  assert.deepEqual([...operators], [["U1", "Leo"], ["U2", "Adrien"]]);
  assert.equal(operatorMentions(operators), "<@U1> <@U2>");
  assert.equal(operatorRoster(operators), "Leo (U1), Adrien (U2)");
});

test("an entry without a separator is refused", () => {
  assert.throws(() => parseOperators("U1:Leo,U2"), /"U2" is malformed/);
});

test("an entry with an empty side is refused", () => {
  assert.throws(() => parseOperators("U1:"), /both user ID and display name are required/);
  assert.throws(() => parseOperators(":Leo"), /both user ID and display name are required/);
});

test("an empty roster is refused", () => {
  assert.throws(() => parseOperators(" , "), /SRE_OPERATORS is empty/);
});
