// Tests for the incident memory CLI. Run with: npm test
//
// Arguments to incidents.sh come from alert labels and sub-agent output, so they are
// attacker-influenced. These tests drive the real script against a scratch database and
// check that hostile values are stored verbatim, never executed, and that the CLI surface
// the agent's prompts depend on still behaves the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sampleProposal } from "../channels/kedb-test-fixtures.js";

const SCRIPT = "scripts/incidents.sh";

function scratchDb(): string {
  return join(mkdtempSync(join(tmpdir(), "sre-incidents-")), "incidents.db");
}

function run(db: string, ...args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, INCIDENTS_DB: db },
    encoding: "utf8",
  });
}

function query(db: string, sql: string): string {
  return spawnSync("sqlite3", [db, sql], { encoding: "utf8" }).stdout.trim();
}

function logIncident(db: string, overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    "--alert": "High Error Rate",
    "--severity": "critical",
    "--verdict": "real",
    "--action": "escalated",
    "--cluster": "platform-prod",
    "--fingerprint": "fp-1",
    ...overrides,
  };
  return run(db, "log", ...Object.entries(fields).flat());
}

const HOSTILE = "x'); DROP TABLE incidents; --";

test("a logged incident is stored and found by check", () => {
  const db = scratchDb();
  assert.equal(logIncident(db).status, 0);
  const out = run(db, "check", "--alert", "High Error Rate", "--cluster", "platform-prod");
  assert.equal(out.status, 0);
  assert.match(out.stdout, /escalated/);
});

test("a hostile fingerprint is stored verbatim and the table survives", () => {
  const db = scratchDb();
  assert.equal(logIncident(db, { "--fingerprint": HOSTILE }).status, 0);
  assert.equal(query(db, "SELECT fingerprint FROM incidents;"), HOSTILE);
  assert.equal(query(db, "SELECT COUNT(*) FROM incidents;"), "1");
});

test("hostile values in every text field are stored verbatim", () => {
  const db = scratchDb();
  const result = logIncident(db, {
    "--alert": HOSTILE,
    "--severity": HOSTILE,
    "--cluster": HOSTILE,
    "--namespace": HOSTILE,
    "--service": HOSTILE,
    "--verdict": HOSTILE,
    "--action": HOSTILE,
    "--related-mr": HOSTILE,
    "--status": HOSTILE,
  });
  assert.equal(result.status, 0);
  assert.equal(
    query(db, "SELECT COUNT(*) FROM incidents WHERE alert_name = cluster AND cluster = related_mr AND status = verdict;"),
    "1",
  );
});

test("a hostile cluster filter in check matches nothing and drops nothing", () => {
  const db = scratchDb();
  logIncident(db);
  const out = run(db, "check", "--alert", "High Error Rate", "--cluster", "' OR '1'='1");
  assert.equal(out.status, 0);
  assert.doesNotMatch(out.stdout, /escalated/);
  assert.equal(query(db, "SELECT COUNT(*) FROM incidents;"), "1");
});

test("fingerprint and timeline look up hostile fingerprints safely", () => {
  const db = scratchDb();
  logIncident(db, { "--fingerprint": HOSTILE });
  assert.match(run(db, "fingerprint", "--fp", HOSTILE).stdout, /High Error Rate/);
  assert.match(run(db, "timeline", "--fp", HOSTILE).stdout, /High Error Rate/);
});

test("context notes keep quotes, newlines and unicode intact", () => {
  const db = scratchDb();
  const note = "pod 'backend-7f' OOM;\nretried — still failing ✗";
  const result = run(db, "context", "--fp", HOSTILE, "--phase", "diagnosis", "--content", note, "--author", HOSTILE);
  assert.equal(result.status, 0);
  assert.equal(query(db, "SELECT content FROM incident_context;"), note);
  assert.equal(query(db, "SELECT author FROM incident_context;"), HOSTILE);
});

test("numeric arguments must be integers", () => {
  const db = scratchDb();
  logIncident(db);
  for (const args of [
    ["check", "--alert", "x", "--days", "7) OR 1=1 --"],
    ["patterns", "--days", "1; DROP TABLE incidents"],
    ["briefing", "--days", "seven"],
    ["resolve", "--id", "1 OR 1=1", "--resolution", "x"],
    ["context", "--fp", "f", "--phase", "fix", "--content", "c", "--incident-id", "1); DROP TABLE incidents; --"],
  ]) {
    const out = run(db, ...args);
    assert.notEqual(out.status, 0, `expected rejection for ${args.join(" ")}`);
    assert.match(out.stderr, /expected a non-negative integer/);
  }
  assert.notEqual(run(db, "check", "--alert", "x", "--days", "1234567890").status, 0, "10 digits exceeds the bound");
  assert.equal(logIncident(db, { "--duration": "abc" }).status === 0, false);
  assert.equal(query(db, "SELECT COUNT(*) FROM incidents;"), "1");
});

test("resolve marks only the given incident", () => {
  const db = scratchDb();
  logIncident(db);
  logIncident(db, { "--fingerprint": "fp-2" });
  assert.equal(run(db, "resolve", "--id", "1", "--resolution", "MR 'x' reverted").status, 0);
  assert.equal(query(db, "SELECT id, escalation_acknowledged, resolution FROM incidents ORDER BY id;"), "1|1|MR 'x' reverted\n2|0|");
});

test("resolve on an unknown id is an error, not a false success", () => {
  const db = scratchDb();
  logIncident(db);
  const result = run(db, "resolve", "--id", "42", "--resolution", "x");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No incident with id 42/);
  assert.equal(query(db, "SELECT escalation_acknowledged FROM incidents;"), "0");
});

test("a large cause and notes are stored, not rejected by the argument limit", () => {
  // A single argument is capped at 128KB by the kernel, so ~100KB is the largest value a
  // caller can pass. Hex-encoded into the SQL it doubles to ~200KB, which as a sqlite3
  // argument failed with "Argument list too long"; on stdin it has no limit.
  const db = scratchDb();
  const cause = "c".repeat(100_000);
  const notes = "n'".repeat(50_000);
  const result = logIncident(db, { "--cause": cause, "--notes": notes });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(query(db, "SELECT length(cause), length(notes) FROM incidents;"), "100000|100000");
});

test("resolve without an id is a usage error", () => {
  const db = scratchDb();
  assert.notEqual(run(db, "resolve", "--resolution", "x").status, 0);
});

test("briefing succeeds when incidents exist", () => {
  // It used to exit 1 here, so start-agent.sh appended its failure fallback to a real briefing
  const db = scratchDb();
  logIncident(db);
  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total: 1 alerts processed/);
  assert.doesNotMatch(result.stdout, /No incidents recorded yet/);
});

test("briefing on an empty database says so and succeeds", () => {
  const result = run(scratchDb(), "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No incidents recorded yet/);
});

test("briefing and patterns still run with defaults", () => {
  const db = scratchDb();
  logIncident(db);
  assert.match(run(db, "briefing").stdout, /SRE Briefing — Last 7 Days/);
  assert.match(run(db, "patterns").stdout, /Recurring Alerts \(last 7 days\)/);
});

/** Insert <count> incidents straight into the database, for volumes the CLI would take minutes to log. */
function bulkInsert(db: string, count: number, select: string): void {
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
    INSERT INTO incidents (alert_name, severity, status, cluster, service, verdict, action, cause) ${select};`;
  const result = spawnSync("sqlite3", ["-bail", db], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("briefing stays bounded however many incidents there are", () => {
  // 263 Trivy findings in 3 days once made the briefing 50KB, too large for tmux to deliver
  const db = scratchDb();
  run(db, "briefing");
  const long = "x".repeat(4_000);
  bulkInsert(db, 3_000, `SELECT 'Alert ' || (i % 300) || '${long.slice(0, 200)}', 'critical', 'firing', 'cluster-' || (i % 300 % 7), 'svc-' || (i % 300 % 11), CASE WHEN i % 600 < 300 THEN 'real' ELSE 'noise' END, CASE i % 3 WHEN 0 THEN 'escalated' ELSE 'ignored' END, 'line one' || char(10) || 'line two ${long}' FROM n`);

  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) < 12_000, `briefing is ${Buffer.byteLength(result.stdout)} bytes`);
  const entries = result.stdout.split("\n").filter((line) => line.startsWith("  - "));
  assert.equal(entries.length, 30, "10 classes in each of the three sections");
  assert.equal(result.stdout.match(/^ {2}… and \d+ more alert classes: /gm)?.length, 3);
  for (const line of entries) assert.ok(line.length < 400, `unclipped line: ${line.slice(0, 120)}…`);
  assert.doesNotMatch(result.stdout, /^line two/m, "a multi-line cause must stay on its line");
});

test("briefing summarises a repeated alert class in one line", () => {
  const db = scratchDb();
  run(db, "briefing");
  bulkInsert(db, 263, `SELECT 'Trivy VulnerabilityReport', 'critical', 'firing', CASE i % 2 WHEN 0 THEN 'platform-prod' ELSE 'platform-dev' END, 'image-' || i, 'real', 'escalated', 'image ' || i || ' has CVEs' FROM n`);

  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pending escalations \(unacknowledged, last 3 days: 263 in 1 alert classes, latest first\):\n {2}- \[\d{4}-\d\d-\d\d\] Trivy VulnerabilityReport — 263x on platform-\w+,platform-\w+ \(latest #\d+\): image \d+ has CVEs\n\n/);
});

test("briefing tells the same noisy alert on different clusters apart", () => {
  const db = scratchDb();
  run(db, "briefing");
  bulkInsert(db, 8, `SELECT 'Falco Suspicious Process', 'warning', 'firing', CASE WHEN i <= 5 THEN 'platform-prod' ELSE 'platform-dev' END, 'falco', 'noise', 'ignored', '' FROM n`);

  const result = run(db, "briefing");
  assert.match(result.stdout, /^ {2}- Falco Suspicious Process on falco @ platform-prod \| 5x$/m);
  assert.match(result.stdout, /^ {2}- Falco Suspicious Process on falco @ platform-dev \| 3x$/m);
});

// -- KEDB columns, flags, correct and briefing (plan §6) --

const KEDB_COLUMNS = ["kedb_id", "kedb_rev", "kedb_match", "kedb_predicted_verdict", "kedb_predicted_action", "corroboration", "operator_verdict", "operator_verdict_by", "operator_verdict_at"];

function columns(db: string): string[] {
  return query(db, "SELECT name FROM pragma_table_info('incidents');").split("\n");
}

const KEDB_FLAGS: Record<string, string> = {
  "--kedb-id": "falco/delete-or-rename-shell-history",
  "--kedb-rev": "a1b2c3d",
  "--kedb-match": "exact",
  "--kedb-predicted-verdict": "real",
  "--kedb-predicted-action": "page",
  "--corroboration": '{"serial-login":"pass","short-session":"not-run"}',
};

test("a database created before the KEDB gains its columns, keeping its rows, idempotently", () => {
  const db = scratchDb();
  // The pre-KEDB schema: the init SQL alone, as start-agent.sh created it
  const init = spawnSync("sqlite3", ["-bail", db], { input: readFileSync("scripts/incidents-db-init.sql", "utf8"), encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  bulkInsert(db, 3, "SELECT 'Old Alert', 'warning', 'firing', 'platform-prod', 'svc', 'noise', 'ignored', 'old' FROM n");
  assert.ok(!columns(db).includes("kedb_id"));

  for (let i = 0; i < 2; i++) assert.equal(run(db, "briefing").status, 0);
  for (const column of KEDB_COLUMNS) assert.ok(columns(db).includes(column), column);
  assert.equal(columns(db).length, new Set(columns(db)).size, "no column added twice");
  assert.equal(query(db, "SELECT COUNT(*), COUNT(kedb_id) FROM incidents;"), "3|0");
});

test("a database with some KEDB columns already gets only the missing ones", () => {
  const db = scratchDb();
  spawnSync("sqlite3", ["-bail", db], { input: readFileSync("scripts/incidents-db-init.sql", "utf8") });
  spawnSync("sqlite3", [db, "ALTER TABLE incidents ADD COLUMN kedb_id TEXT;"]);
  assert.equal(run(db, "patterns").status, 0);
  for (const column of KEDB_COLUMNS) assert.ok(columns(db).includes(column), column);
});

test("log stores the KEDB fields, and NULL when they are not given", () => {
  const db = scratchDb();
  assert.equal(logIncident(db, KEDB_FLAGS).status, 0);
  assert.equal(logIncident(db, { "--fingerprint": "fp-2" }).status, 0);
  assert.equal(
    query(db, "SELECT kedb_id, kedb_rev, kedb_match, kedb_predicted_verdict, kedb_predicted_action, corroboration FROM incidents WHERE id = 1;"),
    'falco/delete-or-rename-shell-history|a1b2c3d|exact|real|page|{"serial-login":"pass","short-session":"not-run"}'
  );
  assert.equal(query(db, "SELECT kedb_id IS NULL, kedb_match IS NULL, corroboration IS NULL FROM incidents WHERE id = 2;"), "1|1|1");
});

test("malformed or hostile KEDB flags are rejected and nothing is logged", () => {
  const db = scratchDb();
  for (const [flag, value] of [
    ["--kedb-match", "maybe"],
    ["--kedb-id", "../../etc/passwd"],
    ["--kedb-id", HOSTILE],
    ["--kedb-rev", "HEAD"],
    ["--kedb-predicted-verdict", "fine"],
    ["--kedb-predicted-action", "shout"],
    ["--corroboration", "not json"],
    ["--corroboration", '["pass"]'],
    ["--corroboration", '{"serial-login":"maybe"}'],
    ["--corroboration", '{"serial-login":1}'],
    ["--corroboration", `{"x'); DROP TABLE incidents; --":"pass"}`],
  ]) {
    const result = logIncident(db, { ...KEDB_FLAGS, [flag]: value });
    assert.notEqual(result.status, 0, `${flag} ${value}`);
    assert.match(result.stderr, /Invalid/, `${flag} ${value}`);
  }
  const noMatch = logIncident(db, { "--kedb-id": "falco/_family" });
  assert.notEqual(noMatch.status, 0);
  assert.match(noMatch.stderr, /--kedb-id needs --kedb-match/);
  assert.equal(query(db, "SELECT COUNT(*) FROM incidents;"), "0");
});

test("correct records the operator's verdict next to the agent's", () => {
  const db = scratchDb();
  logIncident(db, KEDB_FLAGS);
  const result = run(db, "correct", "--id", "1", "--verdict", "known_issue", "--by", "Leo");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Incident 1: operator verdict known_issue \(by Leo\)/);
  assert.equal(query(db, "SELECT verdict, operator_verdict, operator_verdict_by, operator_verdict_at LIKE '20__-__-__T__:__:__Z' FROM incidents;"), "real|known_issue|Leo|1");
});

test("correct rejects an unknown id, a bad verdict and a missing --by", () => {
  const db = scratchDb();
  logIncident(db);
  const unknown = run(db, "correct", "--id", "42", "--verdict", "noise", "--by", "Leo");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No incident with id 42/);
  const badVerdict = run(db, "correct", "--id", "1", "--verdict", "meh", "--by", "Leo");
  assert.notEqual(badVerdict.status, 0);
  assert.match(badVerdict.stderr, /Invalid --verdict/);
  assert.notEqual(run(db, "correct", "--id", "1", "--verdict", "noise").status, 0);
  assert.notEqual(run(db, "correct", "--id", "1 OR 1=1", "--verdict", "noise", "--by", "Leo").status, 0);
  assert.equal(query(db, "SELECT operator_verdict IS NULL FROM incidents;"), "1");
});

test("correct stores a hostile operator name verbatim", () => {
  const db = scratchDb();
  logIncident(db);
  assert.equal(run(db, "correct", "--id", "1", "--verdict", "noise", "--by", HOSTILE).status, 0);
  assert.equal(query(db, "SELECT operator_verdict_by FROM incidents;"), HOSTILE);
  assert.equal(query(db, "SELECT COUNT(*) FROM incidents;"), "1");
});

test("briefing reports KEDB predictions and the entries that got them wrong", () => {
  const db = scratchDb();
  // Right: predicted real, agent said real
  logIncident(db, KEDB_FLAGS);
  // Wrong per the agent: predicted real, agent said known_issue
  logIncident(db, { ...KEDB_FLAGS, "--verdict": "known_issue", "--fingerprint": "fp-2" });
  // Wrong per the operator: agent agreed with the prediction, Leo corrected it
  logIncident(db, { ...KEDB_FLAGS, "--fingerprint": "fp-3" });
  run(db, "correct", "--id", "3", "--verdict", "noise", "--by", "Leo");
  // Family match: no prediction
  logIncident(db, { "--kedb-match": "family", "--kedb-id": "falco/_family", "--kedb-rev": "a1b2c3d", "--fingerprint": "fp-4" });

  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^KEDB: 4 logged with a KEDB match field \| 3 exact \| 1 family only \| predictions right 1\/3 \| 1 corrected by an operator$/m);
  assert.match(result.stdout, /^ {2}- falco\/delete-or-rename-shell-history \| 2x \(real→(known_issue,real→noise|noise,real→known_issue)\)$/m);
});

test("briefing leaves the KEDB section out until an incident carries a KEDB field", () => {
  const db = scratchDb();
  logIncident(db);
  assert.doesNotMatch(run(db, "briefing").stdout, /KEDB/);
});

// -- Runbook proposals in the briefing (plan §4, "Timeouts") --

function writeProposals(db: string, proposals: unknown[], nextNumber = 10): void {
  writeFileSync(join(dirname(db), "kedb-proposals.json"), JSON.stringify({ version: 1, next_number: nextNumber, proposals }));
}

test("briefing lists the open runbook proposals, newest revision only", () => {
  const db = scratchDb();
  logIncident(db);
  const day = 24 * 60 * 60 * 1000;
  writeProposals(db, [
    sampleProposal({ rev: 1, status: "superseded", posted_at: Date.now() - 3 * day }),
    sampleProposal({ rev: 2, status: "pending", posted_at: Date.now() - 2 * day - 60_000, downgrade: { from: "page", to: "fyi", scope: ["x"] } }),
    sampleProposal({ id: "KB-2", status: "failed", status_reason: "git push failed\nremote: denied", posted_at: Date.now() - day - 60_000 }),
    sampleProposal({ id: "KB-3", status: "applied" }),
  ]);
  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Runbook proposals open \(2\); approvers answer them in their Slack threads:$/m);
  assert.match(result.stdout, /^ {2}- KB-1 rev 2 pending \(downgrade\): falco\/delete-or-rename-shell-history, incident #3501, 2d old$/m);
  assert.match(result.stdout, /^ {2}- KB-2 rev 1 failed: .*, retry with apply_runbook_update \(git push failed remote: denied\)$/m);
  assert.doesNotMatch(result.stdout, /KB-3/);
});

test("briefing says so when the proposal store is unreadable, and still succeeds", () => {
  const db = scratchDb();
  logIncident(db);
  writeFileSync(join(dirname(db), "kedb-proposals.json"), "{ not json");
  const result = run(db, "briefing");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Runbook proposals: .*kedb-proposals\.json is unreadable/m);
});

test("briefing has no proposal section when none is open or none was ever made", () => {
  const db = scratchDb();
  logIncident(db);
  assert.doesNotMatch(run(db, "briefing").stdout, /Runbook proposals/);
  writeProposals(db, [sampleProposal({ status: "applied" })]);
  assert.doesNotMatch(run(db, "briefing").stdout, /Runbook proposals/);
});

test("the day windows end at the exact time, not at the start of the bound's day", () => {
  // created_at is "YYYY-MM-DDTHH:MM:SSZ"; compared with datetime()'s "YYYY-MM-DD HH:MM:SS",
  // every row of the bound's day sorted as inside the window
  const db = scratchDb();
  assert.equal(logIncident(db).status, 0);
  assert.equal(logIncident(db, { "--fingerprint": "fp-old" }).status, 0);
  query(db, "UPDATE incidents SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-7 days', '-1 minute') WHERE id = 2;");

  const result = run(db, "briefing", "--days", "7");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Total: 1 alerts processed/);
});
