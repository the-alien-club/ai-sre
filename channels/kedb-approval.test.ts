// Tests for how a Slack reply is read against the runbook proposals, and for the approver
// roster. Run with: npm test
//
// The rules of plan §4: only an approver's fresh, exactly worded reply in the right place
// approves; a downgrade needs "yes downgrade KB-n"; everything else is a note or feedback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReply, compareSlackTs, slackPermalink, type InboundMessage } from "./kedb-approval.js";
import { parseApprovers } from "./kedb-approvers.js";
import { sampleProposal } from "./kedb-test-fixtures.js";

const LEO = "U054PDMV69X";
const ADRIEN = "U059X19MH8U";
const APPROVERS = new Map([[LEO, "Leo"]]);
const CHANNEL = "C09MWNB6WL8";
const THREAD = "1793201688.848269";
const AFTER_POST = "1793201800.000001";

function msg(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return { user: LEO, text, channel: CHANNEL, ts: AFTER_POST, threadTs: THREAD, ...overrides };
}

const pending = sampleProposal();
const downgrade = sampleProposal({ id: "KB-2", downgrade: { from: "page", to: "fyi", scope: ["new benign cause x"] } });

test("an approver's plain yes in the thread of the one pending proposal approves it", () => {
  for (const text of ["yes", "Yes.", " ok ", "approve!", "yes KB-1", "YES kb-1"]) {
    const meaning = classifyReply(msg(text), { approvers: APPROVERS, proposals: [pending] });
    assert.equal(meaning.kind, "approve", text);
  }
});

test("a yes that names the proposal approves it from anywhere in its channel", () => {
  const meaning = classifyReply(msg("yes KB-1", { threadTs: undefined }), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "approve");
});

test("a downgrade needs exactly 'yes downgrade KB-n'", () => {
  const options = { approvers: APPROVERS, proposals: [downgrade] };
  for (const text of ["yes", "yes KB-2", "yes downgrade"]) {
    const meaning = classifyReply(msg(text), options);
    assert.equal(meaning.kind, "notice", text);
    if (meaning.kind === "notice") assert.match(meaning.text, /yes downgrade KB-2/);
  }
  assert.equal(classifyReply(msg("yes downgrade KB-2"), options).kind, "approve");
});

test("'yes downgrade' on a proposal that is not a downgrade does not approve", () => {
  const meaning = classifyReply(msg("yes downgrade KB-1"), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "notice");
});

test("another operator's yes is feedback with a note, never an approval", () => {
  const meaning = classifyReply(msg("yes", { user: ADRIEN }), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "feedback");
  if (meaning.kind === "feedback") assert.match(meaning.notice ?? "", /Only Leo can approve/);
});

test("anything else in the thread is feedback on the pending proposal", () => {
  const meaning = classifyReply(msg("yes but drop the tty field"), { approvers: APPROVERS, proposals: [pending] });
  assert.deepEqual(meaning, { kind: "feedback", proposal: pending });
});

test("an approver's no rejects, with the reason", () => {
  const meaning = classifyReply(msg("no, the tty is wrong"), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "reject");
  if (meaning.kind === "reject") assert.equal(meaning.reason, "the tty is wrong");
  assert.equal(classifyReply(msg("nope, later"), { approvers: APPROVERS, proposals: [pending] }).kind, "feedback");
});

test("a yes that predates the current revision's post cannot approve it", () => {
  const meaning = classifyReply(msg("yes", { ts: "1793201700.000100" }), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "notice");
});

test("with two pending proposals in a thread the id is mandatory", () => {
  const other = sampleProposal({ id: "KB-3", entry_id: "falco/_family" });
  const options = { approvers: APPROVERS, proposals: [pending, other] };
  assert.equal(classifyReply(msg("yes"), options).kind, "notice");
  const named = classifyReply(msg("yes KB-3"), options);
  assert.equal(named.kind, "approve");
  if (named.kind === "approve") assert.equal(named.proposal.id, "KB-3");
});

test("yes outside any proposal thread, without an id, is not about proposals", () => {
  assert.equal(classifyReply(msg("yes", { threadTs: "1793000000.000001" }), { approvers: APPROVERS, proposals: [pending] }).kind, "none");
  assert.equal(classifyReply(msg("hello", { threadTs: undefined }), { approvers: APPROVERS, proposals: [pending] }).kind, "none");
});

test("a proposal that is no longer pending, or unknown, gets a note", () => {
  const applied = sampleProposal({ status: "applied" });
  assert.equal(classifyReply(msg("yes KB-1"), { approvers: APPROVERS, proposals: [applied] }).kind, "notice");
  assert.equal(classifyReply(msg("yes KB-9"), { approvers: APPROVERS, proposals: [pending] }).kind, "notice");
});

test("an approval in another channel (a DM) is refused: CI can only verify the team channel", () => {
  const meaning = classifyReply(msg("yes KB-1", { channel: "D012345", threadTs: undefined }), { approvers: APPROVERS, proposals: [pending] });
  assert.equal(meaning.kind, "notice");
});

test("Slack timestamps compare exactly, micros included", () => {
  assert.equal(compareSlackTs("1793201700.000101", "1793201700.000100"), 1);
  assert.equal(compareSlackTs("1793201700.000100", "1793201700.000100"), 0);
  assert.equal(compareSlackTs("999999999.999999", "1000000000.000000"), -1);
});

test("permalinks have Slack's shape, with the thread for a reply", () => {
  assert.equal(slackPermalink("https://alien.slack.com/", "C1", "1793201700.000100"), "https://alien.slack.com/archives/C1/p1793201700000100");
  assert.equal(
    slackPermalink("https://alien.slack.com", "C1", "1793201700.000100", "1793201688.848269"),
    "https://alien.slack.com/archives/C1/p1793201700000100?thread_ts=1793201688.848269&cid=C1"
  );
});

test("SRE_KEDB_APPROVERS: ids that are operators, named from the roster", () => {
  const operators = new Map([[LEO, "Leo"], [ADRIEN, "Adrien"]]);
  assert.deepEqual([...parseApprovers(` ${LEO} `, operators)], [[LEO, "Leo"]]);
  assert.throws(() => parseApprovers("", operators), /empty/);
  assert.throws(() => parseApprovers("leo", operators), /not a Slack user ID/);
  assert.throws(() => parseApprovers("U0NOTANOP", operators), /not in SRE_OPERATORS/);
});
