// Tests for the webhook TLS front door. Run with: npm test
//
// The Caddyfile is what keeps the webhook secret and alert payloads off the wire in
// cleartext. It must expose only the two webhook paths, forward them to loopback, and
// take its hostname from the environment rather than baking in a deployment.

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

test("only /alert and /trivy are forwarded, both to loopback", () => {
  const proxied = [...config.matchAll(/handle (\S+) \{\s*reverse_proxy (\S+)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(proxied, [
    ["/alert", "127.0.0.1:{$SIGNOZ_WEBHOOK_PORT:8788}"],
    ["/trivy", "127.0.0.1:{$TRIVY_WEBHOOK_PORT:8790}"],
  ]);
  assert.match(config, /handle \{\s*respond 404/);
});

test("caddy accepts the config", { skip: !hasCaddy && "caddy not installed" }, () => {
  const result = spawnSync("caddy", ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"], {
    env: { ...process.env, SRE_AGENT_HOSTNAME: "sre-agent.example.invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
