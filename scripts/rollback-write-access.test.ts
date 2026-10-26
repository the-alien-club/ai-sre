// Tests for the write-access rollback. Run with: npm test
//
// The rollback is the safety net for the Rundeck cutover, so it has to work the first
// time it is needed, and it must never touch a cluster or the VM while being tested. Each
// test builds a throwaway git repo holding the files the script reads, and puts recording
// stubs for kubectl, ssh, scp and id first on PATH. The stubs log their arguments and do
// nothing else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const FILES = [
  "scripts/rollback-write-access.sh",
  "k8s/rbac-write.yaml",
  "provision/sudoers.d/sre-agent",
];
const PRE_CUTOVER_CLAUDE_MD = "# runbook as it was before the cutover\n";
const ALL_CONTEXTS = ["platform-dev", "platform-prod", "data-cluster-dev", "data-cluster-biorxiv", "data-cluster-alien-hosted"];

interface Sandbox {
  repo: string;
  log: string;
  captured: string;
  env: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

/** A stub that appends its name and arguments to the log; `failOn` makes it exit 1 when its arguments contain that text. */
function stub(bin: string, name: string, log: string, body = "") {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\nexit 0\n`);
  chmodSync(path, 0o755);
}

function sandbox(options: { tag?: boolean; failKubectlOn?: string; user?: string } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "sre-rollback-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const captured = join(root, "captured");
  mkdirSync(bin);
  mkdirSync(captured);
  writeFileSync(log, "");

  for (const file of FILES) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(file, join(repo, file));
  }
  writeFileSync(join(repo, "CLAUDE.md"), PRE_CUTOVER_CLAUDE_MD);
  git(repo, "init", "-q");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "pre-cutover");
  if (options.tag !== false) git(repo, "tag", "pre-cutover");
  // The working tree moves on after the tag; the rollback must restore the tagged runbook.
  writeFileSync(join(repo, "CLAUDE.md"), "# runbook after the cutover\n");

  const failOn = options.failKubectlOn;
  stub(bin, "kubectl", log, failOn ? `[[ "$*" == *"${failOn}"* ]] && exit 1` : "");
  stub(bin, "ssh", log);
  // scp copies the source to the capture dir, so the test can see what would be deployed
  stub(bin, "scp", log, `cp "$1" "${captured}/$(basename "$1")"`);
  stub(bin, "id", log, `echo "${options.user ?? "operator"}"`);

  return { repo, log, captured, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function rollback(box: Sandbox, ...args: string[]) {
  return spawnSync("bash", ["scripts/rollback-write-access.sh", ...args], { cwd: box.repo, env: box.env, encoding: "utf8" });
}

function calls(box: Sandbox): string[] {
  return readFileSync(box.log, "utf8").split("\n").filter((line) => line && !line.startsWith("id "));
}

test("restores RBAC on every context, then sudo, then the runbook, then restarts", () => {
  const box = sandbox();
  const result = rollback(box, "--vm", "203.0.113.7", "--yes");
  assert.equal(result.status, 0, result.stderr);

  const log = calls(box);
  assert.deepEqual(
    log.slice(0, 5),
    ALL_CONTEXTS.map((ctx) => `kubectl --context ${ctx} apply -f k8s/rbac-write.yaml`),
  );
  assert.equal(log[5], "scp provision/sudoers.d/sre-agent root@203.0.113.7:/tmp/sre-agent.sudoers");
  assert.match(log[6], /^ssh root@203\.0\.113\.7 visudo -c -f \/tmp\/sre-agent\.sudoers .*install -m 0440 .*usermod -aG sudo sre-agent$/);
  assert.match(log[7], /^scp \S+ sre-agent@203\.0\.113\.7:\/home\/sre-agent\/sre-agent\/CLAUDE\.md$/);
  assert.equal(log[8], "ssh sre-agent@203.0.113.7 pm2 restart sre-agent");
  assert.equal(log.length, 9);
});

test("deploys the CLAUDE.md tagged pre-cutover, not the working tree", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes").status, 0);
  const deployed = readFileSync(join(box.captured, readCapturedName(box)), "utf8");
  assert.equal(deployed, PRE_CUTOVER_CLAUDE_MD);
});

test("deploys the sudoers drop-in from the repo", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes").status, 0);
  assert.equal(readFileSync(join(box.captured, "sre-agent"), "utf8"), readFileSync("provision/sudoers.d/sre-agent", "utf8"));
});

test("--contexts limits the RBAC step", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes", "--contexts", "data-cluster-dev").status, 0);
  const kubectl = calls(box).filter((line) => line.startsWith("kubectl"));
  assert.deepEqual(kubectl, ["kubectl --context data-cluster-dev apply -f k8s/rbac-write.yaml"]);
});

test("stops at the first failure and touches nothing after it", () => {
  const box = sandbox({ failKubectlOn: "platform-prod" });
  const result = rollback(box, "--vm", "vm", "--yes");
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls(box), [
    "kubectl --context platform-dev apply -f k8s/rbac-write.yaml",
    "kubectl --context platform-prod apply -f k8s/rbac-write.yaml",
  ]);
});

test("--dry-run prints the plan and runs nothing", () => {
  const box = sandbox();
  const result = rollback(box, "--vm", "vm", "--yes", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(box), []);
  assert.match(result.stdout, /\+ kubectl --context data-cluster-alien-hosted apply -f k8s\/rbac-write\.yaml/);
  assert.match(result.stdout, /\+ ssh sre-agent@vm pm2 restart sre-agent/);
});

test("refuses without --yes", () => {
  const box = sandbox();
  const result = rollback(box, "--vm", "vm");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to run without --yes/);
  assert.deepEqual(calls(box), []);
});

test("refuses without --vm", () => {
  const box = sandbox();
  assert.notEqual(rollback(box, "--yes").status, 0);
  assert.deepEqual(calls(box), []);
});

test("refuses to run as the agent's own account", () => {
  const box = sandbox({ user: "sre-agent" });
  const result = rollback(box, "--vm", "vm", "--yes");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not restore its own access/);
  assert.deepEqual(calls(box), []);
});

test("refuses when the pre-cutover tag does not exist", () => {
  const box = sandbox({ tag: false });
  const result = rollback(box, "--vm", "vm", "--yes");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tag pre-cutover not found/);
  assert.deepEqual(calls(box), []);
});

test("the make target requires VM and CONFIRM", () => {
  assert.ok(existsSync("Makefile"));
  const missing = spawnSync("make", ["-s", "rollback-write-access"], { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /Required: VM=/);
  const unconfirmed = spawnSync("make", ["-s", "rollback-write-access", "VM=vm"], { encoding: "utf8" });
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.stdout + unconfirmed.stderr, /Required: CONFIRM=yes/);
});

/** The CLAUDE.md copy is a mktemp file; it is the one capture that is not the sudoers drop-in. */
function readCapturedName(box: Sandbox): string {
  const deploy = calls(box).find((line) => line.includes(":/home/sre-agent/sre-agent/CLAUDE.md"));
  assert.ok(deploy);
  return deploy.split(" ")[1].split("/").pop() as string;
}
