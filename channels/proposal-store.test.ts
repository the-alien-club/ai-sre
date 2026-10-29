// Tests for the runbook proposal store. Run with: npm test
//
// The store holds approvals that code acts on, so it must survive restarts exactly, never
// reuse a KB number, and refuse a file it cannot trust instead of starting empty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposalStore, ProposalStoreError, PROPOSAL_RETENTION_MS } from "./proposal-store.js";
import { sampleProposal } from "./kedb-test-fixtures.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "proposal-store-")), "data", "kedb-proposals.json");
}

test("a missing file is an empty store, and ids start at KB-1", () => {
  const store = createProposalStore({ path: tempPath() });
  assert.deepEqual(store.latest(), []);
  assert.equal(store.allocateId(), "KB-1");
  assert.equal(store.allocateId(), "KB-2");
});

test("proposals and the counter survive a restart; get returns the newest revision", () => {
  const path = tempPath();
  const store = createProposalStore({ path });
  store.allocateId();
  store.allocateId();
  store.put(sampleProposal({ rev: 1, status: "superseded" }));
  store.put(sampleProposal({ rev: 2 }));
  store.put(sampleProposal({ id: "KB-2", entry_id: "falco/_family" }));

  const reopened = createProposalStore({ path });
  assert.equal(reopened.get("KB-1")?.rev, 2);
  assert.deepEqual(reopened.latest().map((p) => `${p.id}#${p.rev}`), ["KB-1#2", "KB-2#1"]);
  assert.equal(reopened.allocateId(), "KB-3");
});

test("put replaces a revision in place and persists it", () => {
  const path = tempPath();
  const store = createProposalStore({ path });
  store.allocateId();
  store.put(sampleProposal());
  store.put(sampleProposal({ status: "rejected", status_reason: "no" }));
  assert.equal(createProposalStore({ path, now: () => 2_000 }).get("KB-1")?.status, "rejected");
});

test("put refuses an id that was never allocated, and an invalid record", () => {
  const store = createProposalStore({ path: tempPath() });
  assert.throws(() => store.put(sampleProposal()), ProposalStoreError);
  store.allocateId();
  assert.throws(() => store.put(sampleProposal({ entry_id: "../../etc/passwd" })), ProposalStoreError);
});

test("a corrupt file is an error, never an empty start that would reuse KB numbers", () => {
  const path = tempPath();
  createProposalStore({ path }).allocateId();
  writeFileSync(path, "{ not json");
  assert.throws(() => createProposalStore({ path }), /not valid JSON/);

  writeFileSync(path, JSON.stringify({ version: 1, next_number: 1, proposals: [sampleProposal()] }));
  assert.throws(() => createProposalStore({ path }), /not below next_number/);

  writeFileSync(path, JSON.stringify({ version: 2, next_number: 1, proposals: [] }));
  assert.throws(() => createProposalStore({ path }), ProposalStoreError);
});

test("closed proposals older than 90 days are dropped on load; open ones are kept", () => {
  const path = tempPath();
  const old = 1_000;
  const store = createProposalStore({ path, now: () => old });
  store.allocateId();
  store.allocateId();
  store.put(sampleProposal({ status: "applied", updated_at: old }));
  store.put(sampleProposal({ id: "KB-2", status: "pending", updated_at: old }));

  const later = createProposalStore({ path, now: () => old + PROPOSAL_RETENTION_MS + 1, log: () => {} });
  assert.deepEqual(later.latest().map((p) => p.id), ["KB-2"]);
  assert.equal(later.allocateId(), "KB-3");
});

test("the file is written atomically, with no temp file left behind", () => {
  const path = tempPath();
  const store = createProposalStore({ path });
  store.allocateId();
  store.put(sampleProposal());
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).proposals.length, 1);
});

test("a record written before payload_gap existed loads with payload_gap null; a gap round-trips", () => {
  const path = tempPath();
  createProposalStore({ path }).allocateId(); // creates the directory
  const { payload_gap: _absentBefore091, ...before091 } = sampleProposal();
  writeFileSync(path, JSON.stringify({ version: 1, next_number: 3, proposals: [before091] }));
  const store = createProposalStore({ path });
  assert.equal(store.get("KB-1")?.payload_gap, null);

  const gap = {
    fingerprint: "2ecf15e3f8af5ccc",
    requested_by: { user: "U054PDMV69X", name: "Leo", ts: "1793201690.000100", permalink: "https://alien.slack.com/archives/C09MWNB6WL8/p1793201690000100" },
  };
  store.put(sampleProposal({ id: "KB-2", payload_gap: gap }));
  assert.deepEqual(createProposalStore({ path }).get("KB-2")?.payload_gap, gap);
  // A fingerprint that would need escaping in a commit trailer is never stored as a gap
  assert.throws(() => store.put(sampleProposal({ id: "KB-2", payload_gap: { ...gap, fingerprint: "fp\nInjected: x" } })), ProposalStoreError);
});
