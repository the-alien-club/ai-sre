// Tests for submitting the startup prompt. Run with: npm test
//
// The startup prompt carries the agent's briefing and deployment config. Sent as
// `send-keys "$PROMPT" Enter`, Claude Code took it for a paste, swallowed the Enter, and the
// prompt sat unsubmitted for the agent's whole life (SDS-992). Typed with `send-keys -l`, a
// 49.5KB prompt then failed with tmux's "command too long" on every restart from
// 2026-10-27, while out.log still said "Agent started with briefing". The fix must deliver a
// prompt of any size, prove it was sent and never assume it, so most of these tests are about failures being reported as failures.
//
// The stub tmux (fixtures/tmux-stub.sh) parses its flags, rejects a send-keys argument over
// tmux's message size, and renders the input box the way Claude Code does (taken from the
// live pane on the agent VM): between two horizontal rules, starting with "❯" and a no-break
// space. Environment variables make it fail in each of the ways a real session can.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Options {
  entersNeeded?: number;
  failLoad?: boolean;
  failPaste?: boolean;
  failSend?: boolean;
  failCapture?: boolean;
  noUi?: boolean;
  noLand?: boolean;
  showOther?: boolean;
  showLiteral?: boolean;
}

function stubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sre-submit-"));
  writeFileSync(join(dir, "tmux.log"), "");
  writeFileSync(join(dir, "enters"), "0");
  copyFileSync("scripts/fixtures/tmux-stub.sh", join(dir, "tmux"));
  chmodSync(join(dir, "tmux"), 0o755);
  return dir;
}

function run(prompt: string, options: Options = {}, attempts = 3, fn = "submit_prompt") {
  const dir = stubDir();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    PROMPT_FILE: join(dir, "prompt"),
    SUBMIT_PROMPT_PAUSE: "0",
    STUB_DIR: dir,
    STUB_LOG: join(dir, "tmux.log"),
    STUB_ENTERS_NEEDED: String(options.entersNeeded ?? 1),
    ...(options.failLoad ? { STUB_FAIL_LOAD: "1" } : {}),
    ...(options.failPaste ? { STUB_FAIL_PASTE: "1" } : {}),
    ...(options.failSend ? { STUB_FAIL_SEND: "1" } : {}),
    ...(options.failCapture ? { STUB_FAIL_CAPTURE: "1" } : {}),
    ...(options.noUi ? { STUB_NO_UI: "1" } : {}),
    ...(options.noLand ? { STUB_NO_LAND: "1" } : {}),
    ...(options.showOther ? { STUB_SHOW_OTHER: "1" } : {}),
    ...(options.showLiteral ? { STUB_SHOW_LITERAL: "1" } : {}),
  };
  // Through a file, not the environment: an exec'd variable is capped at 128KB, and the
  // large-prompt test exceeds it. `read -d ''` keeps trailing newlines, which $(cat) drops.
  writeFileSync(join(dir, "prompt"), prompt);
  const load = `IFS= read -r -d '' PROMPT < "$PROMPT_FILE" || true`;
  const args = fn === "submit_prompt" ? `sre-agent "$PROMPT" ${attempts}` : `sre-agent "$PROMPT"`;
  const result = spawnSync("bash", ["-c", `${load}; source scripts/lib/submit-prompt.sh && ${fn} ${args}`], { env, encoding: "utf8" });
  const calls = readFileSync(join(dir, "tmux.log"), "utf8").split("\n").filter(Boolean);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);
  return {
    ...result,
    calls,
    enters: calls.filter((call) => call === "key:Enter").length,
    pasted: read("typed"),
    buffersLeft: readdirSync(dir).filter((name) => name.startsWith("buffer-")),
  };
}

const PROMPT = "You are the SRE agent.\n\nHere is your briefing:\n- line one";

test("pastes the prompt through a tmux buffer, sees it land, then submits with a separate Enter", () => {
  const result = run(PROMPT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls[0], /^paste:sre-startup-prompt-\d+$/);
  assert.equal(result.pasted, PROMPT, "the pane must receive the prompt byte for byte");
  assert.equal(result.calls.filter((call) => call.startsWith("type:")).length, 0, "nothing is typed");
  assert.equal(result.enters, 1);
  assert.match(result.stdout, /submitted \(attempt 1\)/);
});

test("a prompt far over tmux's send-keys limit is delivered whole", () => {
  // The prompt that failed on the VM was ~50KB; tmux refuses a send-keys over ~16KB
  const prompt = `You are the SRE agent.\n${"- [2026-10-27] Trivy VulnerabilityReport on cilium — escalated: é\n".repeat(2_000)}`;
  assert.ok(Buffer.byteLength(prompt) > 100_000);
  const result = run(prompt);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.pasted, prompt);
  assert.doesNotMatch(result.stderr, /command too long/);
});

test("retries Enter while the input box still holds the prompt", () => {
  const result = run(PROMPT, { entersNeeded: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.enters, 3);
  assert.match(result.stdout, /submitted \(attempt 3\)/);
});

test("a prompt starting with '-' is pasted verbatim", () => {
  const result = run("-starts with a dash");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.pasted, "-starts with a dash");
});

test("fails when the prompt never submits", () => {
  const result = run(PROMPT, { entersNeeded: 99 }, 2);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still unsubmitted after 2 attempts/);
});

test("fails when the prompt cannot be loaded into a buffer, without pasting or sending Enter", () => {
  const result = run(PROMPT, { failLoad: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not load the startup prompt into a tmux buffer/);
  assert.equal(result.pasted, undefined);
  assert.equal(result.enters, 0);
});

test("fails when the paste fails, deletes the buffer and sends no Enter", () => {
  const result = run(PROMPT, { failPaste: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not paste the startup prompt/);
  assert.ok(result.calls.some((call) => call.startsWith("delete:sre-startup-prompt-")));
  assert.deepEqual(result.buffersLeft, [], "the briefing must not linger in a tmux buffer");
  assert.equal(result.enters, 0);
});

test("fails when Enter cannot be sent", () => {
  const result = run(PROMPT, { failSend: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not send Enter/);
  assert.doesNotMatch(result.stdout, /submitted/);
});

test("fails when the pane cannot be captured", () => {
  const result = run(PROMPT, { failCapture: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Claude Code input box recognised/);
  assert.equal(result.enters, 0);
});

test("fails when no Claude Code input box is recognised in the pane", () => {
  const result = run(PROMPT, { noUi: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Claude Code input box recognised/);
  assert.equal(result.enters, 0);
});

test("fails when the prompt never lands in the input box, without sending Enter", () => {
  const result = run(PROMPT, { noLand: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never appeared in the input box/);
  assert.equal(result.enters, 0);
});

test("a short prompt shown as pasted (not collapsed) counts as landed", () => {
  const result = run("ready check", { showLiteral: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.enters, 1);
});

test("unrelated text in the input box is not mistaken for the prompt", () => {
  const result = run(PROMPT, { showOther: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never appeared in the input box/);
  assert.equal(result.enters, 0, "Enter must not submit someone else's text");
});

test("submit_startup_prompt reports a failure loudly and does not fail the start", () => {
  const result = run(PROMPT, { failCapture: true }, 3, "submit_startup_prompt");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /ERROR: the agent is running WITHOUT its briefing/);
});

test("start-agent.sh submits through submit_startup_prompt only", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.match(launcher, /^submit_startup_prompt "\$SESSION_NAME" "\$PROMPT"$/m);
  assert.doesNotMatch(launcher, /send-keys[^\n]*\$PROMPT/);
});
