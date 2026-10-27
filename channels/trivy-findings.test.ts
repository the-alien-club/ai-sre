// Tests for the Trivy findings bookkeeping. Run with: npm test
//
// On 2026-10-26/27 every scanned image became its own critical escalation (263 incidents in
// 14 hours), and the operator rescans daily. These pin the state behind the daily digest,
// the per-image Jira tickets and the once-only secret escalation that replace that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionableSecrets,
  createTrivyStore,
  digestSnapshot,
  emptyState,
  imagesForDigest,
  isDigestDue,
  isSecretReported,
  markDigestSent,
  markSecretReported,
  markTicketSynced,
  recordVulnerabilityReport,
  secretFingerprint,
  ticketUpdates,
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
      { vulnerabilityID: "CVE-4", resource: "jq", installedVersion: "1.8.1", fixedVersion: "1.8.2", severity: "MEDIUM" },
      { vulnerabilityID: "CVE-6", resource: "zlib", installedVersion: "1.3", severity: "low" },
    ],
    ...overrides,
  };
}

function withCve(id: string, severity = "CRITICAL"): VulnerabilityInput {
  const r = report();
  r.vulnerabilities.push({ vulnerabilityID: id, resource: "openssl", installedVersion: "3.5.7", fixedVersion: "3.5.9", severity });
  return r;
}

test("every severity is counted once per CVE and package, only fixable HIGH/CRITICAL are actionable", () => {
  const state = emptyState();
  assert.equal(recordVulnerabilityReport(state, report(), NOW), "recorded");

  const finding = state.images["ns-data-streaming/backend:0.18.3"];
  assert.deepEqual(finding.counts, { CRITICAL: 2, HIGH: 1, MEDIUM: 1, LOW: 1, UNKNOWN: 0 });
  assert.deepEqual(finding.actionable.map((c) => c.id), ["CVE-1", "CVE-2"]);
  assert.equal(finding.repository, "ns-data-streaming/backend");
  assert.equal(finding.ownImage, true);
});

test("an image with no CVE left is forgotten: it was fixed", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);

  assert.equal(recordVulnerabilityReport(state, report({ vulnerabilities: [] }), NOW + DAY), "clean");
  assert.deepEqual(state.images, {});
});

test("one image in several workloads is one finding; a rebuild starts its workloads afresh", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  recordVulnerabilityReport(state, report({ namespace: "datastreaming-staging", workload: "backend-migrate" }), NOW);

  const [finding] = Object.values(state.images);
  assert.equal(Object.keys(state.images).length, 1);
  assert.deepEqual(finding.namespaces, ["datastreaming-prod", "datastreaming-staging"]);
  assert.deepEqual(finding.workloads, ["backend-deployment", "backend-migrate"]);

  recordVulnerabilityReport(
    state,
    report({ artifact: { repository: "ns-data-streaming/backend", tag: "0.18.3", digest: "sha256:bbb" } }),
    NOW + DAY
  );
  assert.deepEqual(state.images["ns-data-streaming/backend:0.18.3"].workloads, ["backend-deployment"]);
});

test("a first digest marks every image as new; the next one marks only new CVEs", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);

  const [first] = imagesForDigest(state);
  assert.equal(first.isNewImage, true);
  markDigestSent(state, digestSnapshot(imagesForDigest(state)), NOW);

  recordVulnerabilityReport(state, report(), NOW + DAY);
  const [unchanged] = imagesForDigest(state);
  assert.equal(unchanged.isNewImage, false);
  assert.deepEqual(unchanged.newCves, []);

  recordVulnerabilityReport(state, withCve("CVE-5"), NOW + DAY);
  const [worse] = imagesForDigest(state);
  assert.deepEqual(worse.newCves.map((c) => c.id), ["CVE-5"]);
});

test("a report landing while a digest posts is not marked as shown", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  const snapshot = digestSnapshot(imagesForDigest(state));

  recordVulnerabilityReport(state, withCve("CVE-5"), NOW); // arrives mid-post
  markDigestSent(state, snapshot, NOW);

  assert.deepEqual(imagesForDigest(state)[0].newCves.map((c) => c.id), ["CVE-5"]);
});

test("images are listed worst first", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report({ artifact: { repository: "kube-proxy", tag: "v1" }, vulnerabilities: [] }), NOW);
  recordVulnerabilityReport(
    state,
    report({ artifact: { repository: "keda", tag: "2.16.1" }, vulnerabilities: report().vulnerabilities.slice(1, 2) }),
    NOW
  );
  recordVulnerabilityReport(state, report(), NOW);

  assert.deepEqual(imagesForDigest(state).map((i) => i.key), ["ns-data-streaming/backend:0.18.3", "keda:2.16.1"]);
});

test("the digest is due once a day, after its hour", () => {
  const state = emptyState();
  const hour = 7;

  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 27, 6, 59), hour), false);
  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 27, 7, 0), hour), true);

  state.lastDigestAt = Date.UTC(2026, 9, 27, 7, 0);
  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 27, 23, 0), hour), false);
  assert.equal(isDigestDue(state, Date.UTC(2026, 9, 28, 7, 0), hour), true);
});

test("images missing from three daily rescans are dropped, with their ticket bookkeeping", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  markTicketSynced(state, ticketUpdates(state)[0], "SDS-1");

  markDigestSent(state, {}, NOW + 2 * DAY);
  assert.equal(Object.keys(state.images).length, 1);

  markDigestSent(state, {}, NOW + 4 * DAY);
  assert.deepEqual(state.images, {});
  assert.deepEqual(state.jiraTickets, {});
});

test("one ticket update per repository across tags, then only when a CVE is new to it", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  recordVulnerabilityReport(state, report({ artifact: { repository: "ns-data-streaming/backend", tag: "0.18.2" } }), NOW);
  recordVulnerabilityReport(state, report({ artifact: { repository: "alpine", tag: "3" }, vulnerabilities: report().vulnerabilities.slice(3) }), NOW);

  const [update, ...rest] = ticketUpdates(state);
  assert.equal(rest.length, 0, "an image with nothing fixable gets no ticket");
  assert.equal(update.repository, "ns-data-streaming/backend");
  assert.deepEqual(update.images.map((i) => i.tag), ["0.18.2", "0.18.3"]);
  assert.deepEqual(update.newCves.map((c) => c.id), ["CVE-1", "CVE-2"]);

  markTicketSynced(state, update, "SDS-1");
  assert.deepEqual(ticketUpdates(state), []);

  recordVulnerabilityReport(state, withCve("CVE-5", "HIGH"), NOW + DAY);
  const [next] = ticketUpdates(state);
  assert.deepEqual(next.newCves.map((c) => c.id), ["CVE-5"]);
  assert.equal(next.cves.length, 3);
});

test("an exposed secret is reported once while rescans keep finding it, again only after a rebuild", () => {
  const state = emptyState();
  const artifact = { repository: "ns-data-streaming/mcp-data-cluster", tag: "0.1.20", digest: "sha256:aaa" };
  const secrets = actionableSecrets([
    { ruleID: "jwt-token", target: "/app/.venv/lib/python3.11/site-packages/PyJWT-2.10.1.dist-info/METADATA" },
    { ruleID: "aws-access-key-id", target: "/app/config/settings.py" },
  ]);
  assert.deepEqual(secrets.map((s) => s.ruleID), ["aws-access-key-id"]);

  const fingerprint = secretFingerprint(artifact, secrets);
  assert.equal(isSecretReported(state, fingerprint, NOW), false);
  markSecretReported(state, fingerprint, NOW);

  // Rescanned daily for two months: never forgotten, never re-paged
  for (let day = 1; day <= 60; day++) {
    assert.equal(isSecretReported(state, fingerprint, NOW + day * DAY), true);
  }

  const rebuilt = secretFingerprint({ ...artifact, digest: "sha256:bbb" }, secrets);
  assert.equal(isSecretReported(state, rebuilt, NOW + 60 * DAY), false);
});

test("a secret no rescan has found for 30 days is forgotten", () => {
  const state = emptyState();
  markSecretReported(state, "fp", NOW);
  assert.equal(isSecretReported(state, "fp", NOW + 31 * DAY), false);
});

function scratchStore() {
  const dir = mkdtempSync(join(tmpdir(), "sre-trivy-"));
  const path = join(dir, "trivy-findings.json");
  const logs: string[] = [];
  return { dir, path, logs, store: createTrivyStore({ path, now: () => NOW, log: (m) => logs.push(m) }) };
}

test("the state survives a restart", () => {
  const { store } = scratchStore();
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  markSecretReported(state, "fp", NOW);
  markTicketSynced(state, ticketUpdates(state)[0], "SDS-1");
  state.lastDigestAt = NOW;

  store.save(state);
  assert.deepEqual(store.load(), state);
});

test("a missing file is a first run", () => {
  const { store, logs } = scratchStore();
  assert.deepEqual(store.load(), emptyState());
  assert.deepEqual(logs, []);
});

for (const [name, content] of [
  ["corrupt", "{not json"],
  ["outdated (version 1)", JSON.stringify({ images: {}, secretsSeen: {}, lastDigestAt: 0 })],
]) {
  test(`a ${name} file is moved aside, logged, and never overwritten`, () => {
    const { dir, path, store, logs } = scratchStore();
    writeFileSync(path, content, "utf8");

    assert.deepEqual(store.load(), emptyState());
    assert.equal(existsSync(path), false);
    assert.deepEqual(readdirSync(dir), [`trivy-findings.json.corrupt-${NOW}`]);
    assert.match(logs.join("\n"), /moved to .*corrupt-/);
  });
}

test("a malformed image is dropped and logged, the rest is kept", () => {
  const { path, store, logs } = scratchStore();
  const state = emptyState();
  recordVulnerabilityReport(state, report(), NOW);
  writeFileSync(path, JSON.stringify({ ...state, images: { ...state.images, broken: { repository: 1 } } }), "utf8");

  assert.deepEqual(Object.keys(store.load().images), ["ns-data-streaming/backend:0.18.3"]);
  assert.match(logs.join("\n"), /dropped 1 malformed image/);
});

test("a failed write throws rather than pretending the state is safe", () => {
  const { dir } = scratchStore();
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "", "utf8");
  const store = createTrivyStore({ path: join(blocker, "trivy-findings.json") });

  assert.throws(() => store.save(emptyState()), /failed to persist/);
});
