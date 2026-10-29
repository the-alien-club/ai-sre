// Tests for the KEDB index. Run with: npm test
//
// Each test builds a throwaway sre-kedb checkout: a .git directory holding only what
// readGitRev reads, and entries/ with real-shaped entries. The index must pick the same entry
// for the same alert every time, follow HEAD, and fail open on anything broken.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createKedbLookup,
  formatKedbBlock,
  KEDB_BLOCK_MAX_BYTES,
  kedbMeta,
  loadKedbIndex,
  matchAlert,
  readGitRev,
  type KedbAlert,
  type KedbIndex,
} from "./kedb-index.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const FALCO_FAMILY = `---
id: falco/_family
kind: family
status: active
security: true
match:
  alertname: ["Falco Suspicious Process", "/Falco/"]
updated: 2026-10-29
updated_by: test
---
# Playbook: Falco
`;

const HISTORY = `---
id: falco/delete-or-rename-shell-history
kind: signature
family: falco/_family
status: active
security: true
match:
  alertname: ["Falco Suspicious Process", "Falco Critical Event"]
  labels:
    rule: "Delete or rename shell history"
default:
  verdict: real
  action: page
benign_causes:
  - id: kapsule-serial-console-agent-update
    summary: s
    signature:
      user.name: ubuntu
      proc.tty: 1088
      evt.type: [open, openat]
      hostname: "/^scw-[a-z0-9-]+-pool-/"
    corroboration:
      - id: serial-login
        check: c
        runner: operator
      - id: short-session
        check: c
        runner: operator
    verdict_if_verified: known_issue
    action_if_verified: page
    action_if_signature_only: page
auto_fix: null
false_trails: ["Do not call it SSH: the parent is login on ttyS0."]
evidence: []
related_changes: []
incidents: ["3501"]
updated: 2026-10-29
updated_by: test
---
## Symptoms
`;

/** A signature with only the alertname: it matches the same alerts with fewer conditions. */
const BROAD = `---
id: falco/any-suspicious
kind: signature
family: falco/_family
status: active
security: true
match:
  alertname: ["Falco Suspicious Process"]
default:
  verdict: real
  action: escalate
benign_causes: []
auto_fix: null
false_trails: []
evidence: []
related_changes: []
incidents: []
updated: 2026-10-29
updated_by: test
---
## Symptoms
`;

const TENANT_FAMILY = `---
id: tenant-inactive/_family
kind: family
status: active
security: false
match:
  alertname: ["Tenant Inactive"]
updated: 2026-10-29
updated_by: test
---
# Playbook
`;

const TENANT_TEST = `---
id: tenant-inactive/tenant-test-401
kind: signature
family: tenant-inactive/_family
status: active
security: false
match:
  alertname: ["Tenant Inactive"]
  labels:
    k8s.namespace.name: "/^tenant-test-/"
  text: ["inactive on"]
default:
  verdict: known_issue
  action: log
benign_causes: []
auto_fix: null
false_trails: []
evidence: []
related_changes: []
incidents: []
updated: 2026-10-29
updated_by: test
---
## Symptoms
`;

const TRIVY_FAMILY = `---
id: trivy-exposed-secret/_family
kind: family
status: active
security: true
routed_by: trivy-webhook
match: {}
updated: 2026-10-29
updated_by: test
---
# Playbook
`;

function checkout(files: Record<string, string>, head = SHA_A): string {
  const dir = mkdtempSync(join(tmpdir(), "sre-kedb-"));
  write(dir, ".git/HEAD", "ref: refs/heads/main\n");
  write(dir, ".git/refs/heads/main", `${head}\n`);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  return dir;
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

const STANDARD = {
  "entries/falco/_family.md": FALCO_FAMILY,
  "entries/falco/delete-or-rename-shell-history.md": HISTORY,
  "entries/falco/any-suspicious.md": BROAD,
  "entries/tenant-inactive/_family.md": TENANT_FAMILY,
  "entries/tenant-inactive/tenant-test-401.md": TENANT_TEST,
  "entries/trivy-exposed-secret/_family.md": TRIVY_FAMILY,
};

function alert(labels: Record<string, string>, annotations: Record<string, string> = {}): KedbAlert {
  return { labels, annotations };
}

const SHELL_HISTORY = alert({
  alertname: "Falco Suspicious Process",
  rule: "Delete or rename shell history",
  hostname: "scw-platform-prod-pool-par-1-pro2-s-v2-08be108",
});

async function index(files: Record<string, string> = STANDARD): Promise<{ index: KedbIndex; logs: string[] }> {
  const logs: string[] = [];
  const dir = checkout(files);
  return { index: await loadKedbIndex(dir, await readGitRev(dir), (line) => logs.push(line)), logs };
}

// -- readGitRev --

test("readGitRev follows a loose ref, packed-refs and a detached HEAD", async () => {
  const loose = checkout({});
  assert.equal(await readGitRev(loose), SHA_A);

  const packed = checkout({});
  rmSync(join(packed, ".git/refs"), { recursive: true });
  write(packed, ".git/packed-refs", `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/main\n`);
  assert.equal(await readGitRev(packed), SHA_B);

  const detached = checkout({});
  write(detached, ".git/HEAD", `${SHA_B}\n`);
  assert.equal(await readGitRev(detached), SHA_B);
});

test("readGitRev refuses a directory that is not a checkout, and a ref escaping .git", async () => {
  await assert.rejects(readGitRev(mkdtempSync(join(tmpdir(), "sre-kedb-"))), /not a git checkout/);
  const escaping = checkout({});
  write(escaping, ".git/HEAD", "ref: refs/../../etc/passwd\n");
  await assert.rejects(readGitRev(escaping), /unexpected \.git\/HEAD/);
});

// -- loading --

test("only active, valid entries are indexed; a broken one is skipped and logged", async () => {
  const { index: idx, logs } = await index({
    ...STANDARD,
    "entries/falco/draft.md": BROAD.replace("falco/any-suspicious", "falco/draft").replace("status: active", "status: draft"),
    "entries/falco/wrong-id.md": BROAD,
    "entries/falco/bad-yaml.md": "---\nid: [\n---\n",
    "entries/falco/bad-regex.md": BROAD.replace("falco/any-suspicious", "falco/bad-regex").replace('["Falco Suspicious Process"]', '["/(a+)+/"]'),
    "entries/falco/huge.md": BROAD.replace("falco/any-suspicious", "falco/huge") + "x".repeat(70_000),
  });
  assert.deepEqual([...idx.entries.keys()].sort(), [
    "falco/_family",
    "falco/any-suspicious",
    "falco/delete-or-rename-shell-history",
    "tenant-inactive/_family",
    "tenant-inactive/tenant-test-401",
    "trivy-exposed-secret/_family",
  ]);
  assert.equal(idx.skipped, 5);
  assert.ok(logs.some((l) => /wrong-id\.md: id 'falco\/any-suspicious' is not its path/.test(l)));
  assert.ok(logs.some((l) => /bad-yaml\.md/.test(l)));
  assert.ok(logs.some((l) => /bad-regex\.md: regex/.test(l)));
  assert.ok(logs.some((l) => /huge\.md: larger than/.test(l)));
});

test("an entry with a field the index acts on in the wrong shape is skipped", async () => {
  const { index: idx } = await index({
    "entries/falco/_family.md": FALCO_FAMILY,
    "entries/falco/delete-or-rename-shell-history.md": HISTORY.replace("action: page\nbenign", "action: shout\nbenign"),
  });
  assert.equal(idx.entries.has("falco/delete-or-rename-shell-history"), false);
});

// -- matching --

test("the signature with the most conditions wins, and at most two are reported", async () => {
  const { index: idx } = await index();
  const match = matchAlert(idx, SHELL_HISTORY);
  assert.equal(match.kind, "exact");
  if (match.kind !== "exact") return;
  assert.equal(match.entry.id, "falco/delete-or-rename-shell-history");
  assert.deepEqual(match.also.map((e) => e.id), ["falco/any-suspicious"]);
});

test("a Falco alert matching no signature falls back to its family, via the /Falco/ regex too", async () => {
  const { index: idx } = await index();
  const match = matchAlert(idx, alert({ alertname: "Falco Event Surge" }));
  assert.equal(match.kind, "family");
  if (match.kind === "family") assert.equal(match.entry.id, "falco/_family");
});

test("labels and text must all hold for a signature", async () => {
  const { index: idx } = await index();
  const testTenant = alert({ alertname: "Tenant Inactive", "k8s.namespace.name": "tenant-test-42" }, { summary: "Tenant tenant-test-42 inactive on data-cluster-dev for 1 hour" });
  const exact = matchAlert(idx, testTenant);
  assert.equal(exact.kind === "exact" && exact.entry.id, "tenant-inactive/tenant-test-401");

  const realTenant = alert({ alertname: "Tenant Inactive", "k8s.namespace.name": "tenant-biorxiv" }, testTenant.annotations);
  assert.equal(matchAlert(idx, realTenant).kind, "family");

  const noText = alert(testTenant.labels, { summary: "something else" });
  assert.equal(matchAlert(idx, noText).kind, "family");
});

test("an alert no entry covers is none; an empty match never matches anything", async () => {
  const { index: idx } = await index();
  assert.deepEqual(matchAlert(idx, alert({ alertname: "Disk Weather" })), { kind: "none", rev: SHA_A });
  assert.equal(matchAlert(idx, alert({})).kind, "none");
});

test("kedb_id or runbook_id selects an entry only when it names a real one", async () => {
  const { index: idx } = await index();
  const named = matchAlert(idx, alert({ alertname: "Hop down: x", kedb_id: "tenant-inactive/tenant-test-401" }));
  assert.equal(named.kind === "exact" && named.entry.id, "tenant-inactive/tenant-test-401");

  const viaAnnotation = matchAlert(idx, alert({ alertname: "Hop down: x" }, { runbook_id: "falco/_family" }));
  assert.equal(viaAnnotation.kind === "family" && viaAnnotation.entry.id, "falco/_family");

  for (const hostile of ["../../etc/passwd", "falco/../../x", "falco/nope", "FALCO/_family"]) {
    assert.equal(matchAlert(idx, alert({ alertname: "Disk Weather", kedb_id: hostile })).kind, "none", hostile);
  }
});

test("a signature hint is full only when every field is in the alert and matches", async () => {
  const { index: idx } = await index();
  const partial = matchAlert(idx, SHELL_HISTORY);
  assert.equal(partial.kind, "exact");
  if (partial.kind !== "exact") return;
  assert.deepEqual(partial.hints, [{ causeId: "kapsule-serial-console-agent-update", matched: 1, total: 4, absent: ["user.name", "proc.tty", "evt.type"] }]);
  assert.equal(kedbMeta(partial).kedb_hint, undefined);

  const full = matchAlert(idx, alert({ ...SHELL_HISTORY.labels, "user.name": "ubuntu", "proc.tty": "1088", "evt.type": "openat" }));
  assert.equal(kedbMeta(full).kedb_hint, "kapsule-serial-console-agent-update");

  const wrong = matchAlert(idx, alert({ ...SHELL_HISTORY.labels, "user.name": "root", "proc.tty": "1088", "evt.type": "openat" }));
  assert.equal(kedbMeta(wrong).kedb_hint, undefined);
});

// -- what the session sees --

test("meta carries the match, the short rev and the prediction", async () => {
  const { index: idx } = await index();
  assert.deepEqual(kedbMeta(matchAlert(idx, SHELL_HISTORY)), {
    kedb_match: "exact",
    kedb_rev: "aaaaaaa",
    kedb_id: "falco/delete-or-rename-shell-history",
    kedb_predicted_verdict: "real",
    kedb_predicted_action: "page",
  });
  assert.deepEqual(kedbMeta(matchAlert(idx, alert({ alertname: "Falco Event Surge" }))), { kedb_match: "family", kedb_rev: "aaaaaaa", kedb_id: "falco/_family" });
  assert.deepEqual(kedbMeta({ kind: "none", rev: SHA_A }), { kedb_match: "none", kedb_rev: "aaaaaaa" });
  assert.deepEqual(kedbMeta({ kind: "unavailable", reason: "x" }), { kedb_match: "none" });
});

test("the KEDB block names the entry, the prediction, the checks and the file", async () => {
  const { index: idx } = await index();
  const block = formatKedbBlock(matchAlert(idx, SHELL_HISTORY));
  const lines = block.split("\n");
  assert.equal(lines[0], "--- KEDB (trusted, Leo-approved, rev aaaaaaa) ---");
  assert.equal(lines[1], "Entry: falco/delete-or-rename-shell-history (signature in falco/_family)");
  assert.match(block, /^Default: real → page\. Security entry: never below fyi, never auto-fixed\.$/m);
  assert.match(block, /^Signature hint: kapsule-serial-console-agent-update \(1\/4 fields match the alert; not in the alert, read from the source log: user\.name, proc\.tty, evt\.type\)\. A hint, never proof\.$/m);
  assert.match(block, /^Verify before downgrading \(kapsule-serial-console-agent-update\): serial-login \(operator-run\), short-session \(operator-run\)\.$/m);
  assert.match(block, /^Also matched: falco\/any-suspicious /m);
  assert.match(block, /^False trail: Do not call it SSH/m);
  assert.match(lines.at(-2) ?? "", /^Full entry: .*\/entries\/falco\/delete-or-rename-shell-history\.md$/);
  assert.equal(lines.at(-1), "--- end KEDB ---");
});

test("the KEDB block stays within its byte bound and keeps the entry and file lines", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `"${"long false trail ".repeat(20)}${i}"`).join(", ");
  const { index: idx } = await index({ ...STANDARD, "entries/falco/delete-or-rename-shell-history.md": HISTORY.replace('false_trails: ["Do not call it SSH: the parent is login on ttyS0."]', `false_trails: [${many}]`) });
  const block = formatKedbBlock(matchAlert(idx, SHELL_HISTORY));
  assert.ok(Buffer.byteLength(block) <= KEDB_BLOCK_MAX_BYTES, `${Buffer.byteLength(block)} bytes`);
  assert.match(block, /^Entry: falco\/delete-or-rename-shell-history/m);
  assert.match(block, /^Full entry: /m);
  assert.match(block, /--- end KEDB ---$/);
});

test("no match and an unavailable KEDB each say to use the playbooks", () => {
  assert.equal(formatKedbBlock({ kind: "none", rev: SHA_A }), "--- KEDB (rev aaaaaaa): no entry matches this alert; use playbooks/ and the CLAUDE.md mapping ---");
  assert.match(formatKedbBlock({ kind: "unavailable", reason: "/home/sre-agent/kedb is not a git checkout (ENOENT)" }), /^--- KEDB unavailable \(.*\); use playbooks\//);
});

// -- the lookup --

test("the lookup reloads when HEAD moves, and only then", async () => {
  const dir = checkout(STANDARD);
  let loads = 0;
  const lookup = createKedbLookup({
    dir,
    timeoutMs: 2000,
    log: () => {},
    load: (d, rev, log) => {
      loads++;
      return loadKedbIndex(d, rev, log);
    },
  });
  assert.equal((await lookup.lookup(SHELL_HISTORY)).kind, "exact");
  await lookup.lookup(SHELL_HISTORY);
  assert.equal(loads, 1);

  // A changed file without a new commit is not picked up: the rev is the unit of attribution.
  write(dir, "entries/falco/delete-or-rename-shell-history.md", HISTORY.replace("status: active", "status: retired"));
  assert.equal((await lookup.lookup(SHELL_HISTORY)).kind, "exact");

  write(dir, ".git/refs/heads/main", `${SHA_B}\n`);
  const after = await lookup.lookup(SHELL_HISTORY);
  assert.equal(loads, 2);
  assert.equal(after.kind === "exact" && after.entry.id, "falco/any-suspicious");
  assert.equal(after.kind === "exact" && after.rev, SHA_B);
});

test("a missing checkout fails open, logged once, not once per alert", async () => {
  const logs: string[] = [];
  const lookup = createKedbLookup({ dir: join(tmpdir(), "sre-kedb-does-not-exist"), timeoutMs: 2000, log: (l) => logs.push(l) });
  for (let i = 0; i < 3; i++) {
    const match = await lookup.lookup(SHELL_HISTORY);
    assert.equal(match.kind, "unavailable");
  }
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[kedb\] unavailable, alerts go out without a KEDB match: .*not a git checkout/);
});

test("a checkout without entries/ fails open", async () => {
  const lookup = createKedbLookup({ dir: checkout({}), timeoutMs: 2000, log: () => {} });
  const match = await lookup.lookup(SHELL_HISTORY);
  assert.equal(match.kind === "unavailable" && /cannot read .*entries/.test(match.reason), true);
});

test("a load that hangs is bounded and fails open", async () => {
  const lookup = createKedbLookup({ dir: checkout(STANDARD), timeoutMs: 50, log: () => {}, load: () => new Promise(() => {}) });
  const started = Date.now();
  const match = await lookup.lookup(SHELL_HISTORY);
  assert.equal(match.kind === "unavailable" && /KEDB lookup timed out after 50 ms/.test(match.reason), true);
  assert.ok(Date.now() - started < 1000);
});
