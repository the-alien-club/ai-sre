// Tests for the startup port waits. Run with: npm test
//
// start-agent.sh used to wait for the webhook ports and carry on regardless, so a channel
// that never started left the agent live with no alert ingestion. wait_for_port then failed
// the start, but accepted any listener: a channel left over from the session being
// replaced still held the port, the new channel died with EADDRINUSE, and the check passed
// on the old one. These tests drive the waits against real sockets and real processes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { readFileSync } from "node:fs";
import { once } from "node:events";

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

/** A child process listening on an ephemeral port, for a listener under this process. */
async function childListener(): Promise<{ child: ChildProcess; port: number }> {
  const child = spawn(process.execPath, [
    "-e",
    "const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port));",
  ]);
  const [chunk] = (await once(child.stdout!, "data")) as [Buffer];
  return { child, port: Number(chunk.toString().trim()) };
}

/** A process that is not an ancestor of anything here, to stand in for another session. */
function unrelatedProcess(): ChildProcess {
  return spawn("sleep", ["30"]);
}

/** Run a wait function in bash; async so listeners in this process keep serving. */
function waitIn(fn: string, ...args: (string | number)[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", `source scripts/lib/wait-for-port.sh && ${fn} test ${args.join(" ")}`]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("succeeds when the session process itself listens on the port", async () => {
  const server = await listen();
  try {
    const result = await waitIn("wait_for_port", portOf(server), 5, process.pid);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`bound \\(pid ${process.pid}\\)`));
  } finally {
    server.close();
  }
});

test("succeeds when a process under the session listens on the port", async () => {
  const { child, port } = await childListener();
  try {
    const result = await waitIn("wait_for_port", port, 5, process.pid);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`bound \\(pid ${child.pid}\\)`));
  } finally {
    child.kill();
  }
});

test("a listener outside the session does not count, and is named", async () => {
  const server = await listen();
  const other = unrelatedProcess();
  try {
    const result = await waitIn("wait_for_port", portOf(server), 1, other.pid!);
    assert.equal(result.status, 1, "a stale listener must not satisfy the wait");
    assert.match(result.stderr, new RegExp(`is held by pid ${process.pid} \\(.*node.*\\), not by this session \\(pid ${other.pid}\\)`));
  } finally {
    other.kill();
    server.close();
  }
});

test("fails once the timeout passes with nothing listening", async () => {
  const server = await listen();
  const port = portOf(server);
  server.close();
  const result = await waitIn("wait_for_port", port, 1, process.pid);
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
    const result = await waitIn("wait_for_port", shorter, 1, process.pid);
    assert.equal(result.status, 1, `port ${shorter} must not match listener on ${portOf(server)}`);
  } finally {
    server.close();
  }
});

test("refuses a session PID that is not a number", async () => {
  const result = await waitIn("wait_for_port", 8788, 1, "''");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a PID/);
});

test("wait_for_port_free succeeds at once when nothing listens", async () => {
  const server = await listen();
  const port = portOf(server);
  server.close();
  const result = await waitIn("wait_for_port_free", port, 1);
  assert.equal(result.status, 0, result.stderr);
});

test("wait_for_port_free waits for the old listener to release the port", async () => {
  const { child, port } = await childListener();
  setTimeout(() => child.kill(), 1_500);
  const result = await waitIn("wait_for_port_free", port, 10);
  assert.equal(result.status, 0, result.stderr);
});

test("wait_for_port_free fails on a port that stays held, naming the holder", async () => {
  const server = await listen();
  try {
    const result = await waitIn("wait_for_port_free", portOf(server), 1);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`still held by pid ${process.pid} \\(.*node`));
  } finally {
    server.close();
  }
});

test("start-agent.sh frees the ports, then accepts only its own session's listeners", () => {
  const launcher = readFileSync("scripts/start-agent.sh", "utf8");
  const at = (pattern: RegExp) => {
    const match = pattern.exec(launcher);
    assert.ok(match, `start-agent.sh must contain ${pattern}`);
    return match.index;
  };
  const kill = at(/tmux kill-session -t "\$SESSION_NAME"/);
  const free = at(/if ! wait_for_port_free "SigNoz webhook"[\s\S]*?\|\| ! wait_for_port_free "Trivy webhook"[\s\S]*?exit 1\s*\nfi/);
  const start = at(/tmux new-session -d -s "\$SESSION_NAME"/);
  const pid = at(/SESSION_PID="\$\(tmux display-message -p -t "\$SESSION_NAME" '#\{pane_pid\}'\)"/);
  const bound = at(/if ! wait_for_port "SigNoz webhook" "\$SIGNOZ_PORT" \d+ "\$SESSION_PID"[\s\S]*?\|\| ! wait_for_port "Trivy webhook" "\$TRIVY_PORT" \d+ "\$SESSION_PID"[\s\S]*?exit 1\s*\nfi/);
  assert.ok(kill < free && free < start && start < pid && pid < bound, "kill, free, start, read PID, then wait for bind");
  assert.doesNotMatch(launcher, /grep -q 87(88|90)/);
});
