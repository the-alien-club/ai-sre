// Tests for the agent launch command. Run with: npm test
//
// A channel server only delivers events into the session when it is named in
// --dangerously-load-development-channels. A server that is spawned from .mcp.json but
// missing from that list still binds its port and answers 200, so the sender sees success
// while every event is dropped. That is how the Trivy channel went silent; this keeps the
// list and the declared channels in step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface McpConfig {
  mcpServers: Record<string, { command: string; args?: string[] }>;
}

function declaredChannelServers(): string[] {
  const config = JSON.parse(readFileSync(".mcp.json", "utf8")) as McpConfig;
  return Object.entries(config.mcpServers)
    .filter(([, server]) => {
      const script = server.args?.find((arg) => arg.endsWith(".ts"));
      return script !== undefined && readFileSync(script, "utf8").includes('"claude/channel"');
    })
    .map(([name]) => name);
}

function loadedChannelServers(): string[] {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  const flags = launcher.match(/--dangerously-load-development-channels((?:\s+server:[\w-]+)+)/);
  assert.ok(flags, "start-agent.sh must pass --dangerously-load-development-channels");
  return [...flags[1].matchAll(/server:([\w-]+)/g)].map((match) => match[1]);
}

test("every channel server in .mcp.json is loaded as a channel", () => {
  const declared = declaredChannelServers();
  assert.deepEqual(declared.sort(), ["signoz-webhook", "slack-sre", "trivy-webhook"]);
  assert.deepEqual(loadedChannelServers().sort(), declared.sort());
});
