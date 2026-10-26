// Tests for the webhook bind address. Run with: npm test
//
// The channels are reached through Caddy TLS. If any layer defaulted to a public
// address, a missed INSTALL step or security-group change would leave the secret and
// alert payloads on the wire in cleartext again, so every layer must default to loopback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const VARIABLES = ["SIGNOZ_WEBHOOK_HOST", "TRIVY_WEBHOOK_HOST"];

test(".env.example binds both channels to loopback", () => {
  const env = readFileSync(".env.example", "utf8");
  for (const variable of VARIABLES) {
    assert.match(env, new RegExp(`^${variable}=127\\.0\\.0\\.1$`, "m"));
  }
});

test("the pm2 config defaults both channels to loopback", () => {
  const ecosystem = readFileSync("ecosystem.config.cjs", "utf8");
  for (const variable of VARIABLES) {
    assert.match(ecosystem, new RegExp(`${variable}: dotenv\\.${variable} \\|\\| "127\\.0\\.0\\.1"`));
  }
});

test("each channel defaults to loopback when the variable is unset", () => {
  for (const [script, variable] of [
    ["channels/signoz-webhook.ts", "SIGNOZ_WEBHOOK_HOST"],
    ["channels/trivy-webhook.ts", "TRIVY_WEBHOOK_HOST"],
  ]) {
    assert.match(readFileSync(script, "utf8"), new RegExp(`process\\.env\\.${variable} \\?\\? "127\\.0\\.0\\.1"`));
  }
});

test("nothing in the repo defaults a webhook to a wildcard address", () => {
  for (const file of [".env.example", "ecosystem.config.cjs", "channels/signoz-webhook.ts", "channels/trivy-webhook.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /0\.0\.0\.0/, file);
  }
});
