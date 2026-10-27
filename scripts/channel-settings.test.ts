// Tests for the start script's check of the channels' required settings. Run with: npm test
//
// A channel without one of its required settings exits before it binds its port, and
// start-agent.sh used to learn that only from a port left unbound, after it had already
// killed the running session. 0.4.0 makes the Trivy channel require the Jira credentials,
// which a VM upgraded in place does not have yet, so start-agent.sh now checks the settings
// first (scripts/lib/channel-settings.sh). These tests keep its list in step with the
// channels, and prove that a refused start names what is missing, tells the team channel,
// and leaves the running session alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JIRA_SETTINGS } from "../channels/jira-client.js";

const COMPLETE_SETTINGS: Record<string, string> = {
  SIGNOZ_WEBHOOK_TOKEN: "signoz-secret",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_APP_TOKEN: "xapp-test-token",
  SRE_SLACK_CHANNEL: "C0TESTCHAN",
  SRE_OPERATORS: "U0TEST:Leo",
  TRIVY_WEBHOOK_TOKEN: "trivy-secret",
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_USER_EMAIL: "sre-agent@example.com",
  JIRA_API_TOKEN: "atlassian-token",
};

function without(settings: Record<string, string>, ...names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([name]) => !names.includes(name)));
}

/** Every setting a channel refuses to start without, read from the channels' sources. */
function settingsTheChannelsRequire(): string[] {
  const required = new Set<string>();
  const sources = readdirSync("channels").filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  for (const file of sources) {
    const source = readFileSync(join("channels", file), "utf8");
    const calls = source.matchAll(/\b(?:requireEnv|requireSetting)\(\s*"(\w+)"|\brequireWebhookToken\(\s*process\.env,\s*"(\w+)"/g);
    for (const match of calls) required.add(match[1] ?? match[2]);
    if (/\breadJiraConfig\(\s*process\.env\s*\)/.test(source)) for (const name of JIRA_SETTINGS) required.add(name);
  }
  return [...required].sort();
}

function checkedSettings(): string[] {
  const result = spawnSync("bash", ["-c", 'source scripts/lib/channel-settings.sh && printf "%s\\n" "${REQUIRED_CHANNEL_SETTINGS[@]}"'], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split("\n").filter(Boolean).sort();
}

function missing(settings: Record<string, string>): string {
  const result = spawnSync("bash", ["-c", "source scripts/lib/channel-settings.sh && missing_channel_settings"], {
    env: { PATH: process.env.PATH, ...settings },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("start-agent.sh checks exactly the settings the channels require", () => {
  const required = settingsTheChannelsRequire();
  // The scan must find the channels' checks, or it would pass with an empty list
  assert.ok(required.includes("SIGNOZ_WEBHOOK_TOKEN") && required.includes("JIRA_API_TOKEN"), required.join(" "));
  assert.deepEqual(checkedSettings(), required);
  assert.deepEqual(Object.keys(COMPLETE_SETTINGS).sort(), required);
});

test("missing_channel_settings is empty when every setting is set", () => {
  assert.equal(missing(COMPLETE_SETTINGS), "");
});

test("missing_channel_settings names every unset or blank setting", () => {
  assert.equal(
    missing({ ...without(COMPLETE_SETTINGS, "JIRA_API_TOKEN"), JIRA_USER_EMAIL: "", SLACK_APP_TOKEN: "  \t" }),
    "SLACK_APP_TOKEN JIRA_USER_EMAIL JIRA_API_TOKEN"
  );
});

// Runs the real start-agent.sh from a sandbox copy, with its .env, a tmux that only logs
// (has-session succeeds when a session is said to be running, anything else fails) and the
// Slack stub curl. The environment is built from scratch so no real setting leaks in.
function startAgent(env: Record<string, string>, sessionRunning: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "sre-start-"));
  const bin = join(dir, "bin");
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  mkdirSync(bin);
  copyFileSync("scripts/start-agent.sh", join(dir, "scripts/start-agent.sh"));
  for (const lib of readdirSync("scripts/lib")) copyFileSync(join("scripts/lib", lib), join(dir, "scripts/lib", lib));
  writeFileSync(join(dir, ".env"), Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(""));
  writeFileSync(
    join(bin, "tmux"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dir}/tmux.log"\n[ "$1" = has-session ] && [ -n "$STUB_SESSION_RUNNING" ]\n`
  );
  copyFileSync("scripts/fixtures/curl-stub.sh", join(bin, "curl"));
  chmodSync(join(bin, "tmux"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(dir, "tmux.log"), "");

  const result = spawnSync("bash", [join(dir, "scripts/start-agent.sh")], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CURL_DIR: dir,
      CURL_RESPONSE: '{"ok":true}',
      CURL_EXIT: "0",
      ...(sessionRunning ? { STUB_SESSION_RUNNING: "1" } : {}),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  const tmuxCalls = readFileSync(join(dir, "tmux.log"), "utf8").split("\n").filter(Boolean);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : undefined);
  return { ...result, tmuxCalls, slackBody: read("body") };
}

test("a start without the Jira settings is refused before the running session is touched", () => {
  const result = startAgent(without(COMPLETE_SETTINGS, ...JIRA_SETTINGS), true);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /not restarting: \.env does not set JIRA_BASE_URL JIRA_USER_EMAIL JIRA_API_TOKEN/);
  assert.match(result.stderr, /session already running was left as it is/);
  // Only asked whether a session runs: never killed it nor started another
  assert.deepEqual(result.tmuxCalls, ["has-session -t sre-agent"]);

  assert.ok(result.slackBody, "the team channel must be told");
  const notice = JSON.parse(result.slackBody) as { channel: string; text: string };
  assert.equal(notice.channel, "C0TESTCHAN");
  assert.match(notice.text, /Restart refused/);
  assert.match(notice.text, /does not set JIRA_BASE_URL JIRA_USER_EMAIL JIRA_API_TOKEN/);
});

test("a refused start says so when no session is left handling alerts", () => {
  const result = startAgent(without(COMPLETE_SETTINGS, "TRIVY_WEBHOOK_TOKEN"), false);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not set TRIVY_WEBHOOK_TOKEN/);
  assert.match(result.stderr, /No agent session is running/);
  assert.deepEqual(result.tmuxCalls, ["has-session -t sre-agent"]);
  assert.match(JSON.parse(result.slackBody ?? "{}").text, /No agent session is running/);
});

test("a refused start is still logged when the team channel cannot be told", () => {
  const result = startAgent(without(COMPLETE_SETTINGS, "SLACK_BOT_TOKEN"), true);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /does not set SLACK_BOT_TOKEN/);
  assert.match(result.stderr, /team channel could not be told that the restart was refused/);
  assert.equal(result.slackBody, undefined);
  assert.deepEqual(result.tmuxCalls, ["has-session -t sre-agent"]);
});
