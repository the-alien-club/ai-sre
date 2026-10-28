// Tests for the webhook TLS front door. Run with: npm test
//
// The Caddyfile is what keeps the webhook secret and alert payloads off the wire in
// cleartext. It must expose only the two webhook paths and the SigNoz channel's two GET
// health checks (sentinel's `sre_agent` hop probes /health/session), forward them to
// loopback, and take its hostname from the environment rather than baking in a deployment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CADDYFILE = "provision/caddy/Caddyfile";
const config = readFileSync(CADDYFILE, "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

const hasCaddy = spawnSync("caddy", ["version"], { encoding: "utf8" }).status === 0;

test("the site address is the SRE_AGENT_HOSTNAME variable, not a literal host", () => {
  assert.match(config, /^\{\$SRE_AGENT_HOSTNAME\} \{/m);
  assert.doesNotMatch(config, /\d+\.\d+\.\d+\.\d+ \{|alien\.club/);
});

test("the webhook paths /alert and /trivy are forwarded, both to loopback", () => {
  const proxied = [...config.matchAll(/handle (\S+) \{[^}]*\}\s*reverse_proxy (\S+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(proxied, [
    ["/alert", "127.0.0.1:{$SIGNOZ_WEBHOOK_PORT:8788}"],
    ["/trivy", "127.0.0.1:{$TRIVY_WEBHOOK_PORT:8790}"],
  ]);
  assert.match(config, /handle \{\s*respond 404/);
});

test("the SigNoz channel's /health and /health/session are exposed, GET only, to loopback", () => {
  const matcher = config.match(/@signoz_health \{([^}]*)\}/);
  assert.ok(matcher, "the @signoz_health matcher is defined");
  const lines = matcher[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.deepEqual(lines, ["method GET", "path /health /health/session"]);

  assert.match(config, /handle @signoz_health \{\s*reverse_proxy 127\.0\.0\.1:\{\$SIGNOZ_WEBHOOK_PORT:8788\}\s*\}/);
  // Exactly three handlers forward anywhere: /alert, /trivy and the health checks
  assert.equal([...config.matchAll(/reverse_proxy /g)].length, 3);
});

test("each proxied path caps the request body", () => {
  const limits = [...config.matchAll(/handle (\S+) \{\s*request_body \{\s*max_size (\S+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(limits, [
    ["/alert", "1MiB"],
    ["/trivy", "16MiB"],
  ]);
});

test("caddy accepts the config", { skip: !hasCaddy && "caddy not installed" }, () => {
  const result = spawnSync("caddy", ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"], {
    env: { ...process.env, SRE_AGENT_HOSTNAME: "sre-agent.example.invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("webhook deliveries are access-logged, without the secret", () => {
  assert.match(config, /log \{\s*output file \/var\/log\/caddy\/sre-agent-access\.log \{\s*roll_size \S+\s*roll_keep \d+\s*\}/);
  // Authorization is redacted by Caddy itself; X-Webhook-Token is not, so it must be dropped
  assert.match(config, /format filter \{\s*request>headers>X-Webhook-Token delete\s*request>uri regexp \\\?\.\*\$ \?REDACTED\s*\}/);
  assert.doesNotMatch(config, /log_credentials/, "logging credentials must stay off");
});
