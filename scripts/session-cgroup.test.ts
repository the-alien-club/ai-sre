// Tests for keeping the Claude session in pm2's cgroup. Run with: npm test
//
// On 2026-10-29 the agent died three times when an operator's last SSH login ended: the
// login's XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS had reached start-agent.sh through
// pm2, tmux used them to put the Claude pane in a scope of the login's systemd user manager,
// and systemd stopped that manager, and the pane with it, at logout. start-agent.sh now
// starts tmux without them and refuses a session outside its own cgroup.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PM2_CGROUP = "0::/system.slice/pm2-sre-agent.service\n";
const LOGIN_SCOPE = "0::/user.slice/user-1001.slice/user@1001.service/app.slice/app-tmux.slice/tmux-spawn-4942bb43.scope\n";

/**
 * Runs same_cgroup against a fake /proc in which this shell is in pm2's cgroup and `pid`
 * has `theirs` (or no cgroup file at all, when undefined).
 */
function sameCgroup(pid: string, theirs: string | undefined) {
  const proc = mkdtempSync(join(tmpdir(), "sre-proc-"));
  if (theirs !== undefined && /^\d+$/.test(pid)) {
    mkdirSync(join(proc, pid));
    writeFileSync(join(proc, pid, "cgroup"), theirs);
  }
  const script = `mkdir -p "$PROC/$$" && printf '%s' "$MINE" > "$PROC/$$/cgroup" && source scripts/lib/session-cgroup.sh && same_cgroup "$PID" "$PROC"`;
  return spawnSync("bash", ["-c", script], { env: { ...process.env, PROC: proc, MINE: PM2_CGROUP, PID: pid }, encoding: "utf8" });
}

test("a session in this script's cgroup passes", () => {
  const result = sameCgroup("849134", PM2_CGROUP);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("a session moved into a login's user-manager scope is refused, naming both cgroups", () => {
  const result = sameCgroup("849134", LOGIN_SCOPE);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tmux-spawn-4942bb43\.scope/);
  assert.match(result.stderr, /pm2-sre-agent\.service/);
  assert.match(result.stderr, /user manager stops at logout/);
});

test("a session whose cgroup cannot be read is refused, never assumed fine", () => {
  const result = sameCgroup("849134", undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read the cgroup of the session \(pid 849134\)/);
});

test("a PID that is not a number is refused", () => {
  const result = sameCgroup("12; rm -rf /", PM2_CGROUP);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a PID/);
});

test("the real /proc: a child of this shell shares its cgroup", () => {
  const result = spawnSync("bash", ["-c", "sleep 5 & child=$!; source scripts/lib/session-cgroup.sh && same_cgroup \"$child\"; status=$?; kill \"$child\"; exit $status"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("start-agent.sh starts tmux without the login's bus variables and checks the cgroup before the briefing", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.match(launcher, /^env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR \\\n\s+tmux new-session -d -s "\$SESSION_NAME"/m);
  assert.equal(launcher.match(/tmux new-session/g)?.length, 1, "every session is started that way");
  const check = launcher.indexOf('if ! same_cgroup "$SESSION_PID"; then');
  assert.ok(check > launcher.indexOf("wait_for_port \"SigNoz webhook\""), "after Claude Code is up");
  assert.ok(check < launcher.indexOf("BRIEFING="), "before the briefing");
  assert.match(launcher.slice(check, check + 400), /tmux kill-session -t "\$SESSION_NAME"[\s\S]*exit 1/);
});
