// Shared fixtures for the KEDB learning-loop tests (proposal-store, kedb-approval, kedb-loop).

import type { Proposal } from "./proposal-store.js";

export function sampleProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "KB-1",
    rev: 1,
    entry_id: "falco/delete-or-rename-shell-history",
    op: "update",
    base_blob_sha: "a".repeat(40),
    content: "---\nid: x\n---\nbody\n",
    content_sha256: "b".repeat(64),
    diff: "+x",
    learned: "It was the serial console.",
    incident_id: "3501",
    fingerprint: "fp1",
    slack_channel: "C09MWNB6WL8",
    thread_ts: "1793201688.848269",
    thread_permalink: "https://alien.slack.com/archives/C09MWNB6WL8/p1793201688848269",
    post_ts: "1793201700.000100",
    post_permalink: "https://alien.slack.com/archives/C09MWNB6WL8/p1793201700000100?thread_ts=1793201688.848269&cid=C09MWNB6WL8",
    diff_post_ts: [],
    posted_at: 1_000,
    downgrade: null,
    status: "pending",
    status_reason: null,
    approval: null,
    payload_gap: null,
    commit_sha: null,
    created_at: 1_000,
    updated_at: 1_000,
    reminded_at: null,
    ...overrides,
  };
}
