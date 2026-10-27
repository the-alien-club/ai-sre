// Integration test for pasting the startup prompt with a real tmux. Run with: npm test
//
// submit-prompt.test.ts drives a stub; this proves the tmux side for real. Typed with
// `send-keys -l`, the agent's ~50KB startup prompt failed with "command too long" on every
// restart from 2026-10-27, so here a prompt several times that size must reach the pane
// byte for byte, newlines intact (not turned into Enter) and inside one bracketed paste.
//
// The pane runs `cat` on a raw tty, which records exactly what an application receives.
// The tmux server lives in its own TMUX_TMPDIR, so it never touches a session on the host.
// Skipped where tmux is not installed; CI installs it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(100);
  }
}

test("paste_prompt delivers a prompt far over tmux's send-keys limit, whole", { skip: !hasTmux && "tmux not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sre-tmux-"));
  const env = { ...process.env, TMUX_TMPDIR: dir };
  const received = join(dir, "received");
  const tmux = (...args: string[]) => spawnSync("tmux", args, { env, encoding: "utf8" });

  // Raw mode: no line-length limit, no CR/LF translation, no echo. 2004h asks for
  // bracketed paste, as Claude Code does.
  const pane = `stty raw -echo && printf '\\033[?2004h' && touch '${dir}/ready' && exec cat > '${received}'`;
  const started = tmux("new-session", "-d", "-s", "sre-agent", "-x", "200", "-y", "50", pane);
  assert.equal(started.status, 0, started.stderr);
  try {
    await waitFor(() => existsSync(join(dir, "ready")), "the pane to be ready");

    const prompt = `You are the SRE agent.\n${"- [2026-10-27] Trivy VulnerabilityReport on cilium — escalated: é\n".repeat(3_000)}done`;
    assert.ok(Buffer.byteLength(prompt) > 200_000);
    writeFileSync(join(dir, "prompt"), prompt);

    const typed = spawnSync("bash", ["-c", `IFS= read -r -d '' PROMPT < '${dir}/prompt' || true; tmux send-keys -t sre-agent -l -- "$PROMPT"`], { env, encoding: "utf8" });
    assert.notEqual(typed.status, 0, "typing a prompt this size must fail, or this test proves nothing");

    const pasted = spawnSync("bash", ["-c", `IFS= read -r -d '' PROMPT < '${dir}/prompt' || true; source scripts/lib/submit-prompt.sh && paste_prompt sre-agent "$PROMPT"`], { env, encoding: "utf8" });
    assert.equal(pasted.status, 0, pasted.stderr);

    const expected = Buffer.from(`\x1b[200~${prompt}\x1b[201~`);
    await waitFor(() => existsSync(received) && readFileSync(received).length >= expected.length, "the whole paste to arrive");
    assert.ok(readFileSync(received).equals(expected), "the pane must receive the prompt byte for byte, in one bracketed paste");

    assert.equal(tmux("list-buffers").stdout, "", "the pasted buffer must be deleted");
  } finally {
    tmux("kill-server");
  }
});
