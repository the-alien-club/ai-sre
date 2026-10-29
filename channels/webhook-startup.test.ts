// Startup tests for the webhook channels. Run with: npm test
//
// webhook-auth.test.ts proves the check refuses a missing secret; this proves the channels
// actually call it before binding a port, so a VM deployed without the secret fails loudly
// instead of listening unauthenticated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const CHANNELS = [
  { script: "channels/signoz-webhook.ts", variable: "SIGNOZ_WEBHOOK_TOKEN" },
  { script: "channels/trivy-webhook.ts", variable: "TRIVY_WEBHOOK_TOKEN" },
];

for (const { script, variable } of CHANNELS) {
  test(`${script} refuses to start without ${variable}`, () => {
    const env = { ...process.env };
    delete env[variable];

    const result = spawnSync(process.execPath, ["--import", "tsx", script], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });

    assert.notEqual(result.status, 0, "channel must exit non-zero");
    assert.match(result.stderr, new RegExp(`${variable} is not set`));
    assert.doesNotMatch(result.stderr, /listening on/);
  });
}

for (const { script, variable } of CHANNELS) {
  const hostVariable = variable.replace("_TOKEN", "_HOST");
  for (const host of ["0.0.0.0", ""]) {
    test(`${script} refuses to start with ${hostVariable}=${JSON.stringify(host)}`, () => {
      const result = spawnSync(process.execPath, ["--import", "tsx", script], {
        env: { ...process.env, [variable]: "a-configured-secret", [hostVariable]: host },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.notEqual(result.status, 0, "channel must exit non-zero");
      assert.match(result.stderr, /is not a loopback address/);
      assert.doesNotMatch(result.stderr, /listening on/);
    });
  }
}

// The Trivy channel posts to Slack and Jira itself, so it needs their settings too, and has
// no default for any of them: a channel that silently skipped its digest or its tickets
// would be found out weeks later.
const TRIVY_ENV = {
  TRIVY_WEBHOOK_TOKEN: "a-configured-secret",
  TRIVY_WEBHOOK_HOST: "127.0.0.1",
  SLACK_BOT_TOKEN: "xoxb-test",
  SRE_SLACK_CHANNEL: "C0TEST",
  SRE_OPERATORS: "U1:Leo",
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_USER_EMAIL: "sre@example.com",
  JIRA_API_TOKEN: "jira-secret",
};

function startTrivy(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ["--import", "tsx", "channels/trivy-webhook.ts"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

for (const variable of ["SLACK_BOT_TOKEN", "SRE_SLACK_CHANNEL", "SRE_OPERATORS", "JIRA_BASE_URL", "JIRA_USER_EMAIL", "JIRA_API_TOKEN"]) {
  test(`channels/trivy-webhook.ts refuses to start without ${variable}`, () => {
    const result = startTrivy({ ...TRIVY_ENV, [variable]: undefined });

    assert.notEqual(result.status, 0, "channel must exit non-zero");
    assert.match(result.stderr, new RegExp(`${variable} is not set`));
    assert.doesNotMatch(result.stderr, /listening on/);
  });
}

for (const hour of ["24", "7.5", "seven"]) {
  test(`channels/trivy-webhook.ts refuses TRIVY_DIGEST_HOUR_UTC=${hour}`, () => {
    const result = startTrivy({ ...TRIVY_ENV, TRIVY_DIGEST_HOUR_UTC: hour });

    assert.notEqual(result.status, 0, "channel must exit non-zero");
    assert.match(result.stderr, /TRIVY_DIGEST_HOUR_UTC must be an integer hour from 0 to 23/);
  });
}

// The SigNoz channel runs sentinel's remediable alerts on Rundeck itself, so it needs the
// endpoint and token, with no default for either: a remediation path that silently did
// nothing would be found out only when stage 2 paged a human.
const SIGNOZ_ENV = {
  SIGNOZ_WEBHOOK_TOKEN: "a-configured-secret",
  SIGNOZ_WEBHOOK_HOST: "127.0.0.1",
  RUNDECK_URL: "http://10.66.0.1:30440",
  RUNDECK_API_TOKEN: "rundeck-secret",
};

function startSignoz(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ["--import", "tsx", "channels/signoz-webhook.ts"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

for (const variable of ["RUNDECK_URL", "RUNDECK_API_TOKEN"]) {
  test(`channels/signoz-webhook.ts refuses to start without ${variable}`, () => {
    const result = startSignoz({ ...SIGNOZ_ENV, [variable]: undefined });

    assert.notEqual(result.status, 0, "channel must exit non-zero");
    assert.match(result.stderr, new RegExp(`${variable} is not set`));
    assert.doesNotMatch(result.stderr, /listening on/);
  });
}

test("channels/signoz-webhook.ts refuses to send the Rundeck token over plain http to a public host", () => {
  const result = startSignoz({ ...SIGNOZ_ENV, RUNDECK_URL: "http://rundeck.example.com:30440" });

  assert.notEqual(result.status, 0, "channel must exit non-zero");
  assert.match(result.stderr, /plain http only to a private IPv4 address/);
  assert.doesNotMatch(result.stderr, /listening on/);
});

// The Slack channel applies runbook (KEDB) changes on an approver's "yes", so who may approve
// is required, with no default, and must be someone the channel listens to at all. Both checks
// run before the channel touches Slack, so a fake token is enough to reach them.
const SLACK_ENV = {
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_APP_TOKEN: "xapp-test",
  SRE_SLACK_CHANNEL: "C0TEST",
  SRE_OPERATORS: "U054PDMV69X:Leo,U059X19MH8U:Adrien",
  SRE_KEDB_APPROVERS: "U054PDMV69X",
};

function startSlack(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ["--import", "tsx", "channels/slack-sre.ts"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("channels/slack-sre.ts refuses to start without SRE_KEDB_APPROVERS", () => {
  const result = startSlack({ ...SLACK_ENV, SRE_KEDB_APPROVERS: undefined });

  assert.notEqual(result.status, 0, "channel must exit non-zero");
  assert.match(result.stderr, /SRE_KEDB_APPROVERS is required/);
});

test("channels/slack-sre.ts refuses an approver who is not an operator", () => {
  const result = startSlack({ ...SLACK_ENV, SRE_KEDB_APPROVERS: "U0NOTANOP" });

  assert.notEqual(result.status, 0, "channel must exit non-zero");
  assert.match(result.stderr, /U0NOTANOP is not in SRE_OPERATORS/);
});

// The follow-up is what keeps an operator from waiting in silence; a typo must not turn it off.
test("channels/slack-sre.ts refuses an OPERATOR_FOLLOWUP_MS that is not a positive integer", () => {
  for (const value of ["5m", "0", "-1"]) {
    const result = startSlack({ ...SLACK_ENV, OPERATOR_FOLLOWUP_MS: value });

    assert.notEqual(result.status, 0, `channel must exit non-zero for ${value}`);
    assert.match(result.stderr, /OPERATOR_FOLLOWUP_MS must be an integer number of ms, at least 1/);
  }
});

test("channels/slack-sre.ts refuses an ACK_DELAY_MS that is not an integer", () => {
  const result = startSlack({ ...SLACK_ENV, ACK_DELAY_MS: "20s" });

  assert.notEqual(result.status, 0, "channel must exit non-zero");
  assert.match(result.stderr, /ACK_DELAY_MS must be an integer number of ms, at least 0/);
});
