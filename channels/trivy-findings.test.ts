// Tests for the Trivy findings bookkeeping. Run with: npm test
//
// On 2026-10-26 every scanned image became its own escalation with mentions and nags, and the
// operator rescans daily. These pin the digest and dedupe that replace that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionableSecrets,
  buildDigest,
  createTrivyStore,
  emptyState,
  isDigestDue,
  isNewSecretFinding,
  markDigestSent,
  recordVulnerabilityReport,
  type VulnerabilityInput,
} from "./trivy-findings.js";

const NOW = Date.UTC(2026, 9, 27, 8, 0);
const DAY = 24 * 60 * 60 * 1000;

function report(overrides: Partial<VulnerabilityInput> = {}): VulnerabilityInput {
  return {
    artifact: { repository: "ns-data-streaming/backend", tag: "0.18.3", digest: "sha256:aaa" },
    namespace: "datastreaming-prod",
    workload: "backend-deployment",
    vulnerabilities: [
      { vulnerabilityID: "CVE-1", resource: "libssl3", installedVersion: "3.5.7", fixedVersion: "3.5.8", severity: "CRITICAL" },
      { vulnerabilityID: "CVE-2", resource: "busboy", installedVersion: "3.2.0", fixedVersion: "3.2.1", severity: "HIGH" },
      { vulnerabilityID: "CVE-3", resource: "faker", installedVersion: "9.9.0", severity: "CRITICAL" },
      { vulnerabilityID: "CVE-4", resource: "jq", installedVersion: "1.8.1", fixedVersion: "1.8.2", severity: "MEDIUM" },
    ],
    ...overrides,
  };
}

test("only fixable HIGH/CRITICAL findings are recorded", () => {
  const state = emptyState();
  const nothingActionable = report({
    vulnerabilities: [{ vulnerabilityID: "CVE-9", resource: "x", installedVersion: "1", severity: "CRITICAL" }],
  });

  assert.equal(recordVulnerabilityReport(state, nothingActionable, NOW), false);
  assert.deepEqual(state.images, {});

  assert.equal(recordVulnerabilityReport(state, report(), NOW), true);
  const [finding] = Object.values(state.images);
  assert.equal(finding.criticalCount, 1);
  assert.equal(finding.highCount, 1);
  assert.equal(finding.ownImage, true);
});

test("one image in several workloads is one finding", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  recordVulnerabilityReport(state, report({ namespace: "datastreaming-staging", workload: "backend-migrate" }), NOW);

  const findings = Object.values(state.images);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].namespaces, ["datastreaming-prod", "datastreaming-staging"]);
  assert.deepEqual(findings[0].workloads, ["backend-deployment", "backend-migrate"]);
});

test("a reported image stays silent on the next rescan", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);

  const first = buildDigest(state, NOW);
  assert.ok(first);
  assert.match(first.content, /ns-data-streaming\/backend:0\.18\.3/);
  markDigestSent(state, first.keys, NOW);

  recordVulnerabilityReport(state, report(), NOW + DAY);
  assert.equal(buildDigest(state, NOW + DAY), null);
});

test("an image comes back when it gets worse or is rebuilt", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  markDigestSent(state, buildDigest(state, NOW)!.keys, NOW);

  const worse = report();
  worse.vulnerabilities.push({
    vulnerabilityID: "CVE-5",
    resource: "openssl",
    installedVersion: "3.5.7",
    fixedVersion: "3.5.9",
    severity: "CRITICAL",
  });
  recordVulnerabilityReport(state, worse, NOW + DAY);
  assert.ok(buildDigest(state, NOW + DAY));
  markDigestSent(state, buildDigest(state, NOW + DAY)!.keys, NOW + DAY);

  recordVulnerabilityReport(state, report({ artifact: { repository: "ns-data-streaming/backend", tag: "0.18.3", digest: "sha256:bbb" } }), NOW + 2 * DAY);
  assert.ok(buildDigest(state, NOW + 2 * DAY));
});

test("our images are detailed, third-party ones grouped by namespace", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  recordVulnerabilityReport(
    state,
    report({ artifact: { repository: "kube-proxy", tag: "v1.35.8" }, namespace: "kube-system", workload: "kube-proxy" }),
    NOW
  );

  const digest = buildDigest(state, NOW)!;
  assert.match(digest.content, /Our images \(ns-data-streaming\), 1:/);
  assert.match(digest.content, /CRITICAL CVE-1 in libssl3@3\.5\.7 → 3\.5\.8/);
  assert.match(digest.content, /- kube-system: kube-proxy:v1\.35\.8 \(1C\/1H\)/);
  assert.equal(digest.meta.kind, "vulnerability-digest");
  assert.equal(digest.meta.severity, "info");
});

test("the digest is due once a day, after its hour", () => {
  const state = emptyState();
  const hour = 7;
  const beforeSlot = Date.UTC(2026, 9, 27, 6, 59);
  const afterSlot = Date.UTC(2026, 9, 27, 7, 0);

  assert.equal(isDigestDue(state, beforeSlot, hour), false);
  assert.equal(isDigestDue(state, afterSlot, hour), true);

  state.lastDigestAt = afterSlot;
  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 27, 23, 0), hour), false);
  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 28, 7, 0), hour), true);
});

test("images no longer scanned are dropped after 14 days", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);

  markDigestSent(state, [], NOW + 15 * DAY);
  assert.deepEqual(state.images, {});
});

test("an exposed secret alerts once per image and skips package metadata", () => {
  const state = emptyState();
  const artifact = { repository: "ns-data-streaming/mcp-data-cluster", tag: "0.1.20" };
  const secrets = [
    { ruleID: "jwt-token", target: "/app/.venv/lib/python3.11/site-packages/PyJWT-2.10.1.dist-info/METADATA" },
    { ruleID: "aws-access-key-id", target: "/app/config/settings.py" },
  ];

  const actionable = actionableSecrets(secrets);
  assert.deepEqual(actionable.map((s) => s.ruleID), ["aws-access-key-id"]);

  assert.equal(isNewSecretFinding(state, artifact, actionable, NOW), true);
  assert.equal(isNewSecretFinding(state, artifact, actionable, NOW + DAY), false);
  assert.equal(isNewSecretFinding(state, { ...artifact, tag: "0.1.21" }, actionable, NOW + DAY), true);
});

test("the state survives a restart and a corrupt file starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "sre-trivy-"));
  const path = join(dir, "trivy-findings.json");
  const store = createTrivyStore(path);

  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  state.lastDigestAt = NOW;
  store.save(state);
  assert.deepEqual(store.load(), state);

  writeFileSync(path, "{not json", "utf8");
  assert.deepEqual(store.load(), emptyState());
});
