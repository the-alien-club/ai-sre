// Tests for the write-access rollback. Run with: npm test
//
// The rollback is the safety net for the Rundeck cutover, so it has to work the first
// time it is needed, and it must never touch a cluster or the VM while being tested. Each
// test builds a throwaway git repo holding the files the script reads, tags it, edits the
// working tree afterwards, and puts recording stubs for kubectl, ssh, scp and id first on
// PATH. The stubs log their arguments and keep what would have been deployed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** A stub that appends its name and arguments (newlines flattened) to the log, then runs `body`. */
function stub(bin: string, name: string, log: string, body = "") {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nargs="$*"; echo "${name} \${args//$'\\n'/ ⏎ }" >> "${log}"\n${body}\nexit 0\n`);
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
  // The working tree moves on after the tag; the rollback must restore the tagged files only
  writeFileSync(join(repo, "CLAUDE.md"), "# runbook after the cutover\n");
  writeFileSync(join(repo, "k8s/rbac-write.yaml"), "# edited after the cutover\n");
  writeFileSync(join(repo, "provision/sudoers.d/sre-agent"), "evil ALL=(ALL) NOPASSWD:ALL\n");

  const failOn = options.failKubectlOn;
  stub(bin, "kubectl", log, [
    failOn ? `[[ "$*" == *"${failOn}"* ]] && exit 1` : "",
    // keep what `apply -f` would apply
    `[[ "$*" == *" apply -f "* ]] && cp "\${@: -1}" "${captured}/applied-rbac.yaml"`,
  ].join("\n"));
  // ssh keeps any stdin it was given, which is how the sudoers file travels
  stub(bin, "ssh", log, `stdin="$(cat)"; [ -n "$stdin" ] && printf '%s\\n' "$stdin" > "${captured}/ssh-stdin"; [ -n "$2" ] && printf '%s' "$2" > "${captured}/ssh-command-$(wc -l < "${log}")"`);
  stub(bin, "scp", log, `cp "$1" "${captured}/$(basename "$1")"`);
  stub(bin, "id", log, `echo "${options.user ?? "operator"}"`);

  return { repo, log, captured, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function rollback(box: Sandbox, ...args: string[]) {
  return spawnSync("bash", ["scripts/rollback-write-access.sh", ...args], { cwd: box.repo, env: box.env, encoding: "utf8", input: "" });
}

function calls(box: Sandbox): string[] {
  return readFileSync(box.log, "utf8").split("\n").filter((line) => line && !line.startsWith("id "));
}

function captured(box: Sandbox, name: string): string {
  return readFileSync(join(box.captured, name), "utf8");
}

const SA_CHECK = (ctx: string) => `kubectl --context ${ctx} get serviceaccount sre-agent -n kube-system -o name`;

test("preflights, then restores RBAC, sudo and the runbook, then restarts", () => {
  const box = sandbox();
  const result = rollback(box, "--vm", "203.0.113.7", "--yes");
  assert.equal(result.status, 0, result.stderr);

  const log = calls(box);
  assert.deepEqual(log.slice(0, 5), ALL_CONTEXTS.map(SA_CHECK));
  assert.match(log[5], /^ssh root@203\.0\.113\.7 id -u sre-agent >\/dev\/null && test -d \/home\/sre-agent\/sre-agent$/);
  for (const [index, ctx] of ALL_CONTEXTS.entries()) {
    assert.match(log[6 + index], new RegExp(`^kubectl --context ${ctx} apply -f \\S+/k8s/rbac-write\\.yaml$`));
  }
  assert.match(log[11], /^ssh root@203\.0\.113\.7 set -e/);
  assert.match(log[12], /^scp \S+\/CLAUDE\.md sre-agent@203\.0\.113\.7:\/home\/sre-agent\/sre-agent\/CLAUDE\.md$/);
  assert.equal(log[13], "ssh sre-agent@203.0.113.7 pm2 restart sre-agent");
  assert.equal(log.length, 14);
});

test("restores every file from the pre-cutover tag, not the working tree", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes").status, 0);
  assert.equal(captured(box, "applied-rbac.yaml"), readFileSync("k8s/rbac-write.yaml", "utf8"));
  assert.equal(captured(box, "ssh-stdin"), readFileSync("provision/sudoers.d/sre-agent", "utf8"));
  assert.equal(captured(box, "CLAUDE.md"), PRE_CUTOVER_CLAUDE_MD);
});

test("installs sudoers through a fresh remote mktemp, validated before install", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes").status, 0);
  const remote = readdirSync(box.captured)
    .filter((name) => name.startsWith("ssh-command-"))
    .map((name) => captured(box, name))
    .find((command) => command.includes("visudo"));
  assert.ok(remote, "expected the sudoers install command");
  assert.doesNotMatch(remote, /\/tmp\/sre-agent\.sudoers/);
  const steps = ["mktemp", 'cat > "$f"', 'visudo -c -f "$f"', "install -m 0440 -o root -g root", "usermod -aG sudo sre-agent"];
  const positions = steps.map((step) => remote.indexOf(step));
  assert.ok(positions.every((position) => position >= 0), remote);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "steps must run in this order");
  assert.equal(spawnSync("bash", ["-n"], { input: remote, encoding: "utf8" }).status, 0, "remote script must parse");
});

test("--contexts limits the RBAC steps", () => {
  const box = sandbox();
  assert.equal(rollback(box, "--vm", "vm", "--yes", "--contexts", "data-cluster-dev").status, 0);
  const kubectl = calls(box).filter((line) => line.startsWith("kubectl"));
  assert.equal(kubectl.length, 2);
  assert.equal(kubectl[0], SA_CHECK("data-cluster-dev"));
  assert.match(kubectl[1], /^kubectl --context data-cluster-dev apply -f /);
});

test("a context without the agent's ServiceAccount fails the preflight before any write", () => {
  const box = sandbox({ failKubectlOn: "--context platform-prod get serviceaccount" });
  const result = rollback(box, "--vm", "vm", "--yes");
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls(box), [SA_CHECK("platform-dev"), SA_CHECK("platform-prod")]);
});

test("stops at the first failed write and touches nothing after it", () => {
  const box = sandbox({ failKubectlOn: "--context platform-prod apply" });
  const result = rollback(box, "--vm", "vm", "--yes");
  assert.notEqual(result.status, 0);
  const log = calls(box);
  assert.match(log[log.length - 1], /^kubectl --context platform-prod apply/);
  assert.equal(log.filter((line) => line.startsWith("ssh root@vm set -e")).length, 0);
});

test("--dry-run runs only the read-only preflight and prints the writes", () => {
  const box = sandbox();
  const result = rollback(box, "--vm", "vm", "--yes", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(box), [
    ...ALL_CONTEXTS.map(SA_CHECK),
    "ssh root@vm id -u sre-agent >/dev/null && test -d /home/sre-agent/sre-agent",
  ]);
  assert.match(result.stdout, /\+ kubectl --context data-cluster-alien-hosted apply -f \S+rbac-write\.yaml/);
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

test("--dry-run still fails on a wrong target", () => {
  const box = sandbox({ failKubectlOn: "--context platform-prod get serviceaccount" });
  const result = rollback(box, "--vm", "vm", "--yes", "--dry-run");
  assert.notEqual(result.status, 0);
  assert.deepEqual(calls(box), [SA_CHECK("platform-dev"), SA_CHECK("platform-prod")]);
});
