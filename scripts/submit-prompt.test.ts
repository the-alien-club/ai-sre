// Tests for submitting the startup prompt. Run with: npm test
//
// The startup prompt carries the agent's briefing and deployment config. Sent as
// `send-keys "$PROMPT" Enter`, Claude Code took it for a paste, swallowed the Enter, and the
// prompt sat unsubmitted for the agent's whole life (SDS-992). The fix must prove the prompt
// was sent, never assume it, so most of these tests are about failures being reported as
// failures.
//
// The stub tmux (fixtures/tmux-stub.sh) parses its flags and renders the input box the way
// Claude Code does (taken from the live pane on the agent VM): between two horizontal rules,
// starting with "❯" and a no-break space. Environment variables make it fail in each of the
// ways a real session can.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STUB = "scripts/fixtures/tmux-stub.sh";

interface Options {
  entersNeeded?: number;
  failSend?: boolean;
  failCapture?: boolean;
  noUi?: boolean;
  noLand?: boolean;
}

function run(prompt: string, options: Options = {}, attempts = 3, fn = "submit_prompt") {
  const dir = mkdtempSync(join(tmpdir(), "sre-submit-"));
  const log = join(dir, "tmux.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "enters"), "0");
  copyFileSync(STUB, join(dir, "tmux"));
  chmodSync(join(dir, "tmux"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    PROMPT: prompt,
    SUBMIT_PROMPT_PAUSE: "0",
    STUB_DIR: dir,
    STUB_LOG: log,
    STUB_ENTERS_NEEDED: String(options.entersNeeded ?? 1),
    ...(options.failSend ? { STUB_FAIL_SEND: "1" } : {}),
    ...(options.failCapture ? { STUB_FAIL_CAPTURE: "1" } : {}),
    ...(options.noUi ? { STUB_NO_UI: "1" } : {}),
    ...(options.noLand ? { STUB_NO_LAND: "1" } : {}),
  };
  const args = fn === "submit_prompt" ? `sre-agent "$PROMPT" ${attempts}` : `sre-agent "$PROMPT"`;
  const result = spawnSync("bash", ["-c", `source scripts/lib/submit-prompt.sh && ${fn} ${args}`], { env, encoding: "utf8" });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { ...result, calls, enters: calls.filter((call) => call === "key:Enter").length };
}

const PROMPT = "You are the SRE agent.\n\nHere is your briefing:\n- line one";

test("types the prompt literally, sees it land, then submits with a separate Enter", () => {
  const result = run(PROMPT);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[0], `type:${PROMPT.split("\n")[0]}`);
  assert.equal(result.enters, 1);
  assert.match(result.stdout, /submitted \(attempt 1\)/);
});

test("retries Enter while the input box still holds the prompt", () => {
  const result = run(PROMPT, { entersNeeded: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.enters, 3);
  assert.match(result.stdout, /submitted \(attempt 3\)/);
});

test("a prompt starting with '-' is typed, not parsed as a flag", () => {
  const result = run("-starts with a dash");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls[0], "type:-starts with a dash");
});

test("fails when the prompt never submits", () => {
  const result = run(PROMPT, { entersNeeded: 99 }, 2);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still unsubmitted after 2 attempts/);
});

test("fails when typing into tmux fails, without sending Enter", () => {
  const result = run(PROMPT, { failSend: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not type the startup prompt/);
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
