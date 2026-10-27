// Tests for the Jira client. Run with: npm test
//
// No network: fetch is stubbed. What matters is that credentials are required, that every
// call is bounded, and that a Jira failure surfaces as an error rather than a silent success.

import { test } from "node:test";
import assert from "node:assert/strict";
import { adfDocument, createJiraClient, JiraError, readJiraConfig, type FetchLike } from "./jira-client.js";
import { OperationTimeoutError } from "./with-timeout.js";

const CONFIG = { baseUrl: "https://example.atlassian.net", email: "sre@example.com", apiToken: "token" };

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

test("all three credentials are required, with no default", () => {
  assert.throws(() => readJiraConfig({}), /JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN are not set/);
  assert.throws(
    () => readJiraConfig({ JIRA_BASE_URL: "https://x.atlassian.net", JIRA_USER_EMAIL: "a@b" }),
    /^Error: JIRA_API_TOKEN is not set/
  );
});

test("the base URL must be an https site root", () => {
  const env = { JIRA_USER_EMAIL: "a@b", JIRA_API_TOKEN: "t" };
  assert.throws(() => readJiraConfig({ ...env, JIRA_BASE_URL: "http://x.atlassian.net" }), /must be an https site root/);
  assert.throws(() => readJiraConfig({ ...env, JIRA_BASE_URL: "https://x.atlassian.net/rest/api/2" }), /must be an https site root/);
  assert.equal(readJiraConfig({ ...env, JIRA_BASE_URL: "https://x.atlassian.net/" }).baseUrl, "https://x.atlassian.net");
});

test("search posts the JQL with basic auth and a deadline", async () => {
  const calls: Call[] = [];
  const jira = createJiraClient(CONFIG, {
    fetch: stubFetch(200, { issues: [{ key: "SDS-1", fields: { summary: "s" } }] }, calls),
    timeoutMs: 1000,
  });

  assert.deepEqual(await jira.search('labels = "trivy"', 1), [{ key: "SDS-1", summary: "s" }]);
  const [{ url, init }] = calls;
  assert.equal(url, "https://example.atlassian.net/rest/api/3/search/jql");
  assert.equal(new Headers(init.headers).get("Authorization"), `Basic ${Buffer.from("sre@example.com:token").toString("base64")}`);
  assert.deepEqual(JSON.parse(init.body as string), { jql: 'labels = "trivy"', maxResults: 1, fields: ["summary"] });
  assert.ok(init.signal instanceof AbortSignal);
});

test("create sends project, type, labels and an ADF description", async () => {
  const calls: Call[] = [];
  const jira = createJiraClient(CONFIG, { fetch: stubFetch(201, { id: "1", key: "SDS-7" }, calls), timeoutMs: 1000 });
  const description = adfDocument([{ paragraph: "p" }, { bullets: ["a"] }]);

  assert.equal(
    await jira.createIssue({ project: "SDS", issueType: "Task", summary: "s", labels: ["trivy"], description }),
    "SDS-7"
  );
  assert.deepEqual(JSON.parse(calls[0].init.body as string).fields, {
    project: { key: "SDS" },
    issuetype: { name: "Task" },
    summary: "s",
    labels: ["trivy"],
    description,
  });
});

test("an HTTP error is a JiraError with the status, never a success", async () => {
  const jira = createJiraClient(CONFIG, { fetch: stubFetch(401, "Unauthorized"), timeoutMs: 1000 });
  await assert.rejects(jira.addComment("SDS-1", adfDocument([])), (err: unknown) => {
    assert.ok(err instanceof JiraError);
    assert.equal(err.status, 401);
    assert.match(err.message, /add comment failed with HTTP 401: Unauthorized/);
    return true;
  });
});

test("an unexpected response shape is an error", async () => {
  const jira = createJiraClient(CONFIG, { fetch: stubFetch(200, { results: [] }), timeoutMs: 1000 });
  await assert.rejects(jira.search("x", 1), /unexpected response shape/);
});

test("a hung Jira fails the call with a timeout", async () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const jira = createJiraClient(CONFIG, { fetch: hanging, timeoutMs: 20 });

  await assert.rejects(jira.search("x", 1), OperationTimeoutError);
});

test("issue links point at the site's browse page", () => {
  const jira = createJiraClient(CONFIG, { fetch: stubFetch(200, {}), timeoutMs: 1000 });
  assert.equal(jira.browseUrl("SDS-9"), "https://example.atlassian.net/browse/SDS-9");
});
