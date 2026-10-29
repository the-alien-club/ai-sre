// Tests for raw alert payload retention. Run with: npm test
//
// The store keeps what the learning loop will compare proposals against, and must never cost
// an alert its delivery: it never rejects, bounds its disk use and hides payloads from others.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlertmanagerAlert } from "./alert-delivery.js";
import { createAlertPayloadStore, fingerprintDir } from "./alert-payload-store.js";

const NOW = Date.UTC(2026, 9, 29, 10, 0);
const DAY = 24 * 60 * 60 * 1000;

function scratchDir(): string {
  return join(mkdtempSync(join(tmpdir(), "sre-payloads-")), "alert-payloads");
}

function alert(fingerprint = "2ecf15e3f8af5ccc"): AlertmanagerAlert {
  return {
    status: "firing",
    labels: { alertname: "Falco Suspicious Process", rule: "Delete or rename shell history" },
    annotations: { summary: "s" },
    startsAt: "2026-10-28T15:25:00Z",
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint,
  };
}

test("a pushed alert is kept verbatim, readable only by its owner", async () => {
  const dir = scratchDir();
  await createAlertPayloadStore({ dir, now: () => NOW, log: () => {} }).retain(alert(), "firing");

  const fpDir = join(dir, "2ecf15e3f8af5ccc");
  const [name] = readdirSync(fpDir);
  assert.match(name, /^\d+-\d{3}-firing\.json$/);
  const record = JSON.parse(readFileSync(join(fpDir, name), "utf8"));
  assert.deepEqual(record, { received_at: new Date(NOW).toISOString(), group_status: "firing", alert: alert() });
  assert.equal(statSync(join(fpDir, name)).mode & 0o777, 0o600);
  assert.equal(statSync(fpDir).mode & 0o777, 0o700);
});

test("two copies received in the same millisecond are both kept", async () => {
  const dir = scratchDir();
  const store = createAlertPayloadStore({ dir, now: () => NOW, log: () => {} });
  await store.retain(alert(), "firing");
  await store.retain(alert(), "firing");
  assert.equal(readdirSync(join(dir, "2ecf15e3f8af5ccc")).length, 2);
});

test("a fingerprint that is not a plain token never names a path", async () => {
  for (const hostile of ["../../.ssh", "a/b", "", "x".repeat(200)]) {
    assert.match(fingerprintDir(hostile), /^h-[0-9a-f]{32}$/, hostile);
  }
  assert.equal(fingerprintDir("abc_DEF-123"), "abc_DEF-123");

  const dir = scratchDir();
  await createAlertPayloadStore({ dir, now: () => NOW, log: () => {} }).retain(alert("../../escape"), "firing");
  assert.deepEqual(readdirSync(dir).map((d) => d.startsWith("h-")), [true]);
  assert.equal(existsSync(join(dir, "..", "..", "escape")), false);
});

test("pruning deletes payloads older than 7 days and their empty directories", async () => {
  const dir = scratchDir();
  const store = createAlertPayloadStore({ dir, now: () => NOW, log: () => {} });
  await store.retain(alert("old"), "firing");
  await store.retain(alert("new"), "firing");
  // retain() started a prune in the background: let it finish before ageing the file
  await store.prune();
  const oldFile = join(dir, "old", readdirSync(join(dir, "old"))[0]);
  utimesSync(oldFile, (NOW - 8 * DAY) / 1000, (NOW - 8 * DAY) / 1000);
  await store.prune();
  assert.deepEqual(readdirSync(dir), ["new"]);
});

test("beyond the file cap the oldest payloads go first, whatever their age", async () => {
  const dir = scratchDir();
  const logs: string[] = [];
  const store = createAlertPayloadStore({ dir, now: () => NOW, maxFiles: 2, log: (l) => logs.push(l) });
  for (const [i, fp] of ["a", "b", "c"].entries()) {
    mkdirSync(join(dir, fp), { recursive: true });
    const path = join(dir, fp, `${i}.json`);
    writeFileSync(path, "{}");
    utimesSync(path, (NOW - (3 - i) * 60_000) / 1000, (NOW - (3 - i) * 60_000) / 1000);
  }
  await store.prune();
  assert.equal(existsSync(join(dir, "a", "0.json")), false);
  assert.equal(existsSync(join(dir, "b", "1.json")), true);
  assert.equal(existsSync(join(dir, "c", "2.json")), true);
  assert.match(logs.join("\n"), /over the 2-file cap: deleted the 1 oldest/);
});

test("an unwritable directory is logged, never thrown", async () => {
  const parent = mkdtempSync(join(tmpdir(), "sre-payloads-"));
  chmodSync(parent, 0o500);
  const logs: string[] = [];
  const store = createAlertPayloadStore({ dir: join(parent, "alert-payloads"), now: () => NOW, log: (l) => logs.push(l) });
  await store.retain(alert(), "firing");
  chmodSync(parent, 0o700);
  if (process.getuid?.() === 0) return; // root writes anyway; nothing to assert
  assert.match(logs.join("\n"), /could not keep the payload of "2ecf15e3f8af5ccc"/);
  assert.doesNotMatch(logs.join("\n"), /Delete or rename/, "the payload itself is never logged");
});
