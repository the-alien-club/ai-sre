// Tests for the daily digest of unacknowledged escalations. Run with: npm test
//
// Warnings are no longer nagged in their threads; this digest is their reminder. It must
// list only what is still waiting, never mention anyone, and go out once a day across the
// nightly restart.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDailySlotDue, parseHourUtc } from "./daily-slot.js";
import { buildEscalationDigest, createDigestClock, waitingEscalations } from "./escalation-digest.js";
import type { Escalation } from "./escalation-store.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-31T07:00:00Z");
const link = (channel: string, ts: string) => `https://alien.slack.com/archives/${channel}/p${ts.replace(".", "")}`;

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    alertFingerprint: "7f100f271c9afa3b",
    alertName: "Postgres Disk Above 85%",
    severity: "warning",
    environment: "prod",
    slackThreadTs: "1790000001.000100",
    slackChannel: "C0TEAM",
    escalatedAt: NOW - 27 * HOUR,
    lastNagAt: NOW - 27 * HOUR,
    acknowledged: false,
    acknowledgedBy: undefined,
    nagCount: 0,
    superseded: false,
    earlierThreadTs: [],
    lastRequestedAt: NOW - 27 * HOUR,
    ...overrides,
  };
}

test("the digest lists what is waiting, critical first then oldest first, each with its thread", () => {
  const text = buildEscalationDigest(
    [
      escalation({ alertFingerprint: "w-young", alertName: "Slow DB Queries", escalatedAt: NOW - 3 * HOUR }),
      escalation({ alertFingerprint: "w-old", alertName: "ArgoCD App Degraded", escalatedAt: NOW - 72 * HOUR }),
      escalation({ alertFingerprint: "c", alertName: "Database Errors", severity: "critical", escalatedAt: NOW - 2 * HOUR, slackThreadTs: "1790000009.000100" }),
    ],
    NOW,
    link
  );

  assert.ok(text);
  const lines = text.split("\n");
  assert.match(lines[0], /Unacknowledged escalations\* — 2026-10-31/);
  assert.match(lines[1], /^3 waiting/);
  const items = lines.filter((l) => l.startsWith("•"));
  assert.match(items[0], /Database Errors.*critical, waiting 2 h <https:\/\/alien\.slack\.com\/archives\/C0TEAM\/p1790000009000100\|thread>/);
  assert.match(items[1], /ArgoCD App Degraded.*warning, waiting 3 d/);
  assert.match(items[2], /Slow DB Queries.*waiting 3 h/);
});

test("acknowledged, superseded and Trivy escalations are left out, and nothing waiting posts nothing", () => {
  const done = [
    escalation({ alertFingerprint: "a", acknowledged: true }),
    escalation({ alertFingerprint: "b", superseded: true }),
    escalation({ alertFingerprint: "trivy-secret-1" }),
  ];
  assert.deepEqual(waitingEscalations(done), []);
  assert.equal(buildEscalationDigest(done, NOW, link), undefined);
});

test("the digest never mentions anyone, whatever the alert names say", () => {
  const text = buildEscalationDigest([escalation({ alertName: "<!channel> <@U054PDMV69X> pwn" })], NOW, link);
  assert.ok(text);
  assert.doesNotMatch(text, /<!channel>|<@U/);
  assert.match(text, /&lt;!channel&gt;/);
});

test("a long list is capped and the rest counted", () => {
  const many = Array.from({ length: 25 }, (_, i) => escalation({ alertFingerprint: `fp-${i}`, escalatedAt: NOW - (i + 1) * HOUR }));
  const text = buildEscalationDigest(many, NOW, link) ?? "";
  assert.equal(text.split("\n").filter((l) => l.startsWith("• ") && !l.includes("more")).length, 20);
  assert.match(text, /… and 5 more/);
});

test("the daily slot is due once its hour has come and nothing went out since", () => {
  const slot = Date.parse("2026-10-31T07:00:00Z");
  assert.equal(isDailySlotDue(0, slot - 1, 7), false, "before the hour");
  assert.equal(isDailySlotDue(0, slot, 7), true);
  assert.equal(isDailySlotDue(slot - 1, slot + HOUR, 7), true, "yesterday's run");
  assert.equal(isDailySlotDue(slot, slot + HOUR, 7), false, "already out today");
});

test("the digest hour must be an integer from 0 to 23", () => {
  assert.equal(parseHourUtc("ESCALATION_DIGEST_HOUR_UTC", "0"), 0);
  assert.equal(parseHourUtc("ESCALATION_DIGEST_HOUR_UTC", "23"), 23);
  for (const raw of ["", " ", "24", "-1", "7.5", "7am"]) {
    assert.throws(() => parseHourUtc("ESCALATION_DIGEST_HOUR_UTC", raw), /ESCALATION_DIGEST_HOUR_UTC must be an integer hour/, raw);
  }
});

test("the digest clock survives a restart, and a missing or corrupt file counts as never posted", () => {
  const dir = mkdtempSync(join(tmpdir(), "sre-digest-"));
  const path = join(dir, "slack-escalation-digest.json");

  assert.equal(createDigestClock(path).lastPostedAt(), 0);
  createDigestClock(path).markPosted(NOW);
  assert.equal(createDigestClock(path).lastPostedAt(), NOW);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { lastPostedAt: NOW });

  writeFileSync(path, "{ not json", "utf8");
  assert.equal(createDigestClock(path).lastPostedAt(), 0);
  writeFileSync(path, '{"lastPostedAt":"yesterday"}', "utf8");
  assert.equal(createDigestClock(path).lastPostedAt(), 0);
});
