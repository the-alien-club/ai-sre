// Tests for the daily Trivy digest and its Slack posting. Run with: npm test
//
// One message a day, per-image counts by severity in its thread, what is new highlighted,
// and no mention anywhere: a CVE backlog is not a page. An exposed secret pages once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "./trivy-digest.js";
import { emptyState, markDigestSent, recordVulnerabilityReport, type VulnerabilityInput } from "./trivy-findings.js";
import {
  createSlackPoster,
  DigestPartiallyPostedError,
  postDigest,
  secretEscalationText,
  type ChatPoster,
  type SlackPoster,
} from "./trivy-slack.js";
import { OperationTimeoutError } from "./with-timeout.js";

const NOW = Date.UTC(2026, 9, 27, 7, 0);
const DAY = 24 * 60 * 60 * 1000;
const browse = (key: string) => `https://example.atlassian.net/browse/${key}`;

function report(repository: string, tag: string, severities: string[], namespace = "datastreaming-prod"): VulnerabilityInput {
  return {
    artifact: { repository, tag },
    namespace,
    workload: "w",
    vulnerabilities: severities.map((severity, i) => ({
      vulnerabilityID: `CVE-${repository.length}-${i}`,
      resource: `pkg${i}`,
      installedVersion: "1",
      fixedVersion: "2",
      severity,
    })),
  };
}

test("nothing scanned, nothing posted", () => {
  assert.equal(buildDigest(emptyState(), NOW, [], browse), null);
});

test("the summary totals every severity and highlights new images; the thread lists each image", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.3", ["CRITICAL", "HIGH", "MEDIUM"]), NOW);
  recordVulnerabilityReport(state, report("kube-proxy", "v1.35.8", ["LOW"], "kube-system"), NOW);

  const digest = buildDigest(state, NOW, [], browse)!;
  assert.match(digest.summary, /Daily Trivy digest\* — 2026-10-27/);
  assert.match(digest.summary, /2 image\(s\) scanned: 1 critical, 1 high, 1 medium, 1 low; 2 fixable HIGH\/CRITICAL/);
  assert.match(digest.summary, /New since the previous digest\* \(2\)/);
  assert.match(digest.summary, /:new: \*ns-data-streaming\/backend:0\.18\.3\* — new image/);

  const thread = digest.details.join("\n");
  assert.match(thread, /\*Our images \(ns-data-streaming\)\* \(1\):\n• :new: ns-data-streaming\/backend:0\.18\.3 \[datastreaming-prod\] 1\/1\/1\/0, fix 2/);
  assert.match(thread, /\*Third-party images \(upstream upgrades\)\* \(1\):\n• :new: kube-proxy:v1\.35\.8 \[kube-system\] 0\/0\/0\/1, fix 0/);
});

test("the next day highlights only the image with new CVEs, and links its ticket", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.3", ["CRITICAL"]), NOW);
  recordVulnerabilityReport(state, report("keda", "2.16.1", ["HIGH"]), NOW);
  markDigestSent(state, buildDigest(state, NOW, [], browse)!.shown, NOW);

  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.3", ["CRITICAL", "HIGH"]), NOW + DAY);
  recordVulnerabilityReport(state, report("keda", "2.16.1", ["HIGH"]), NOW + DAY);
  state.jiraTickets["ns-data-streaming/backend"] = { issueKey: "SDS-12", cveKeys: [] };

  const tickets = [
    { repository: "ns-data-streaming/backend", issueKey: "SDS-12", action: "commented" as const },
    { repository: "keda", error: "Jira search failed with HTTP 503: down" },
  ];
  const digest = buildDigest(state, NOW + DAY, tickets, browse)!;

  assert.match(digest.summary, /New since the previous digest\* \(1\)/);
  assert.match(digest.summary, /:arrow_up: \*ns-data-streaming\/backend:0\.18\.3\* — 1 new fixable: CVE-\S+ \(high, pkg1\) <https:\/\/example\.atlassian\.net\/browse\/SDS-12\|SDS-12>/);
  assert.doesNotMatch(digest.summary, /keda:2\.16\.1\*/);
  assert.match(digest.summary, /0 ticket\(s\) opened, 1 updated/);
  assert.match(digest.summary, /:warning: Jira update failed for 1 image\(s\), retried at the next digest: keda/);
  assert.match(digest.details.join("\n"), /:arrow_up: \+1 ns-data-streaming\/backend:0\.18\.3/);
});

test("a quiet day says so", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report("keda", "2.16.1", ["HIGH"]), NOW);
  markDigestSent(state, buildDigest(state, NOW, [], browse)!.shown, NOW);
  recordVulnerabilityReport(state, report("keda", "2.16.1", ["HIGH"]), NOW + DAY);

  assert.match(buildDigest(state, NOW + DAY, [], browse)!.summary, /Nothing new since the previous digest/);
});

test("scanned text cannot inject a mention into the digest", () => {
  const state = emptyState();
  recordVulnerabilityReport(state, report("evil/<!channel>", "<@U054PDMV69X>", ["CRITICAL"]), NOW);

  const digest = buildDigest(state, NOW, [], browse)!;
  for (const text of [digest.summary, ...digest.details]) assert.doesNotMatch(text, /<[@!]/);
});

class RecordingPoster implements SlackPoster {
  posts: Array<{ text: string; threadTs?: string }> = [];
  failAfter = Number.POSITIVE_INFINITY;

  async post(text: string, threadTs?: string): Promise<string> {
    if (this.posts.length >= this.failAfter) throw new Error("slack down");
    this.posts.push({ text, threadTs });
    return `ts-${this.posts.length}`;
  }
}

function bigDigest() {
  const state = emptyState();
  for (let i = 0; i < 200; i++) recordVulnerabilityReport(state, report(`registry.example/team/image-${i}`, "1.0.0", ["HIGH"]), NOW);
  return buildDigest(state, NOW, [], browse)!;
}

test("the digest is one top-level message, the per-image lines in its thread", async () => {
  const poster = new RecordingPoster();
  const digest = bigDigest();

  assert.equal(await postDigest(poster, digest), "ts-1");
  assert.equal(poster.posts[0].threadTs, undefined);
  assert.ok(poster.posts.length > 2, "200 images need several thread messages");
  for (const p of poster.posts.slice(1)) {
    assert.equal(p.threadTs, "ts-1");
    assert.ok(p.text.length <= 3500);
  }
});

test("a digest with a mention in it is refused before anything is posted", async () => {
  const poster = new RecordingPoster();
  await assert.rejects(postDigest(poster, { summary: "hi <!here>", details: [], shown: {} }), /contains a mention/);
  assert.equal(poster.posts.length, 0);
});

test("a thread failure after the summary is a partial post, not a retryable failure", async () => {
  const poster = new RecordingPoster();
  poster.failAfter = 2;

  await assert.rejects(postDigest(poster, bigDigest()), (err: unknown) => {
    assert.ok(err instanceof DigestPartiallyPostedError);
    assert.equal(err.summaryTs, "ts-1");
    assert.equal(err.postedChunks, 1);
    return true;
  });
});

test("the Slack poster is bounded and treats a missing ts as a failure", async () => {
  const hung: ChatPoster = { chat: { postMessage: () => new Promise(() => {}) } };
  await assert.rejects(createSlackPoster(hung, "C1", 20).post("x"), OperationTimeoutError);

  const refused: ChatPoster = { chat: { postMessage: async () => ({ ok: false, error: "channel_not_found" }) } };
  await assert.rejects(createSlackPoster(refused, "C1", 1000).post("x"), /channel_not_found/);

  const sent: Array<Record<string, unknown>> = [];
  const ok: ChatPoster = {
    chat: {
      postMessage: async (args) => {
        sent.push(args);
        return { ok: true, ts: "1.2" };
      },
    },
  };
  assert.equal(await createSlackPoster(ok, "C1", 1000).post("x", "0.1"), "1.2");
  assert.deepEqual(sent, [{ channel: "C1", text: "x", thread_ts: "0.1", unfurl_links: false, unfurl_media: false }]);
});

test("an exposed secret pages the operators once, with the finding escaped", () => {
  const text = secretEscalationText(
    {
      image: "ns-data-streaming/mcp:0.1.20",
      workload: "mcp",
      namespace: "prod",
      secrets: [{ ruleID: "aws-access-key-id", category: "AWS", severity: "CRITICAL", title: "AWS <!channel>", target: "/app/settings.py" }],
    },
    "<@U1> <@U2>"
  );

  assert.equal(text.match(/<@/g)?.length, 2, "only the operator mentions page");
  assert.match(text, /AWS &lt;!channel&gt; in `\/app\/settings\.py`/);
  assert.match(text, /Posted once per image build, with no reminders/);
});
