// Tests for the watchdog restarts GET /health/session reports. Run with: npm test
//
// Sentinel's `sre_agent` hop reads /health/session's status and `age_seconds`: the restart
// fields are added to the body and must never change either. The record is written by
// scripts/session-watchdog.sh; a missing one means no restart, a broken one is visible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionHealth } from "./session-heartbeat.js";
import { createWatchdogRestartsReader, withWatchdogRestarts } from "./watchdog-restarts.js";

const NOW = Date.parse("2026-10-28T10:00:00Z");

function reader(content?: string) {
  const path = join(mkdtempSync(join(tmpdir(), "sre-watchdog-record-")), "last_restart");
  if (content !== undefined) writeFileSync(path, content);
  const logs: string[] = [];
  const read = createWatchdogRestartsReader({ path, now: () => NOW, log: (line) => logs.push(line) });
  return { read, logs, path };
}

test("no record means no restart, and nothing is logged", async () => {
  const r = reader();

  assert.deepEqual(await r.read(), { last_restart_at: null, restarts_last_hour: 0 });
  assert.deepEqual(r.logs, []);
});

test("the record's last restart is reported, and only restarts of the last hour are counted", async () => {
  const r = reader(
    JSON.stringify({
      last_restart_at: "2026-10-28T09:50:00Z",
      restarts_last_hour: 2,
      restarts: ["2026-10-28T09:00:00Z", "2026-10-28T09:50:00Z"],
    })
  );

  // 09:00 is exactly an hour old at 10:00 and no longer counts
  assert.deepEqual(await r.read(), { last_restart_at: "2026-10-28T09:50:00Z", restarts_last_hour: 1 });
});

test("a record whose restarts are all older than an hour counts none, but keeps the last one", async () => {
  const r = reader('{"last_restart_at":"2026-10-28T07:00:00Z","restarts_last_hour":1,"restarts":["2026-10-28T07:00:00Z"]}\n');

  assert.deepEqual(await r.read(), { last_restart_at: "2026-10-28T07:00:00Z", restarts_last_hour: 0 });
});

test("a malformed record is logged and reported as unknown, never as zero", async () => {
  for (const content of ["{not json", '{"last_restart_at":"yesterday","restarts_last_hour":1,"restarts":[]}', '{"last_restart_at":"2026-10-28T09:50:00Z"}']) {
    const r = reader(content);

    assert.deepEqual(await r.read(), { last_restart_at: null, restarts_last_hour: null });
    assert.equal(r.logs.length, 1);
    assert.match(r.logs[0], /\[signoz-webhook\] the watchdog's restart record .*last_restart is malformed/);
  }
});

test("an unreadable record is logged and reported as unknown", async () => {
  // A directory where the file should be: readFile fails with EISDIR, not ENOENT
  const dir = mkdtempSync(join(tmpdir(), "sre-watchdog-record-"));
  const logs: string[] = [];
  const read = createWatchdogRestartsReader({ path: dir, now: () => NOW, log: (line) => logs.push(line) });

  assert.deepEqual(await read(), { last_restart_at: null, restarts_last_hour: null });
  assert.match(logs[0], /could not read the watchdog's restart record/);
});

test("the restart fields are added to /health/session without changing its status or fields", () => {
  const common = { max_age_seconds: 720, heartbeat_interval_seconds: 300 };
  const healths: SessionHealth[] = [
    { httpStatus: 200, body: { status: "ok", last_ack_at: "2026-10-28T09:58:00.000Z", age_seconds: 120, ...common } },
    { httpStatus: 503, body: { status: "stale", last_ack_at: "2026-10-28T09:40:00.000Z", age_seconds: 1200, ...common } },
    { httpStatus: 503, body: { status: "never_acked", last_ack_at: null, age_seconds: null, ...common } },
  ];
  const restarts = { last_restart_at: "2026-10-28T09:50:00Z", restarts_last_hour: 1 };

  for (const health of healths) {
    const answer = withWatchdogRestarts(health, restarts);
    assert.equal(answer.httpStatus, health.httpStatus);
    assert.deepEqual(answer.body, { ...health.body, ...restarts });
  }
});
