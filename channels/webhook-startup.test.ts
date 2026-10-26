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
