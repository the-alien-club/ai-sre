// Tests for the escalation policy. Run with: npm test
//
// The fingerprints and names below are the ones the agent used for the Trivy escalations
// that nagged on 2026-10-26/27 (data/slack-escalations.json on the VM).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivyEscalation } from "./escalation-policy.js";

test("the Trivy escalations that nagged are recognised", () => {
  for (const [fingerprint, name] of [
    ["trivy-vuln-daemonset-falco-falco", "Trivy Vulnerability — Falco DaemonSet (platform-prod + platform-dev)"],
    ["trivy-secret-replicaset-54fb5b7648", "Trivy ExposedSecret — mcp-data-cluster:0.1.20 (likely false positive)"],
    ["fp-1234", "Trivy VulnerabilityReport — KEDA:2.16.1"],
    ["trivy_vuln_keda", "KEDA CVEs"],
  ]) {
    assert.equal(isTrivyEscalation(fingerprint, name), true, `${fingerprint} / ${name}`);
  }
});

test("ordinary alerts still escalate", () => {
  assert.equal(isTrivyEscalation("fp-skupper-gateway-prod", "ArgoCD App Degraded"), false);
  assert.equal(isTrivyEscalation("a1b2c3", "High Error Rate — trivyal-service"), false);
});
