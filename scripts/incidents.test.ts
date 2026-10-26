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

test("briefing and patterns still run with defaults", () => {
  const db = scratchDb();
  logIncident(db);
  assert.match(run(db, "briefing").stdout, /SRE Briefing — Last 7 Days/);
  assert.match(run(db, "patterns").stdout, /Recurring Alerts \(last 7 days\)/);
});
