// Tests for bounded request-body reading. Run with: npm test
//
// An unbounded body read lets one POST exhaust the agent VM's memory. These tests send
// real requests to a local server and check that the limit holds whether or not the
// client declares the size up front.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { readBodyWithLimit, RequestBodyTooLarge } from "./request-body.js";

const LIMIT = 1024;

/** Serve one request through readBodyWithLimit and report what it produced. */
async function exchange(body: string, chunked: boolean): Promise<{ status: number; text: string }> {
  const server = createServer(async (req, res) => {
    try {
      const text = await readBodyWithLimit(req, LIMIT);
      res.writeHead(200).end(text);
    } catch (error) {
      res.writeHead(error instanceof RequestBodyTooLarge ? 413 : 500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    return await new Promise((resolve, reject) => {
      const headers = chunked ? {} : { "content-length": Buffer.byteLength(body) };
      const req = request({ host: "127.0.0.1", port, method: "POST", headers }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      // The server may cut a chunked oversize upload short; the 413 is what matters
      req.on("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNRESET" || error.code === "EPIPE" ? resolve({ status: 413, text: "reset" }) : reject(error),
      );
      req.end(body);
    });
  } finally {
    server.close();
  }
}

test("a body within the limit is returned intact", async () => {
  const body = JSON.stringify({ alerts: [{ status: "firing" }] });
  assert.deepEqual(await exchange(body, false), { status: 200, text: body });
});

test("a body exactly at the limit is accepted", async () => {
  assert.equal((await exchange("x".repeat(LIMIT), false)).status, 200);
});

test("a declared oversize body is rejected before it is read", async () => {
  assert.equal((await exchange("x".repeat(LIMIT + 1), false)).status, 413);
});

test("an undeclared (chunked) oversize body is rejected while streaming", async () => {
  assert.equal((await exchange("x".repeat(LIMIT * 64), true)).status, 413);
});
