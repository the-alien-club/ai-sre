// Tests for .mcp.json. Run with: npm test
//
// .mcp.json is tracked and copied to the VM on every deploy. When it held the SigNoz key
// inline, the deployed copy had to be hand-edited after each deploy and the real key sat in
// a tracked path one `git add` away from GitLab. Every credential is now a ${VAR} reference
// resolved from the git-ignored .env; these tests keep it that way.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface McpConfig {
  mcpServers: Record<string, { env?: Record<string, string> }>;
}

const REFERENCE = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

function serverEnvValues(): [string, string][] {
  const config = JSON.parse(readFileSync(".mcp.json", "utf8")) as McpConfig;
  return Object.values(config.mcpServers).flatMap((server) => Object.entries(server.env ?? {}));
}

test("every MCP server env value is a ${VAR} reference, never a literal", () => {
  const values = serverEnvValues();
  assert.ok(values.length > 0, "expected at least the SigNoz MCP server env");
  for (const [name, value] of values) {
    assert.match(value, REFERENCE, `${name} must be a \${VAR} reference, not an inline value`);
  }
});

test("every referenced variable is documented in .env.example", () => {
  const documented = new Set(
    readFileSync(".env.example", "utf8")
      .split("\n")
      .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
      .filter((name): name is string => name !== undefined),
  );
  for (const [, value] of serverEnvValues()) {
    const variable = value.match(REFERENCE)?.[1];
    assert.ok(variable && documented.has(variable), `${variable} is referenced but missing from .env.example`);
  }
});
