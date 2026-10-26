// Tests for submitting the startup prompt. Run with: npm test
//
// The startup prompt carries the agent's briefing and deployment config. Sent as
// `send-keys "$PROMPT" Enter`, Claude Code took it for a paste, swallowed the Enter, and the
// prompt sat unsubmitted for the agent's whole life (SDS-992). These tests drive
// submit_prompt against a stub tmux whose input box keeps the pasted text until it has
// received a given number of separate Enter keystrokes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stub tmux: logs send-keys calls and shows the prompt pasted until `entersNeeded` Enters arrive. */
function stubTmux(entersNeeded: number) {
  const dir = mkdtempSync(join(tmpdir(), "sre-submit-"));
  const log = join(dir, "tmux.log");
  const enters = join(dir, "enters");
  writeFileSync(log, "");
  writeFileSync(enters, "0");
  writeFileSync(
    join(dir, "tmux"),
    `#!/usr/bin/env bash
if [ "$1" = send-keys ]; then
  if [ "$4" = -l ]; then echo "type:$5" >> "${log}"; else echo "key:$4" >> "${log}"; fi
  [ "$4" = Enter ] && echo $(( $(cat "${enters}") + 1 )) > "${enters}"
  exit 0
fi
if [ "$1" = capture-pane ]; then
  echo "  Listening for channel messages"
  if [ "$(cat "${enters}")" -lt ${entersNeeded} ]; then echo "❯ [Pasted text #1 +48 lines]"; else echo "❯ "; fi
  exit 0
fi
exit 1
`,
  );
  chmodSync(join(dir, "tmux"), 0o755);
  return { dir, log };
}

function submit(stub: { dir: string }, prompt: string, attempts = 5) {
  return spawnSync(
    "bash",
    ["-c", `source scripts/lib/submit-prompt.sh && submit_prompt sre-agent "$PROMPT" ${attempts}`],
    { env: { ...process.env, PATH: `${stub.dir}:${process.env.PATH}`, PROMPT: prompt, SUBMIT_PROMPT_PAUSE: "0" }, encoding: "utf8" },
  );
}

const PROMPT = "You are the SRE agent.\n\nHere is your briefing:\n- line one\n- line two";

test("types the prompt literally, then sends Enter on its own", () => {
  const stub = stubTmux(1);
  const result = submit(stub, PROMPT);
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(stub.log, "utf8").trim().split("\n");
  assert.equal(calls[0], `type:${PROMPT.split("\n")[0]}`, "prompt must be sent with -l, not as keys");
  assert.ok(calls.slice(1).includes("key:Enter"));
  assert.ok(!calls[0].includes("Enter"), "Enter must not travel with the prompt text");
  assert.match(result.stdout, /submitted \(attempt 1\)/);
});

test("retries Enter while the input box still holds the pasted prompt", () => {
  const stub = stubTmux(3);
  const result = submit(stub, PROMPT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /submitted \(attempt 3\)/);
  assert.equal(readFileSync(stub.log, "utf8").match(/key:Enter/g)?.length, 3);
});

test("fails, loudly, when the prompt never submits", () => {
  const stub = stubTmux(99);
  const result = submit(stub, PROMPT, 2);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still unsubmitted after 2 attempts/);
  assert.equal(readFileSync(stub.log, "utf8").match(/key:Enter/g)?.length, 2);
});

test("start-agent.sh submits through submit_prompt and reports a failure", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.doesNotMatch(launcher, /send-keys -t "\$SESSION_NAME" "\$PROMPT" Enter/);
  assert.match(launcher, /if ! submit_prompt "\$SESSION_NAME" "\$PROMPT"; then\n\s+echo "\[start-agent\] ERROR: the agent is running WITHOUT its briefing/);
});
