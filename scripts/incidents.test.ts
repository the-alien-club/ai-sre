// Tests for the incident memory CLI. Run with: npm test
//
// Arguments to incidents.sh come from alert labels and sub-agent output, so they are
// attacker-influenced. These tests drive the real script against a scratch database and
// check that hostile values are stored verbatim, never executed, and that the CLI surface
// the agent's prompts depend on still behaves the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
