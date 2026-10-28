// Tests for remediation persistence. Run with: npm test
//
// The record is what keeps a remediable alert from starting a second Rundeck run after the
// nightly `pm2 restart`. A round-trip that loses it, or a corrupt file that stops the channel
// from starting, would each break that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemediationStore, type RemediationRecord } from "./remediation-store.js";

const NOW = Date.UTC(2026, 9, 28, 9, 0);
const DAY = 24 * 60 * 60 * 1000;

function scratchPath(): string {
  return join(mkdtempSync(join(tmpdir(), "sre-remediation-")), "sentinel-remediations.json");
}

function record(overrides: Partial<RemediationRecord> = {}): RemediationRecord {
  return {
    fingerprint: "0123456789abcdef",
    startsAt: "2026-10-28T08:40:00Z",
    alertName: "Remediable: otel_agent",
    action: "restart_otel_agent_pod",
    target: "platform-prod/signoz/signoz-k8s-infra-otel-agent",
    claimedAt: NOW,
    outcome: "started",
    executionId: 42,
    executionUrl: "http://10.66.0.1:30440/project/sentinel/execution/show/42",
    detail: undefined,
    ...overrides,
  };
}

test("a record survives a save/load round-trip, optional fields included", () => {
  const path = scratchPath();
  const store = createRemediationStore({ path, now: () => NOW });
  const refused = record({ fingerprint: "fedcba9876543210", outcome: "refused", executionId: undefined, executionUrl: undefined, detail: "cooldown" });

  store.save(new Map([[record().fingerprint, record()], [refused.fingerprint, refused]]));

  const restored = store.load();
  assert.deepEqual(restored.get(record().fingerprint), record());
  assert.deepEqual(restored.get(refused.fingerprint), refused);
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("a missing file is an empty start", () => {
  assert.equal(createRemediationStore({ path: scratchPath() }).load().size, 0);
});

test("a corrupt or wrongly shaped file is an empty start, not a crash", () => {
  for (const content of ["{not json", '{"fingerprint":"x"}']) {
    const path = scratchPath();
    writeFileSync(path, content);
    assert.equal(createRemediationStore({ path }).load().size, 0);
  }
});

test("stale and malformed records are dropped on load, the rest kept", () => {
  const path = scratchPath();
  writeFileSync(
    path,
    JSON.stringify([
      record(),
      record({ fingerprint: "old", claimedAt: NOW - 31 * DAY }),
      { ...record({ fingerprint: "bad" }), outcome: "retrying" },
      { ...record({ fingerprint: "bad2" }), executionId: "42" },
    ])
  );

  const restored = createRemediationStore({ path, now: () => NOW }).load();
  assert.deepEqual([...restored.keys()], [record().fingerprint]);
});

test("a failed write throws, so the caller can refuse to run unrecorded", () => {
  const blocker = scratchPath();
  writeFileSync(blocker, "a file where the directory should be");
  const store = createRemediationStore({ path: join(blocker, "sentinel-remediations.json") });

  assert.throws(() => store.save(new Map([[record().fingerprint, record()]])), /failed to persist/);
});

test("the file is a plain JSON array an operator can read", () => {
  const path = scratchPath();
  createRemediationStore({ path }).save(new Map([[record().fingerprint, record()]]));
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Array.isArray(onDisk));
  assert.equal(onDisk[0].executionId, 42);
});
