// Tests for the per-image Jira tickets. Run with: npm test
//
// One ticket per image repository, found by its label and commented on rather than filed
// again; a failure leaves the repository unsynced so the next digest retries it.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdfDocument, JiraClient, JiraIssueRef, NewJiraIssue } from "./jira-client.js";
import { emptyState, recordVulnerabilityReport, ticketUpdates, type VulnerabilityInput } from "./trivy-findings.js";
import { imageLabel, syncTickets, ticketSummary } from "./trivy-jira.js";

const NOW = Date.UTC(2026, 9, 27, 7, 0);

function report(repository: string, tag = "1.0", cve = "CVE-1"): VulnerabilityInput {
  return {
    artifact: { repository, tag },
    namespace: "datastreaming-prod",
    workload: "w",
    vulnerabilities: [{ vulnerabilityID: cve, resource: "libssl3", installedVersion: "3.5.7", fixedVersion: "3.5.8", severity: "CRITICAL" }],
  };
}

class FakeJira implements JiraClient {
  issues: Array<NewJiraIssue & { key: string }> = [];
  comments: Array<{ key: string; body: AdfDocument }> = [];
  queries: string[] = [];
  failFor = new Set<string>();

  async search(jql: string): Promise<JiraIssueRef[]> {
    this.queries.push(jql);
    return this.issues.filter((i) => i.labels.some((l) => jql.includes(`"${l}"`))).map((i) => ({ key: i.key, summary: i.summary }));
  }

  async createIssue(issue: NewJiraIssue): Promise<string> {
    if (this.failFor.has(issue.summary)) throw new Error("HTTP 500");
    const key = `SDS-${this.issues.length + 1}`;
    this.issues.push({ ...issue, key });
    return key;
  }

  async addComment(key: string, body: AdfDocument): Promise<void> {
    this.comments.push({ key, body });
  }

  browseUrl(key: string): string {
    return `https://example.atlassian.net/browse/${key}`;
  }
}

test("the dedupe label is derived from the repository alone, not the tag", () => {
  assert.equal(imageLabel("ns-data-streaming/backend"), imageLabel("ns-data-streaming/backend"));
  assert.notEqual(imageLabel("ns-data-streaming/backend"), imageLabel("ns-data-streaming/frontend"));
  assert.match(imageLabel("ghcr.io/org/x"), /^trivy-image-[0-9a-f]{16}$/);
});

test("a repository gets one ticket across tags, then comments, never a duplicate", async () => {
  const state = emptyState();
  const jira = new FakeJira();
  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.2"), NOW);
  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.3"), NOW);

  const first = await syncTickets(state, jira, ticketUpdates(state), { deadline: NOW + 1, now: () => NOW });
  assert.deepEqual(first, [{ repository: "ns-data-streaming/backend", issueKey: "SDS-1", action: "created" }]);
  assert.equal(jira.issues.length, 1);
  assert.deepEqual(jira.issues[0].labels, ["trivy", imageLabel("ns-data-streaming/backend")]);
  assert.equal(jira.issues[0].project, "SDS");
  assert.equal(jira.issues[0].summary, ticketSummary("ns-data-streaming/backend"));
  assert.match(jira.queries[0], /statusCategory != Done/);

  // Nothing new: no Jira call at all
  assert.deepEqual(ticketUpdates(state), []);

  // State lost (or a new CVE): the open ticket is found by label and commented on
  recordVulnerabilityReport(state, report("ns-data-streaming/backend", "0.18.4", "CVE-2"), NOW);
  const second = await syncTickets(state, jira, ticketUpdates(state), { deadline: NOW + 1, now: () => NOW });
  assert.deepEqual(second, [{ repository: "ns-data-streaming/backend", issueKey: "SDS-1", action: "commented" }]);
  assert.equal(jira.issues.length, 1);
  assert.equal(jira.comments.length, 1);
  assert.match(JSON.stringify(jira.comments[0].body), /1 new fixable HIGH\/CRITICAL CVE\(s\).*CVE-2/);
  assert.equal(state.jiraTickets["ns-data-streaming/backend"].issueKey, "SDS-1");
});

test("a failed repository is reported and retried later; the others still sync", async () => {
  const state = emptyState();
  const jira = new FakeJira();
  jira.failFor.add(ticketSummary("broken"));
  recordVulnerabilityReport(state, report("broken"), NOW);
  recordVulnerabilityReport(state, report("fine"), NOW);

  const results = await syncTickets(state, jira, ticketUpdates(state), { deadline: NOW + 1, now: () => NOW });
  assert.deepEqual(results, [
    { repository: "broken", error: "HTTP 500" },
    { repository: "fine", issueKey: "SDS-1", action: "created" },
  ]);
  assert.deepEqual(ticketUpdates(state).map((u) => u.repository), ["broken"]);
});

test("updates past the time budget are not attempted, and stay pending", async () => {
  const state = emptyState();
  const jira = new FakeJira();
  recordVulnerabilityReport(state, report("a"), NOW);
  recordVulnerabilityReport(state, report("b"), NOW);

  let clock = NOW;
  const results = await syncTickets(state, jira, ticketUpdates(state), {
    deadline: NOW + 10,
    now: () => {
      const t = clock;
      clock += 10;
      return t;
    },
  });

  assert.equal(jira.issues.length, 1);
  assert.match(JSON.stringify(results[1]), /not attempted/);
  assert.deepEqual(ticketUpdates(state).map((u) => u.repository), ["b"]);
});
