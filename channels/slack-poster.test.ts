// Tests for bounded, single-attempt Slack posting. Run with: npm test
//
// These drive the real WebClient, built exactly as slack-sre.ts builds it, against a local
// HTTP server standing in for Slack: a post that outlives the timeout must fail once and
// never be sent again behind the caller's back, and the caller must be able to tell
// "Slack refused" (safe to retry) from "outcome unknown" (it may be visible).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSlackPostClient, createSlackPoster, SlackPostRejected } from "./slack-poster.js";

const TIMEOUT_MS = 200;

async function fakeSlack(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const poster = createSlackPoster(createSlackPostClient("xoxb-test", TIMEOUT_MS, `http://127.0.0.1:${port}/api/`), TIMEOUT_MS);
  return {
    poster,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

test("a post that outlives the timeout fails once, of unknown outcome, and is never retried", async (t) => {
  const slack = await fakeSlack(() => {
    // Never answers within the timeout
  });
  t.after(slack.close);

  await assert.rejects(
    slack.poster.post({ channel: "C0TEAM", text: "escalation" }),
    (err: unknown) => err instanceof Error && !(err instanceof SlackPostRejected)
  );
  // Long enough for a retrying client to have tried again: Bolt's default client, with this
  // timeout, sends its first retry about 1 s after the first attempt
  await new Promise((resolve) => setTimeout(resolve, 2_000));

  assert.deepEqual(slack.requests, ["/api/chat.postMessage"]);
});

test("a post Slack answers is returned with its ts", async (t) => {
  const slack = await fakeSlack((_req, res) => json(res, 200, { ok: true, ts: "1730000001.000100", channel: "C0TEAM" }));
  t.after(slack.close);

  assert.equal(await slack.poster.post({ channel: "C0TEAM", text: "hello" }), "1730000001.000100");
});

test("an API error is a refusal: nothing was posted", async (t) => {
  const slack = await fakeSlack((_req, res) => json(res, 200, { ok: false, error: "channel_not_found" }));
  t.after(slack.close);

  await assert.rejects(slack.poster.post({ channel: "C0NOPE", text: "hello" }), SlackPostRejected);
  assert.equal(slack.requests.length, 1);
});

test("a rate limit is a refusal, not a wait and a retry", async (t) => {
  const slack = await fakeSlack((_req, res) => json(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": "1" }));
  t.after(slack.close);

  await assert.rejects(slack.poster.post({ channel: "C0TEAM", text: "hello" }), SlackPostRejected);
  assert.equal(slack.requests.length, 1);
});

test("a server error is of unknown outcome and is not retried", async (t) => {
  const slack = await fakeSlack((_req, res) => json(res, 500, { ok: false }));
  t.after(slack.close);

  await assert.rejects(
    slack.poster.post({ channel: "C0TEAM", text: "hello" }),
    (err: unknown) => err instanceof Error && !(err instanceof SlackPostRejected)
  );
  assert.equal(slack.requests.length, 1);
});

test("findRecent returns the newest message by the author containing the needle", async (t) => {
  const slack = await fakeSlack((_req, res) =>
    json(res, 200, {
      ok: true,
      messages: [
        { ts: "3.0", user: "U0OTHER", text: "Alert fingerprint: `a1b2`" },
        { ts: "2.0", user: "U0BOT", text: "escalation\n_Alert fingerprint: `a1b2`_" },
        { ts: "1.0", user: "U0BOT", text: "escalation\n_Alert fingerprint: `ffff`_" },
      ],
    })
  );
  t.after(slack.close);

  assert.equal(await slack.poster.findRecent("C0TEAM", "U0BOT", "Alert fingerprint: `a1b2`", 0), "2.0");
  assert.equal(await slack.poster.findRecent("C0TEAM", "U0BOT", "Alert fingerprint: `zzzz`", 0), undefined);
  assert.match(slack.requests[0], /^\/api\/conversations\.history/);
});
