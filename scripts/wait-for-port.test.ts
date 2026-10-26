// Tests for the startup port wait. Run with: npm test
//
// start-agent.sh used to wait for the webhook ports and carry on regardless, so a channel
// that never started left the agent live with no alert ingestion. wait_for_port now fails
// the start, and these tests drive it against real sockets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";

function listen(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** Run wait_for_port in bash; async so the listener in this process keeps serving. */
function waitForPort(port: number, timeout: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `source scripts/lib/wait-for-port.sh && wait_for_port test ${port} ${timeout}`]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("succeeds when the port is listening", async () => {
  const server = await listen();
  try {
    const result = await waitForPort(portOf(server), 5);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bound/);
  } finally {
    server.close();
  }
});

test("fails once the timeout passes with nothing listening", async () => {
  const server = await listen();
  const port = portOf(server);
  server.close();
  const result = await waitForPort(port, 1);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not bound after 1s/);
});

test("matches the exact port, not a longer one containing it", async () => {
  // Ephemeral ports are 5 digits; their first 4 digits are a port that `ss | grep -q`
  // would have matched as a substring (":45678" contains ":4567")
  const server = await listen();
  try {
    assert.ok(portOf(server) >= 10000, "expected a 5-digit ephemeral port");
    const shorter = Number(String(portOf(server)).slice(0, 4));
    const result = await waitForPort(shorter, 1);
    assert.equal(result.status, 1, `port ${shorter} must not match listener on ${portOf(server)}`);
  } finally {
    server.close();
  }
});

test("start-agent.sh exits non-zero when a channel port never binds", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  assert.match(launcher, /if ! wait_for_port "SigNoz webhook"[\s\S]*\|\| ! wait_for_port "Trivy webhook"[\s\S]*?exit 1\s*\nfi/);
  assert.doesNotMatch(launcher, /grep -q 87(88|90)/);
});
