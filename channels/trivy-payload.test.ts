// Tests for Trivy payload validation. Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeIssues, ExposedSecretReportPayload, VulnerabilityReportPayload, workloadOf } from "./trivy-payload.js";

const metadata = { name: "replicaset-backend-abc", namespace: "prod", labels: { "trivy-operator.resource.name": "backend" } };

test("a well-formed report passes, extra fields dropped, a missing list is empty", () => {
  const parsed = VulnerabilityReportPayload.parse({
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "VulnerabilityReport",
    metadata,
    report: { artifact: { repository: "ns-data-streaming/backend", tag: "1" }, summary: { criticalCount: 0 } },
  });

  assert.deepEqual(parsed.report.vulnerabilities, []);
  assert.equal(workloadOf(parsed.metadata), "backend");
});

for (const [name, payload, path] of [
  ["no report", { kind: "VulnerabilityReport", metadata }, /report: Required/],
  [
    "a CVE without severity",
    {
      kind: "VulnerabilityReport",
      metadata,
      report: { artifact: { repository: "r" }, vulnerabilities: [{ vulnerabilityID: "CVE-1", resource: "x", installedVersion: "1" }] },
    },
    /report\.vulnerabilities\.0\.severity: Required/,
  ],
  ["no repository", { kind: "VulnerabilityReport", metadata, report: { artifact: {} } }, /report\.artifact\.repository/],
] as const) {
  test(`a vulnerability report with ${name} is rejected with a readable reason`, () => {
    const result = VulnerabilityReportPayload.safeParse(payload);
    assert.equal(result.success, false);
    if (!result.success) assert.match(describeIssues(result.error), path);
  });
}

test("an exposed-secret report without metadata is rejected", () => {
  const result = ExposedSecretReportPayload.safeParse({ kind: "ExposedSecretReport", report: { artifact: { repository: "r" } } });
  assert.equal(result.success, false);
  if (!result.success) assert.match(describeIssues(result.error), /metadata: Required/);
});
