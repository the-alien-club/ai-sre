# Playbook: Testing an MCP Server

MCP servers (under `MCPs/mcp-*`) expose tools that the agent invokes. They speak
JSON-RPC over stdio, HTTP, or WebSocket — depending on the deployment.

E2E for MCP servers is **different from UI testing**: there's no browser. We
hit the server's HTTP/stdio surface directly using Playwright's `request`
fixture (or a plain client) and assert on tool behavior.

## What changed in the MR? (from `analyze-mr.md`)

Look at the diff under `MCPs/mcp-*/src/`:

| Change | Test |
|---|---|
| New tool added | Generate a spec that calls `tools/list` then `tools/call` for the new tool |
| Tool input schema changed | Call with old AND new inputs, assert validation behavior |
| Tool handler logic changed | Call with realistic inputs, assert on output |
| Auth/middleware changed | Call without auth (should 401), with valid auth (should 200) |
| Server bootstrap changed | Just hit `tools/list` — confirms the server starts |

## Recipe: list tools

```ts
import { test, expect } from "@playwright/test";

test("mcp-datacluster lists expected tools", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  const toolNames = body.result.tools.map((t: { name: string }) => t.name);
  expect(toolNames).toContain("datacluster_keyword_search");
  expect(toolNames).toContain("datacluster_get_entry_content");
});
```

## Recipe: call a tool

```ts
test("datacluster_keyword_search returns ranked entries", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    data: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "datacluster_keyword_search", arguments: { dataset_id: "test", query: "physics" } },
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.result.content[0].type).toBe("text");
  expect(body.result.isError).not.toBe(true);
});
```

## Recipe: schema validation

```ts
test("missing required arg returns a tool error, not a crash", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MCP_TOKEN}` },
    data: {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "datacluster_keyword_search", arguments: { /* dataset_id missing */ } },
    },
  });
  // The server should respond 200 with isError=true (not 500).
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.result?.isError ?? false).toBe(true);
});
```

## Recipe: auth required

```ts
test("anonymous request is rejected", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
  });
  expect(res.status()).toBe(401);
});
```

## Stdio-based MCP servers

If the server speaks stdio (no HTTP), spawn it as a child process:

```ts
import { spawn } from "node:child_process";
import { test, expect } from "@playwright/test";

test("mcp-base advertises capabilities on init", async () => {
  const proc = spawn("bun", ["run", "../mcp-base/src/server.ts"], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  const chunks: Buffer[] = [];
  for await (const chunk of proc.stdout) {
    chunks.push(chunk);
    const buf = Buffer.concat(chunks).toString();
    if (buf.includes('"id":1')) {
      const line = buf.split("\n").find((l) => l.includes('"id":1'))!;
      const resp = JSON.parse(line);
      expect(resp.result.capabilities).toBeDefined();
      proc.kill();
      return;
    }
  }
});
```

Stdio tests are slower and brittler. Prefer HTTP if the server supports it.

## Things to NOT test

- The actual third-party API behavior (e.g., the OpenAIRE upstream). Mock those
  via `page.route` or a fake upstream — the MCP server's job is to translate
  requests, not to validate that OpenAIRE is up.
- Latency targets — that's the SRE agent's domain via SigNoz.
