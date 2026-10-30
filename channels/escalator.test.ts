// Tests for the escalate tool's one-thread-per-alert rule. Run with: npm test
//
// A second escalate for a fingerprint that is still waiting used to post a new top-level
// message and overwrite the record, orphaning the first thread: replies there no longer
// stopped the nag loop. It must answer with the first thread and leave the record alone.
//
// A post that timed out may have landed anyway. The error goes back to the agent as a tool
// result, and a later escalate must find the landed message rather than post a second one.
//
// Joining is not always right (2026-10-30: a 27-hour-old warning thread absorbed the disk
// alert of a prod outage, and nobody was paged). A more severe or stale request re-pages with
// a new top-level message that supersedes the waiting thread, and a prod critical that joins
// a fresh thread is paged in it, broadcast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { escalationsForThread, type Escalation } from "./escalation-store.js";
import { createEscalator, fingerprintMarker, parseEscalateArgs, type EscalateRequest } from "./escalator.js";
import { SlackPostRejected, type SlackMessage, type SlackPoster } from "./slack-poster.js";
import { OperationTimeoutError } from "./with-timeout.js";

const CHANNEL = "C0TEAM";
const BOT = "U0BOT";

function request(overrides: Partial<EscalateRequest> = {}): EscalateRequest {
  return {
    alertFingerprint: "a1b2c3d4e5f60718",
    alertName: "High Error Rate",
    severity: "critical",
    environment: "prod",
    message: "5xx above 5% on backend-prod since 08:40.",
    raisedFrom: undefined,
    ...overrides,
  };
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const STALE_CRITICAL = 2 * HOUR;
const STALE_OTHER = 24 * HOUR;
const FP = "a1b2c3d4e5f60718";

/** What one post does: land and answer, land but time out, or be refused. */
type PostBehaviour = "ok" | "timeout_but_landed" | "timeout_lost" | "rejected";

function harness(options: { postDelay?: Promise<void>; behaviours?: PostBehaviour[]; historyFails?: boolean } = {}) {
  let clock = Date.parse("2026-10-28T09:00:00Z");
  let ts = 1_730_000_000;
  const behaviours = [...(options.behaviours ?? [])];
  const posts: SlackMessage[] = [];
  // What is visible in the channel, newest first, as conversations.history returns it
  const channel: Array<{ ts: string; text: string; user: string }> = [];
  const lookups: Array<{ needle: string; oldestMs: number }> = [];
  const remembered: string[] = [];
  const escalations = new Map<string, Escalation>();
  let persisted = 0;
  const poster: SlackPoster = {
    async post(message) {
      posts.push(message);
      await options.postDelay;
      const behaviour = behaviours.shift() ?? "ok";
      if (behaviour === "rejected") throw new SlackPostRejected("slack chat.postMessage refused: channel_not_found");
      if (behaviour === "timeout_lost") throw new OperationTimeoutError("slack chat.postMessage", 20_000);
      const posted = { ts: `${++ts}.000100`, text: message.text, user: BOT };
      channel.unshift(posted);
      if (behaviour === "timeout_but_landed") throw new OperationTimeoutError("slack chat.postMessage", 20_000);
      return posted.ts;
    },
    async findRecent(_channel, author, needle, oldestMs) {
      lookups.push({ needle, oldestMs });
      if (options.historyFails) throw new Error("slack conversations.history timed out after 20000 ms");
      return channel.find((m) => m.user === author && m.text.includes(needle))?.ts;
    },
  };
  const escalator = createEscalator({
    channel: CHANNEL,
    operatorMentions: "<@U1> <@U2>",
    escalations,
    persist: () => {
      persisted++;
    },
    poster,
    botUserId: () => BOT,
    rememberThread: (thread) => remembered.push(thread),
    threadLink: (ch, thread) => `https://alien.slack.com/archives/${ch}/p${thread.replace(".", "")}`,
    staleAfter: { criticalMs: STALE_CRITICAL, otherMs: STALE_OTHER },
    now: () => clock,
  });
  return {
    escalator,
    escalations,
    posts,
    lookups,
    remembered,
    persisted: () => persisted,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("escalate twice for one warning posts once; the second call joins the first thread without a page", async () => {
  const h = harness();

  const first = await h.escalator.escalate(request({ severity: "warning" }));
  const record = structuredClone(h.escalations.get(FP));
  h.advance(10 * MINUTE);
  const second = await h.escalator.escalate(request({ severity: "warning", message: "still broken" }));

  assert.equal(h.posts.length, 1);
  assert.deepEqual(first, { kind: "posted", channel: CHANNEL, ts: "1730000001.000100", superseded: undefined, recovered: false });
  assert.deepEqual(second, { kind: "deduplicated", channel: CHANNEL, ts: "1730000001.000100", page: { status: "not_needed" } });
  // The nag record keeps its thread, timers and count; only the last request time moves
  assert.deepEqual(h.escalations.get(FP), { ...record, lastRequestedAt: Date.parse("2026-10-28T09:10:00Z") });
});

test("the first escalation is recorded for the nag loop and its thread remembered", async () => {
  const h = harness();

  await h.escalator.escalate(request());

  assert.deepEqual(h.escalations.get("a1b2c3d4e5f60718"), {
    alertFingerprint: "a1b2c3d4e5f60718",
    alertName: "High Error Rate",
    severity: "critical",
    environment: "prod",
    slackThreadTs: "1730000001.000100",
    slackChannel: CHANNEL,
    escalatedAt: Date.parse("2026-10-28T09:00:00Z"),
    lastNagAt: Date.parse("2026-10-28T09:00:00Z"),
    acknowledged: false,
    acknowledgedBy: undefined,
    nagCount: 0,
    superseded: false,
    earlierThreadTs: [],
    lastRequestedAt: Date.parse("2026-10-28T09:00:00Z"),
  });
  assert.deepEqual(h.remembered, ["1730000001.000100"]);
  assert.match(h.posts[0].text, /<@U1> <@U2>/);
});

test("two concurrent escalations for one fingerprint post once", async () => {
  let release: () => void = () => {};
  const h = harness({ postDelay: new Promise<void>((resolve) => (release = resolve)) });

  const first = h.escalator.escalate(request());
  const second = h.escalator.escalate(request());
  release();

  assert.deepEqual(await Promise.all([first, second]), [
    { kind: "posted", channel: CHANNEL, ts: "1730000001.000100", superseded: undefined, recovered: false },
    { kind: "deduplicated", channel: CHANNEL, ts: "1730000001.000100", page: { status: "not_needed" } },
  ]);
  assert.equal(h.posts.length, 1);
});

test("an acknowledged escalation can be escalated afresh", async () => {
  const h = harness();
  await h.escalator.escalate(request());
  const record = h.escalations.get("a1b2c3d4e5f60718");
  assert.ok(record);
  record.acknowledged = true;
  record.acknowledgedBy = "Leo";

  const again = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.deepEqual(again, { kind: "posted", channel: CHANNEL, ts: "1730000002.000100", superseded: undefined, recovered: false });
  assert.equal(h.escalations.get(FP)?.acknowledged, false);
  // An answered escalation is history: its thread does not acknowledge the new one
  assert.deepEqual(h.escalations.get(FP)?.earlierThreadTs, []);
});

test("different fingerprints get their own threads", async () => {
  const h = harness();

  await h.escalator.escalate(request());
  await h.escalator.escalate(request({ alertFingerprint: "ffff0000ffff0000" }));

  assert.equal(h.posts.length, 2);
  assert.equal(h.escalations.size, 2);
});

test("a warning does not page the operators", async () => {
  const h = harness();

  await h.escalator.escalate(request({ severity: "warning" }));

  assert.doesNotMatch(h.posts[0].text, /<@U1>/);
});

test("the escalation names its fingerprint, so a timed-out post can be found later", async () => {
  const h = harness();

  await h.escalator.escalate(request());

  assert.ok(h.posts[0].text.includes(fingerprintMarker("a1b2c3d4e5f60718")));
});

test("a timed-out escalate rejects, records nothing, and a later retry adopts the landed thread instead of posting again", async () => {
  const h = harness({ behaviours: ["timeout_but_landed"] });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  assert.equal(h.escalations.size, 0);
  assert.equal(h.posts.length, 1);

  h.advance(2 * 60 * 1000);
  const retry = await h.escalator.escalate(request({ message: "retrying after a timeout" }));

  assert.equal(h.posts.length, 1, "no second message in the channel");
  assert.deepEqual(retry, { kind: "posted", channel: CHANNEL, ts: "1730000001.000100", superseded: undefined, recovered: true });
  assert.equal(h.escalations.get("a1b2c3d4e5f60718")?.slackThreadTs, "1730000001.000100");
  assert.deepEqual(h.remembered, ["1730000001.000100"]);
  // The lookup starts before the first attempt, so Slack's clock may lag ours
  assert.equal(h.lookups.length, 1);
  assert.ok(h.lookups[0].oldestMs < Date.parse("2026-10-28T09:00:00Z"));
});

test("a timed-out escalate that never landed is posted on the retry", async () => {
  const h = harness({ behaviours: ["timeout_lost", "ok"] });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  const retry = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.equal(h.lookups.length, 1);
  assert.equal(retry.kind, "posted");
  assert.equal(retry.kind === "posted" && retry.recovered, false);
  assert.ok(h.escalations.has("a1b2c3d4e5f60718"));
});

test("after a timeout, an unreadable history refuses the retry instead of risking a second thread", async () => {
  const h = harness({ behaviours: ["timeout_but_landed"], historyFails: true });

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  await assert.rejects(h.escalator.escalate(request()), /may be visible, and the channel history could not be checked/);

  assert.equal(h.posts.length, 1);
  assert.equal(h.escalations.size, 0);
});

test("a refused post is certain: the retry posts without a history lookup", async () => {
  const h = harness({ behaviours: ["rejected", "ok"] });

  await assert.rejects(h.escalator.escalate(request()), SlackPostRejected);
  await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2);
  assert.equal(h.lookups.length, 0);
});

// -- Re-paging (A), paging inside a waiting thread (C) ---------------------------------------

test("the 2026-10-30 disk alert: a critical escalation of a fingerprint waiting 27 h as a warning posts a new top-level page", async () => {
  const h = harness();
  await h.escalator.escalate(request({ severity: "warning", alertName: "Postgres Disk Above 85%" }));
  h.advance(27 * HOUR);

  const outcome = await h.escalator.escalate(
    request({
      alertName: "Postgres Disk Above 85%",
      severity: "critical",
      raisedFrom: { severity: "warning", reason: "disk at 98%, cause of the read-only Postgres outage" },
      message: "Prod Postgres is read-only: the disk is full.",
    })
  );

  assert.equal(h.posts.length, 2);
  assert.equal(h.posts[1].thread_ts, undefined, "a top-level message, not a reply in the quiet thread");
  assert.match(h.posts[1].text, /<@U1> <@U2>/);
  assert.match(h.posts[1].text, /\*Re-paged:\* severity raised from warning to critical/);
  assert.match(h.posts[1].text, /<https:\/\/alien\.slack\.com\/archives\/C0TEAM\/p1730000001000100\|here>/);
  assert.match(h.posts[1].text, /\*Severity raised from warning:\* disk at 98%/);
  assert.ok(h.posts[1].text.includes(fingerprintMarker(FP)));
  assert.deepEqual(outcome, {
    kind: "posted",
    channel: CHANNEL,
    ts: "1730000002.000100",
    superseded: { ts: "1730000001.000100", reason: "severity raised from warning to critical" },
    recovered: false,
  });

  // The nag loop now follows the new thread; the old one is kept only to acknowledge
  const record = h.escalations.get(FP);
  assert.equal(record?.slackThreadTs, "1730000002.000100");
  assert.equal(record?.severity, "critical");
  assert.equal(record?.nagCount, 0);
  assert.deepEqual(record?.earlierThreadTs, ["1730000001.000100"]);
});

test("a critical joining a critical thread older than the staleness window re-pages it", async () => {
  const h = harness();
  await h.escalator.escalate(request());
  h.advance(STALE_CRITICAL + MINUTE);

  const outcome = await h.escalator.escalate(request({ message: "Database Errors again, 85k error spans" }));

  assert.equal(h.posts.length, 2);
  assert.equal(outcome.kind, "posted");
  assert.match(h.posts[1].text, /\*Re-paged:\* the earlier thread has waited 2 h unacknowledged/);
  assert.match(h.posts[1].text, /<@U1> <@U2>/);
});

test("a warning re-pages a waiting thread only after the longer warning window, and without a mention", async () => {
  const h = harness();
  await h.escalator.escalate(request({ severity: "warning" }));

  h.advance(STALE_CRITICAL + MINUTE);
  assert.equal((await h.escalator.escalate(request({ severity: "warning" }))).kind, "deduplicated");

  h.advance(STALE_OTHER);
  const outcome = await h.escalator.escalate(request({ severity: "warning" }));

  assert.equal(outcome.kind, "posted");
  assert.equal(h.posts.length, 2);
  assert.doesNotMatch(h.posts[1].text, /<@U1>/);
  assert.match(h.posts[1].text, /the earlier thread has waited 26 h unacknowledged/);
});

test("a re-page chain keeps every earlier thread, and a reply in any of them finds the live record", async () => {
  const h = harness();
  await h.escalator.escalate(request({ severity: "info" }));
  await h.escalator.escalate(request({ severity: "warning" }));
  await h.escalator.escalate(request({ severity: "critical" }));

  const record = h.escalations.get(FP);
  assert.equal(h.posts.length, 3);
  assert.deepEqual(record?.earlierThreadTs, ["1730000001.000100", "1730000002.000100"]);
  for (const thread of ["1730000001.000100", "1730000002.000100", "1730000003.000100"]) {
    assert.deepEqual(escalationsForThread(h.escalations, thread), [record], thread);
  }
});

test("a superseded record never absorbs a new escalation: it posts afresh, linking the retired thread", async () => {
  const h = harness();
  await h.escalator.escalate(request({ severity: "warning" }));
  const old = h.escalations.get(FP);
  assert.ok(old);
  old.superseded = true;

  const outcome = await h.escalator.escalate(request({ severity: "warning" }));

  assert.equal(outcome.kind, "posted");
  assert.equal(outcome.kind === "posted" && outcome.superseded?.reason, "the earlier thread was retired unanswered");
  assert.equal(h.escalations.get(FP)?.superseded, false);
  assert.deepEqual(h.escalations.get(FP)?.earlierThreadTs, ["1730000001.000100"]);
});

test("a prod critical joining a fresh critical thread pages in it, with mentions, broadcast, and no fingerprint line", async () => {
  const h = harness();
  await h.escalator.escalate(request());
  h.advance(30 * MINUTE);

  const outcome = await h.escalator.escalate(request({ message: "Re-fire: Postgres still read-only." }));

  assert.deepEqual(outcome, { kind: "deduplicated", channel: CHANNEL, ts: "1730000001.000100", page: { status: "sent" } });
  assert.equal(h.posts.length, 2);
  const page = h.posts[1];
  assert.equal(page.thread_ts, "1730000001.000100");
  assert.equal(page.reply_broadcast, true);
  assert.match(page.text, /<@U1> <@U2>/);
  assert.match(page.text, /Re-fire: Postgres still read-only\./);
  // The uncertain-post lookup matches on that line; a page must never look like an escalation
  assert.ok(!page.text.includes(fingerprintMarker(FP)));
});

test("a dev or staging critical, and a prod warning, join a fresh thread without paging in it", async () => {
  for (const overrides of [{ environment: "dev" as const }, { environment: "staging" as const }, { severity: "warning" as const }]) {
    const h = harness();
    await h.escalator.escalate(request(overrides));
    const outcome = await h.escalator.escalate(request(overrides));

    assert.deepEqual(outcome, { kind: "deduplicated", channel: CHANNEL, ts: "1730000001.000100", page: { status: "not_needed" } });
    assert.equal(h.posts.length, 1, JSON.stringify(overrides));
  }
});

test("a lower severity joins a waiting critical thread and leaves its severity alone", async () => {
  const h = harness();
  await h.escalator.escalate(request());

  const outcome = await h.escalator.escalate(request({ severity: "warning" }));

  assert.equal(outcome.kind, "deduplicated");
  assert.equal(h.escalations.get(FP)?.severity, "critical");
});

test("a page that fails inside the waiting thread is reported, and the thread stands", async () => {
  const h = harness({ behaviours: ["ok", "rejected"] });
  await h.escalator.escalate(request());

  const outcome = await h.escalator.escalate(request());

  assert.equal(outcome.kind, "deduplicated");
  assert.equal(outcome.kind === "deduplicated" && outcome.page.status, "failed");
  assert.equal(h.escalations.get(FP)?.slackThreadTs, "1730000001.000100");
});

test("a re-page that timed out is found on the retry, not posted twice, and not confused with the thread it replaces", async () => {
  const h = harness({ behaviours: ["ok", "timeout_but_landed"] });
  await h.escalator.escalate(request({ severity: "warning" }));

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  // The quiet thread still holds the record until the re-page is known to have landed
  assert.equal(h.escalations.get(FP)?.slackThreadTs, "1730000001.000100");

  const retry = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 2, "the landed re-page is adopted");
  assert.equal(retry.kind, "posted");
  assert.equal(retry.ts, "1730000002.000100");
  assert.equal(retry.kind === "posted" && retry.recovered, true);
  assert.deepEqual(h.escalations.get(FP)?.earlierThreadTs, ["1730000001.000100"]);
});

test("a re-page that never landed is posted on the retry, even though the history holds the thread it replaces", async () => {
  const h = harness({ behaviours: ["ok", "timeout_lost", "ok"] });
  await h.escalator.escalate(request({ severity: "warning" }));

  await assert.rejects(h.escalator.escalate(request()), OperationTimeoutError);
  const retry = await h.escalator.escalate(request());

  assert.equal(h.posts.length, 3, "two attempts after the first post");
  assert.equal(retry.kind === "posted" && retry.recovered, false);
  assert.equal(h.escalations.get(FP)?.slackThreadTs, "1730000002.000100");
});

// -- The tool's arguments --------------------------------------------------------------------

const ARGS = {
  alert_fingerprint: FP,
  alert_name: "Postgres Disk Above 85%",
  severity: "critical",
  environment: "prod",
  message: "Disk full; Postgres is read-only.",
};

test("escalate arguments become a request", () => {
  assert.deepEqual(parseEscalateArgs(ARGS), {
    request: {
      alertFingerprint: FP,
      alertName: "Postgres Disk Above 85%",
      severity: "critical",
      environment: "prod",
      message: "Disk full; Postgres is read-only.",
      raisedFrom: undefined,
    },
  });
});

test("a raised severity carries what it was raised from and why", () => {
  const parsed = parseEscalateArgs({ ...ARGS, raised_from: "warning", raise_reason: "disk at 98%, cause of the outage" });
  assert.ok("request" in parsed);
  assert.deepEqual(parsed.request.raisedFrom, { severity: "warning", reason: "disk at 98%, cause of the outage" });
});

test("malformed escalate arguments are refused with a reason, never thrown", () => {
  const refusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...ARGS, severity: "page" }, /severity/],
    [{ ...ARGS, environment: "production" }, /environment/],
    [{ ...ARGS, alert_fingerprint: "  " }, /alert_fingerprint/],
    [{ ...ARGS, raised_from: "warning" }, /raised_from and raise_reason go together/],
    [{ ...ARGS, raise_reason: "because" }, /raised_from and raise_reason go together/],
    [{ ...ARGS, severity: "warning", raised_from: "warning", raise_reason: "same" }, /not above raised_from/],
    [{ ...ARGS, severity: "warning", raised_from: "critical", raise_reason: "lower" }, /not above raised_from/],
  ];
  for (const [args, reason] of refusals) {
    const parsed = parseEscalateArgs(args);
    assert.ok("error" in parsed, JSON.stringify(args));
    assert.match(parsed.error, reason);
    assert.match(parsed.error, /nothing was posted/);
  }
  assert.ok("error" in parseEscalateArgs(undefined));
});
