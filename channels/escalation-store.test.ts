// Tests for escalation persistence. Run with: npm test
//
// The point of this store is that an unacknowledged critical alert keeps nagging across
// the nightly `pm2 restart`. A round-trip that loses the nag count, or a corrupt file that
// stops the channel from starting, both put the team back where they were.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEscalationStore,
  type Escalation,
} from "./escalation-store.js";

function scratchPath(name = "slack-escalations.json"): string {
  return join(mkdtempSync(join(tmpdir(), "sre-escalation-")), name);
}

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    alertFingerprint: "fp-skupper-gateway-prod",
    alertName: "ArgoCD App Degraded",
    severity: "critical",
    environment: "prod",
    slackThreadTs: "1790056749.088479",
    slackChannel: "C09MWNB6WL8",
    escalatedAt: 1_790_056_749_000,
    lastNagAt: 1_790_057_349_000,
    acknowledged: false,
    acknowledgedBy: undefined,
    nagCount: 3,
    ...overrides,
  };
}

test("an escalation survives a save/load round-trip", () => {
  const path = scratchPath();
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });

  const saved = new Map([["fp-skupper-gateway-prod", escalation()]]);
  store.save(saved);

  const restored = store.load();
  assert.equal(restored.size, 1);
  assert.deepEqual(restored.get("fp-skupper-gateway-prod"), escalation());

  rmSync(path, { force: true });
});

test("acknowledgement state survives, so an answered alert is not re-nagged", () => {
  const path = scratchPath();
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });

  store.save(
    new Map([
      [
        "fp-1",
        escalation({
          alertFingerprint: "fp-1",
          acknowledged: true,
          acknowledgedBy: "Leo",
        }),
      ],
    ])
  );

  const restored = store.load().get("fp-1");
  assert.equal(restored?.acknowledged, true);
  assert.equal(restored?.acknowledgedBy, "Leo");

  rmSync(path, { force: true });
});

test("a missing file loads as empty", () => {
  const store = createEscalationStore({ path: scratchPath("absent.json") });
  assert.equal(store.load().size, 0);
});

test("a corrupt file loads as empty rather than throwing", () => {
  // Refusing to start would take the agent's whole Slack channel offline over a
  // bookkeeping file. Losing nag timers is the lesser failure.
  const path = scratchPath();
  writeFileSync(path, "{ this is not json", "utf8");

  const store = createEscalationStore({ path });
  assert.equal(store.load().size, 0);

  rmSync(path, { force: true });
});

test("a JSON file of the wrong shape loads as empty", () => {
  const path = scratchPath();
  writeFileSync(path, '{"not":"an array"}', "utf8");

  const store = createEscalationStore({ path });
  assert.equal(store.load().size, 0);

  rmSync(path, { force: true });
});

test("malformed entries are dropped and valid siblings survive", () => {
  const path = scratchPath();
  writeFileSync(
    path,
    JSON.stringify([{ alertFingerprint: "fp-broken" }, escalation()]),
    "utf8"
  );

  const restored = createEscalationStore({
    path,
    now: () => 1_790_057_349_000,
  }).load();

  assert.equal(restored.size, 1);
  assert.ok(restored.has("fp-skupper-gateway-prod"));

  rmSync(path, { force: true });
});

test("entries older than the max age are dropped on load", () => {
  // Nothing should be able to nag the team forever because a fingerprint was never
  // resolved.
  const path = scratchPath();
  const store = createEscalationStore({
    path,
    maxAgeMs: 1000,
    now: () => 1_790_056_749_000,
  });

  store.save(
    new Map([
      ["fresh", escalation({ alertFingerprint: "fresh", escalatedAt: 1_790_056_748_500 })],
      ["stale", escalation({ alertFingerprint: "stale", escalatedAt: 1_790_000_000_000 })],
    ])
  );

  const restored = store.load();
  assert.deepEqual([...restored.keys()], ["fresh"]);

  rmSync(path, { force: true });
});

test("saving an empty map clears the file", () => {
  const path = scratchPath();
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });

  store.save(new Map([["fp-1", escalation({ alertFingerprint: "fp-1" })]]));
  store.save(new Map());

  assert.equal(store.load().size, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), []);

  rmSync(path, { force: true });
});

test("saving creates a missing data directory", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "sre-escalation-")),
    "nested",
    "deeper",
    "slack-escalations.json"
  );
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });

  store.save(new Map([["fp-1", escalation({ alertFingerprint: "fp-1" })]]));

  assert.equal(store.load().size, 1);
});

test("a save leaves no temp file behind", () => {
  const path = scratchPath();
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });

  store.save(new Map([["fp-1", escalation({ alertFingerprint: "fp-1" })]]));

  assert.throws(() => readFileSync(`${path}.tmp`, "utf8"));

  rmSync(path, { force: true });
});
