// Tests for the agent's privileges as code. Run with: npm test
//
// The agent runs with --dangerously-skip-permissions, so its Kubernetes roles and sudo
// rights are the whole safety net. They are split so the write side can be withdrawn at
// the Rundeck cutover and restored by the rollback. These tests pin what each side may
// grant, so a write verb cannot creep back into the read role, and nothing CLAUDE.md
// forbids can be granted at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

interface Rule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

interface Manifest {
  kind: string;
  metadata: { name: string };
  rules?: Rule[];
  roleRef?: { name: string };
  subjects?: { kind: string; name: string; namespace: string }[];
}

function manifests(path: string): Manifest[] {
  return parseAllDocuments(readFileSync(path, "utf8")).map((doc) => doc.toJS() as Manifest);
}

/** Flatten a manifest's ClusterRole rules into "group/resource:verb" grants. */
function grants(path: string): string[] {
  return manifests(path)
    .filter((m) => m.kind === "ClusterRole")
    .flatMap((role) => role.rules ?? [])
    .flatMap((rule) =>
      rule.apiGroups.flatMap((group) =>
        rule.resources.flatMap((resource) => rule.verbs.map((verb) => `${group}/${resource}:${verb}`)),
      ),
    );
}

const READ_VERBS = new Set(["get", "list", "watch"]);

// visudo lives in sbin, which is often missing from a non-root PATH
const VISUDO = ["/usr/sbin/visudo", "/usr/bin/visudo"].find((path) => existsSync(path));

test("the read role grants no write verb", () => {
  const writes = grants("k8s/rbac.yaml").filter((grant) => !READ_VERBS.has(grant.split(":")[1]));
  assert.deepEqual(writes, []);
});

test("the write role grants exactly the four safe-op permissions", () => {
  assert.deepEqual(grants("k8s/rbac-write.yaml").sort(), [
    "/pods:delete",
    "apps/deployments:patch",
    "argoproj.io/applications:patch",
    "argoproj.io/workflows:delete",
  ]);
});

test("nothing CLAUDE.md forbids is granted by either role", () => {
  const all = [...grants("k8s/rbac.yaml"), ...grants("k8s/rbac-write.yaml")];
  const forbidden = all.filter((grant) => {
    const [target, verb] = grant.split(":");
    if (verb === "create" || verb === "update" || verb === "*") return true;
    if (verb !== "delete") return false;
    return ["argoproj.io/applications", "/namespaces", "/persistentvolumeclaims", "/secrets"].includes(target);
  });
  assert.deepEqual(forbidden, []);
});

test("the write binding targets the agent's ServiceAccount and the write role", () => {
  const binding = manifests("k8s/rbac-write.yaml").find((m) => m.kind === "ClusterRoleBinding");
  assert.ok(binding, "rbac-write.yaml must bind its role");
  assert.equal(binding.metadata.name, "sre-agent-write");
  assert.equal(binding.roleRef?.name, "sre-agent-write");
  assert.deepEqual(binding.subjects, [{ kind: "ServiceAccount", name: "sre-agent", namespace: "kube-system" }]);
});

test("the sudoers drop-in parses", { skip: VISUDO === undefined && "visudo not installed" }, () => {
  assert.ok(VISUDO);
  const result = spawnSync(VISUDO, ["-c", "-f", "provision/sudoers.d/sre-agent"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the sudoers drop-in grants only the sre-agent user", () => {
  const entries = readFileSync("provision/sudoers.d/sre-agent", "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
  assert.deepEqual(entries, ["sre-agent ALL=(ALL) NOPASSWD:ALL"]);
});

