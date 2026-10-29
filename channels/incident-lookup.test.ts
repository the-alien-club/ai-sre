// Tests for reading one incident from incidents.db, against a real database built with the
// real schema and incidents.sh. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIncidentLookup } from "./incident-lookup.js";

function database(): string {
  const db = join(mkdtempSync(join(tmpdir(), "sre-incident-lookup-")), "incidents.db");
  const log = (args: string[]) => {
    const result = spawnSync("bash", ["scripts/incidents.sh", "log", ...args], { env: { ...process.env, INCIDENTS_DB: db }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const base = ["--severity", "critical", "--verdict", "real", "--action", "escalated", "--cluster", "platform-prod"];
  log(["--alert", "Falco Suspicious Process", "--fingerprint", "2ecf15e3f8af5ccc", ...base]);
  log(["--alert", "Postgres Disk Above 85%", "--fingerprint", "9a8b7c6d5e4f3a2b", ...base]);
  log(["--alert", "Logged without a fingerprint", ...base]);
  return db;
}

test("finds an incident with the fingerprint it was logged with", async () => {
  const lookup = createIncidentLookup({ dbPath: database(), timeoutMs: 5_000 });
  const incident = await lookup.find("1");
  assert.equal(incident?.id, "1");
  assert.equal(incident?.fingerprint, "2ecf15e3f8af5ccc");
  assert.equal(incident?.alertName, "Falco Suspicious Process");
  assert.match(incident?.createdAt ?? "", /^\d{4}-\d\d-\d\dT/);
  assert.equal((await lookup.find("2"))?.fingerprint, "9a8b7c6d5e4f3a2b");
});

test("an incident logged without a fingerprint has a null one", async () => {
  const lookup = createIncidentLookup({ dbPath: database(), timeoutMs: 5_000 });
  assert.equal((await lookup.find("3"))?.fingerprint, null);
});

test("an unknown id is null, not an error", async () => {
  const lookup = createIncidentLookup({ dbPath: database(), timeoutMs: 5_000 });
  assert.equal(await lookup.find("999"), null);
});

test("an unreadable database throws, so the caller fails closed", async () => {
  const lookup = createIncidentLookup({ dbPath: join(tmpdir(), "no-such-dir-sre", "incidents.db"), timeoutMs: 5_000 });
  await assert.rejects(lookup.find("1"), /cannot read incidents\.db/);
});

test("an id that is not digits never reaches sqlite", async () => {
  const lookup = createIncidentLookup({ dbPath: database(), timeoutMs: 5_000, sqlite3: "/nonexistent/sqlite3" });
  await assert.rejects(lookup.find("1 OR 1=1"), /is not a number/);
});
