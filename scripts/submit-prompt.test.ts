// Tests for submitting the startup prompt. Run with: npm test
//
// The startup prompt carries the agent's briefing and deployment config. Sent as
// `send-keys "$PROMPT" Enter`, Claude Code took it for a paste, swallowed the Enter, and the
// prompt sat unsubmitted for the agent's whole life (SDS-992). Typed with `send-keys -l`, a
// 49.5KB prompt then failed with tmux's "command too long" on every restart from
// 2026-10-27, while out.log still said "Agent started with briefing". The fix must deliver a
// prompt of any size, prove it was sent, never assume it, and say so loudly when it was not,
// so most of these tests are about failures being reported as failures.
//
// The stub tmux (fixtures/tmux-stub.sh) parses its flags, rejects a send-keys argument over
// tmux's message size, and renders the input box the way Claude Code does (taken from the
// live pane on the agent VM): between two horizontal rules, starting with "❯" and a no-break
// space. Environment variables make it fail in each of the ways a real session can. The
// stub curl (fixtures/curl-stub.sh) stands in for Slack.
//
// Submitted means recorded in the session's transcript, as Claude Code does (2026-10-29: a
// prompt queued behind an alert's turn left the input box looking unsubmitted, and a
// delivered briefing was reported lost). The stub writes that transcript.

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
  queued?: boolean;
  lost?: boolean;
  /** Lines already in the briefing-restart state file. */
  retries?: string;
  slack?: { response: string; exit?: number } | "unconfigured";
}

function stubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sre-submit-"));
  writeFileSync(join(dir, "tmux.log"), "");
  writeFileSync(join(dir, "enters"), "0");
  for (const [stub, name] of [["tmux-stub.sh", "tmux"], ["curl-stub.sh", "curl"]]) {
    copyFileSync(join("scripts/fixtures", stub), join(dir, name));
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

const SESSION_ID = "4942bb43-37d5-4650-8193-dd6d55f00eb3";
const NONCE = "9d1c2e7a-5b4f-4c3a-9e8d-7f6a5b4c3d2e";

function run(promptWithoutNonce: string, options: Options = {}, attempts = 3, fn = "submit_prompt") {
  const dir = stubDir();
  const prompt = `${promptWithoutNonce}\n(Startup prompt ${NONCE})`;
  const projects = join(dir, "projects");
  const transcript = join(projects, "-home-sre-agent-sre-agent", `${SESSION_ID}.jsonl`);
  const retryState = join(dir, "briefing-restarts");
  if (options.retries !== undefined) writeFileSync(retryState, options.retries);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    PROMPT_FILE: join(dir, "prompt"),
    SUBMIT_PROMPT_PAUSE: "0",
    STUB_DIR: dir,
    STUB_LOG: join(dir, "tmux.log"),
    STUB_ENTERS_NEEDED: String(options.entersNeeded ?? 1),
    STUB_TRANSCRIPT: transcript,
    PROJECTS: projects,
    RETRY_STATE: retryState,
    CURL_DIR: dir,
    CURL_RESPONSE: options.slack === "unconfigured" ? "" : (options.slack?.response ?? '{"ok":true}'),
    CURL_EXIT: String(options.slack === "unconfigured" ? 0 : (options.slack?.exit ?? 0)),
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SRE_SLACK_CHANNEL: "C0TESTCHAN",
    ...(options.failLoad ? { STUB_FAIL_LOAD: "1" } : {}),
    ...(options.failPaste ? { STUB_FAIL_PASTE: "1" } : {}),
    ...(options.failSend ? { STUB_FAIL_SEND: "1" } : {}),
    ...(options.failCapture ? { STUB_FAIL_CAPTURE: "1" } : {}),
    ...(options.noUi ? { STUB_NO_UI: "1" } : {}),
    ...(options.noLand ? { STUB_NO_LAND: "1" } : {}),
    ...(options.showOther ? { STUB_SHOW_OTHER: "1" } : {}),
    ...(options.showLiteral ? { STUB_SHOW_LITERAL: "1" } : {}),
    ...(options.queued ? { STUB_QUEUED: "1" } : {}),
    ...(options.lost ? { STUB_LOST: "1" } : {}),
  };
  if (options.slack === "unconfigured") delete env.SLACK_BOT_TOKEN;
  // Through a file, not the environment: an exec'd variable is capped at 128KB, and the
  // large-prompt test exceeds it. `read -d ''` keeps trailing newlines, which $(cat) drops.
  writeFileSync(join(dir, "prompt"), prompt);
  const load = `IFS= read -r -d '' PROMPT < "$PROMPT_FILE" || true`;
  const common = `sre-agent "$PROMPT" ${NONCE} "$PROJECTS" ${SESSION_ID}`;
  const args = fn === "submit_prompt" ? `${common} ${attempts}` : `${common} "$RETRY_STATE"`;
  const result = spawnSync("bash", ["-c", `${load}; source scripts/lib/submit-prompt.sh && ${fn} ${args}`], { env, encoding: "utf8" });
  const calls = readFileSync(join(dir, "tmux.log"), "utf8").split("\n").filter(Boolean);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);
  return {
    ...result,
    prompt,
    retryState: read("briefing-restarts"),
    calls,
    enters: calls.filter((call) => call === "key:Enter").length,
    pasted: read("typed"),
    buffersLeft: readdirSync(dir).filter((name) => name.startsWith("buffer-")),
    slack: { args: read("args"), headers: read("headers"), body: read("body") },
  };
}

/** A state file in which both briefing restarts of the hour are used up. */
function exhausted(): string {
  const now = Math.floor(Date.now() / 1000);
  return `${now - 600}\n${now - 120}\n`;
}

const PROMPT = "You are the SRE agent.\n\nHere is your briefing:\n- line one";

test("pastes the prompt through a tmux buffer, sees it land, then submits with a separate Enter", () => {
  const result = run(PROMPT);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.calls[0], /^paste:sre-startup-prompt-\d+$/);
  assert.equal(result.pasted, result.prompt, "the pane must receive the prompt byte for byte");
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
  assert.equal(result.pasted, result.prompt);
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
  assert.equal(result.pasted, result.prompt);
  assert.ok(result.pasted?.startsWith("-starts with a dash"));
});

test("fails when the prompt never submits", () => {
  const result = run(PROMPT, { entersNeeded: 99 }, 2);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`still not in session ${SESSION_ID}'s transcript after 2 attempts`));
});

test("2026-10-29 11:53: a prompt queued behind a running turn is submitted, though the box still shows it", () => {
  const result = run(PROMPT, { queued: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.enters, 1, "one Enter: no second submission of a queued prompt");
  assert.match(result.stdout, /submitted \(attempt 1\)/);
});

test("an input box that empties without the prompt reaching the transcript is a failure", () => {
  const result = run(PROMPT, { lost: true }, 3);
  assert.equal(result.status, 1);
  assert.equal(result.enters, 1, "no Enter once the prompt has left the box");
  assert.match(result.stderr, /still not in session .*'s transcript after 3 attempts/);
});

test("a prompt without its nonce is refused before anything is pasted", () => {
  const dir = stubDir();
  const result = spawnSync("bash", ["-c", `source scripts/lib/submit-prompt.sh && submit_prompt sre-agent "no nonce here" ${NONCE} "$PROJECTS" ${SESSION_ID} 2`], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_DIR: dir, STUB_LOG: join(dir, "tmux.log"), PROJECTS: join(dir, "projects") },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not carry its nonce/);
  assert.equal(readFileSync(join(dir, "tmux.log"), "utf8"), "");
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

test("submit_startup_prompt succeeds quietly when the prompt is submitted", () => {
  const result = run(PROMPT, {}, 3, "submit_startup_prompt");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.slack.args, undefined, "no Slack notice on success");
});

test("submit_startup_prompt asks for a session restart, without paging, while restarts are left", () => {
  const first = run(PROMPT, { failCapture: true }, 3, "submit_startup_prompt");
  assert.equal(first.status, 2);
  assert.match(first.stderr, /restarting the session to deliver it \(briefing restart 1 of 2 in the last 60 min\)/);
  assert.equal(first.slack.args, undefined, "a retry pages nobody");
  assert.equal(first.retryState?.trim().split("\n").length, 1);

  const now = Math.floor(Date.now() / 1000);
  const second = run(PROMPT, { failCapture: true, retries: `${now - 4000}\n${now - 60}\n` }, 3, "submit_startup_prompt");
  assert.equal(second.status, 2, "the restart over an hour ago no longer counts");
  assert.match(second.stderr, /briefing restart 2 of 2/);
  assert.deepEqual(second.retryState?.trim().split("\n").map(Number).filter((t) => t < now - 3600), [], "old restarts are pruned");
});

test("submit_startup_prompt refuses a restart over a corrupt state file, and says so", () => {
  const result = run(PROMPT, { failCapture: true, retries: "yesterday\n" }, 3, "submit_startup_prompt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /briefing-restarts is corrupt \(line 'yesterday'\)/);
  assert.match(result.stdout, /team channel notified/);
});

test("submit_startup_prompt fails, logs and notifies the team channel when no restart is left", () => {
  const now = Math.floor(Date.now() / 1000);
  const result = run(PROMPT, { failCapture: true, retries: `${now - 600}\n${now - 120}\n` }, 3, "submit_startup_prompt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR: the agent is running WITHOUT its briefing/);
  assert.match(result.stderr, /No restart for it: 2 restarts for the briefing in the last 60 min already/);
  assert.match(result.stdout, /team channel notified/);

  assert.match(result.slack.args ?? "", /^https:\/\/slack\.com\/api\/chat\.postMessage$/m);
  assert.match(result.slack.args ?? "", /^--max-time$/m);
  assert.doesNotMatch(result.slack.args ?? "", /xoxb-test-token/, "the token must not be on curl's command line");
  assert.equal(result.slack.headers, "Authorization: Bearer xoxb-test-token\n");
  const body = JSON.parse(result.slack.body ?? "") as { channel: string; text: string };
  assert.equal(body.channel, "C0TESTCHAN");
  assert.match(body.text, /Startup briefing not delivered/);
  assert.match(body.text, /`pm2 restart sre-agent`/);
});

test("submit_startup_prompt says so when Slack refuses the notice", () => {
  const result = run(PROMPT, { failCapture: true, retries: exhausted(), slack: { response: '{"ok":false,"error":"not_in_channel"}' } }, 3, "submit_startup_prompt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Slack refused the notice: \{"ok":false,"error":"not_in_channel"\}/);
  assert.match(result.stderr, /team channel could not be told/);
});

test("submit_startup_prompt says so when Slack cannot be reached", () => {
  const result = run(PROMPT, { failCapture: true, retries: exhausted(), slack: { response: "", exit: 28 } }, 3, "submit_startup_prompt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not reach Slack/);
  assert.match(result.stderr, /team channel could not be told/);
});

test("submit_startup_prompt says so when Slack is not configured", () => {
  const result = run(PROMPT, { failCapture: true, retries: exhausted(), slack: "unconfigured" }, 3, "submit_startup_prompt");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SLACK_BOT_TOKEN or SRE_SLACK_CHANNEL is not set/);
  assert.equal(result.slack.args, undefined, "curl must not run without a token");
});

test("start-agent.sh starts Claude Code with the session id the prompt is proven against", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.match(launcher, /claude --session-id \$SESSION_ID /);
  assert.match(launcher, /\(Startup prompt \$\{PROMPT_NONCE\}: /);
  assert.match(launcher, /submit_startup_prompt "\$SESSION_NAME" "\$PROMPT" "\$PROMPT_NONCE" "\$CLAUDE_PROJECTS_DIR" "\$SESSION_ID"/);
});

test("start-agent.sh logs 'started with briefing' only when the prompt was submitted, and restarts on 2", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.match(
    launcher,
    /^case "\$BRIEFING_STATUS" in\n\s+0\) echo "\[start-agent\] Agent started with briefing[^\n]*\n\s+2\)\n\s+tmux kill-session -t "\$SESSION_NAME"[^\n]*\n[^\n]*\n\s+exit 1\n\s+;;\n\s+\*\) echo "\[start-agent\] Agent started WITHOUT its briefing[^\n]*>&2 ;;\nesac$/m,
  );
  assert.equal(launcher.match(/Agent started with briefing/g)?.length, 1);
  assert.doesNotMatch(launcher, /send-keys[^\n]*\$PROMPT/);
});
