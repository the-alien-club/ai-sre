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
  escalationsForThread,
  SUPERSEDE_AFTER_MS,
  supersedeOlderThan,
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
    superseded: false,
    earlierThreadTs: [],
    lastRequestedAt: 1_790_056_749_000,
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

test("a record written before 0.10.0 loads as live, with no earlier threads, last requested when posted", () => {
  const path = scratchPath();
  const legacy: Record<string, unknown> = { ...escalation() };
  delete legacy.superseded;
  delete legacy.earlierThreadTs;
  delete legacy.lastRequestedAt;
  writeFileSync(path, JSON.stringify([legacy]), "utf8");

  const restored = createEscalationStore({ path, now: () => 1_790_057_349_000 }).load();

  assert.deepEqual(restored.get("fp-skupper-gateway-prod"), escalation({ lastRequestedAt: 1_790_056_749_000 }));
  rmSync(path, { force: true });
});

test("the superseded state and earlier threads survive a round-trip", () => {
  const path = scratchPath();
  const store = createEscalationStore({ path, now: () => 1_790_057_349_000 });
  const saved = escalation({ superseded: true, earlierThreadTs: ["1790000000.000100"], lastRequestedAt: 1_790_057_000_000 });

  store.save(new Map([["fp-skupper-gateway-prod", saved]]));

  assert.deepEqual(store.load().get("fp-skupper-gateway-prod"), saved);
  rmSync(path, { force: true });
});

test("a record with an unknown severity or a malformed new field is dropped", () => {
  const path = scratchPath();
  writeFileSync(
    path,
    JSON.stringify([
      { ...escalation({ alertFingerprint: "fp-page" }), severity: "page" },
      { ...escalation({ alertFingerprint: "fp-threads" }), earlierThreadTs: [42] },
      { ...escalation({ alertFingerprint: "fp-superseded" }), superseded: "yes" },
      escalation({ alertFingerprint: "fp-good" }),
    ]),
    "utf8"
  );

  const restored = createEscalationStore({ path, now: () => 1_790_057_349_000 }).load();

  assert.deepEqual([...restored.keys()], ["fp-good"]);
  rmSync(path, { force: true });
});

test("the startup step supersedes escalations older than a day, once, and leaves the rest live", () => {
  const now = 1_790_100_000_000;
  const escalations = new Map([
    ["old", escalation({ alertFingerprint: "old", escalatedAt: now - SUPERSEDE_AFTER_MS - 1 })],
    ["old-acked", escalation({ alertFingerprint: "old-acked", escalatedAt: now - 3 * SUPERSEDE_AFTER_MS, acknowledged: true })],
    ["young", escalation({ alertFingerprint: "young", escalatedAt: now - SUPERSEDE_AFTER_MS + 1 })],
  ]);

  assert.equal(supersedeOlderThan(escalations, now, SUPERSEDE_AFTER_MS), 2);
  assert.equal(supersedeOlderThan(escalations, now, SUPERSEDE_AFTER_MS), 0, "idempotent");

  assert.equal(escalations.get("old")?.superseded, true);
  assert.equal(escalations.get("old-acked")?.superseded, true);
  assert.equal(escalations.get("young")?.superseded, false);
  // Nothing else about them changes: a reply in their thread still acknowledges
  assert.equal(escalations.get("old")?.nagCount, 3);
});

test("a reply acknowledges the escalation posted in its thread and the one that re-paged it", () => {
  const live = escalation({ alertFingerprint: "fp-live", slackThreadTs: "1790000002.000100", earlierThreadTs: ["1790000001.000100"] });
  const other = escalation({ alertFingerprint: "fp-other", slackThreadTs: "1790000003.000100" });
  const escalations = new Map([
    ["fp-live", live],
    ["fp-other", other],
  ]);

  assert.deepEqual(escalationsForThread(escalations, "1790000001.000100"), [live]);
  assert.deepEqual(escalationsForThread(escalations, "1790000002.000100"), [live]);
  assert.deepEqual(escalationsForThread(escalations, "1790000003.000100"), [other]);
  assert.deepEqual(escalationsForThread(escalations, "1790000009.000100"), []);
});
