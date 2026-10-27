// Tests for the escalation policy. Run with: npm test
//
// The fingerprints below are the ones the agent used for the Trivy escalations that nagged
// on 2026-10-26/27 (all 16 in data/slack-escalations.json on the VM start with trivy-).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTrivyEscalation } from "./escalation-policy.js";

test("the Trivy escalations that nagged are recognised by fingerprint", () => {
  for (const fingerprint of [
    "trivy-vuln-daemonset-falco-falco",
    "trivy-vuln-job-backend-migrate-0-18-3-migrate",
    "trivy-secret-replicaset-54fb5b7648",
  ]) {
    assert.equal(isTrivyEscalation(fingerprint), true, fingerprint);
  }
});

test("alerts about Trivy itself, and ordinary alerts, still escalate", () => {
  // e.g. "KubePodCrashLooping trivy-system/trivy-operator": secret detection is down
  assert.equal(isTrivyEscalation("a1b2c3d4e5"), false);
  assert.equal(isTrivyEscalation("fp-trivy-operator-crashloop"), false);
  assert.equal(isTrivyEscalation("fp-skupper-gateway-prod"), false);
});
