// Tests for which escalations the nag loop pokes, and how. Run with: npm test
//
// On 2026-10-30 42 escalations were waiting, several nagged 17-26 times in threads nobody
// followed. Warnings and info are no longer nagged in-thread (the daily digest lists them);
// critical ones still are, and in prod every Nth nag is broadcast to the channel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dueNag, isNagged, type NagSettings } from "./escalation-nag.js";
import type { Escalation } from "./escalation-store.js";

const MINUTE = 60 * 1000;
const T0 = Date.parse("2026-10-30T08:00:00Z");

const SETTINGS: NagSettings = {
  prodIntervalMs: 10 * MINUTE,
  nonProdIntervalMs: 60 * MINUTE,
  slackOnlyIntervalMs: 120 * MINUTE,
  maxAgentNags: 6,
  broadcastEvery: 3,
  operatorMentions: "<@U1> <@U2>",
};

function escalation(overrides: Partial<Escalation> = {}): Escalation {
  return {
    alertFingerprint: "50dcce6c3a7704e6",
    alertName: "Database Errors",
    severity: "critical",
    environment: "prod",
    slackThreadTs: "1790000001.000100",
    slackChannel: "C0TEAM",
    escalatedAt: T0,
    lastNagAt: T0,
    acknowledged: false,
    acknowledgedBy: undefined,
    nagCount: 0,
    superseded: false,
    earlierThreadTs: [],
    lastRequestedAt: T0,
    ...overrides,
  };
}

test("a critical prod escalation is nagged with mentions once its interval has passed", () => {
  assert.equal(dueNag(escalation(), T0 + 10 * MINUTE - 1, SETTINGS), undefined);

  const nag = dueNag(escalation(), T0 + 10 * MINUTE, SETTINGS);

  assert.ok(nag);
  assert.equal(nag.nagCount, 1);
  assert.equal(nag.minutesWaiting, 10);
  assert.match(nag.text, /STILL WAITING\* \(10 min\) <@U1> <@U2>/);
  assert.match(nag.text, /Nag #1\./);
  assert.equal(nag.broadcast, false);
  assert.equal(nag.notifyAgent, true);
  assert.equal(nag.finalAgentNag, false);
});

test("every third nag of a critical prod escalation is broadcast to the channel", () => {
  const broadcasts = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(
    (nagCount) => dueNag(escalation({ nagCount, lastNagAt: T0 - 1000 * MINUTE }), T0, SETTINGS)?.broadcast
  );
  assert.deepEqual(broadcasts, [false, false, true, false, false, true, false, false, true]);
});

test("warning and info escalations are never nagged in their thread", () => {
  for (const severity of ["warning", "info"] as const) {
    const waiting = escalation({ severity, lastNagAt: T0 - 48 * 60 * MINUTE });
    assert.equal(isNagged(waiting), false, severity);
    assert.equal(dueNag(waiting, T0, SETTINGS), undefined, severity);
  }
});

test("superseded, acknowledged and Trivy escalations are never nagged", () => {
  const overdue = { lastNagAt: T0 - 48 * 60 * MINUTE };
  for (const overrides of [{ superseded: true }, { acknowledged: true }, { alertFingerprint: "trivy-secret-abc" }]) {
    assert.equal(dueNag(escalation({ ...overrides, ...overdue }), T0, SETTINGS), undefined, JSON.stringify(overrides));
  }
});

test("dev and staging critical escalations nag hourly, without mentions or broadcasts", () => {
  for (const environment of ["dev", "staging"]) {
    assert.equal(dueNag(escalation({ environment }), T0 + 59 * MINUTE, SETTINGS), undefined, environment);
    const nag = dueNag(escalation({ environment, nagCount: 2 }), T0 + 60 * MINUTE, SETTINGS);
    assert.ok(nag, environment);
    assert.doesNotMatch(nag.text, /<@U1>/);
    assert.equal(nag.broadcast, false);
  }
});

test("past the agent's nag budget the agent is no longer told, and Slack nags slow down", () => {
  const atBudget = dueNag(escalation({ nagCount: 5 }), T0 + 10 * MINUTE, SETTINGS);
  assert.equal(atBudget?.finalAgentNag, true);
  assert.equal(atBudget?.notifyAgent, true);

  const exhausted = escalation({ nagCount: 6 });
  assert.equal(dueNag(exhausted, T0 + 119 * MINUTE, SETTINGS), undefined);
  const slow = dueNag(exhausted, T0 + 120 * MINUTE, SETTINGS);
  assert.equal(slow?.notifyAgent, false);
  assert.match(slow?.text ?? "", /Slack-only nag/);
});

test("dueNag changes nothing on the escalation", () => {
  const waiting = escalation();
  const before = structuredClone(waiting);
  dueNag(waiting, T0 + 60 * MINUTE, SETTINGS);
  assert.deepEqual(waiting, before);
});
