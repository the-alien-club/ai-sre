// Tests for the Rundeck client. Run with: npm test
//
// No network: fetch is stubbed. What matters is that the endpoint and token are required and
// never defaulted, that the token cannot travel in clear over the internet, that a run sends
// exactly the options it was given, that every call is bounded, and that a Rundeck refusal
// surfaces as an error carrying Rundeck's own error code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRundeckClient, readRundeckConfig, RundeckError, type FetchLike } from "./rundeck-client.js";
import { OperationTimeoutError } from "./with-timeout.js";

const CONFIG = { baseUrl: "http://10.66.0.1:30440", apiToken: "agent-token" };
const JOB_ID = "cc3859db-5289-5e1c-8c0b-4e4c31a7dd88";

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

test("the URL and token are both required, with no default", () => {
  assert.throws(() => readRundeckConfig({}), /RUNDECK_URL, RUNDECK_API_TOKEN are not set/);
  assert.throws(() => readRundeckConfig({ RUNDECK_URL: "http://10.66.0.1:30440", RUNDECK_API_TOKEN: "  " }), /^Error: RUNDECK_API_TOKEN is not set/);
  assert.throws(() => readRundeckConfig({ RUNDECK_API_TOKEN: "t" }), /^Error: RUNDECK_URL is not set/);
});

test("plain http is accepted only to a private address, the WireGuard peer", () => {
  const env = { RUNDECK_API_TOKEN: "t" };
  assert.deepEqual(readRundeckConfig({ ...env, RUNDECK_URL: "http://10.66.0.1:30440/" }), { baseUrl: "http://10.66.0.1:30440", apiToken: "t" });
  assert.equal(readRundeckConfig({ ...env, RUNDECK_URL: "https://rundeck.example.com" }).baseUrl, "https://rundeck.example.com");
  assert.throws(() => readRundeckConfig({ ...env, RUNDECK_URL: "http://rundeck.example.com:30440" }), /plain http only to a private IPv4/);
  assert.throws(() => readRundeckConfig({ ...env, RUNDECK_URL: "http://51.15.1.2:30440" }), /plain http only to a private IPv4/);
});

test("the URL must be a bare origin", () => {
  const env = { RUNDECK_API_TOKEN: "t" };
  assert.throws(() => readRundeckConfig({ ...env, RUNDECK_URL: "http://10.66.0.1:30440/api/60" }), /bare origin/);
  assert.throws(() => readRundeckConfig({ ...env, RUNDECK_URL: "10.66.0.1:30440" }), /must be/);
  assert.throws(() => readRundeckConfig({ ...env, RUNDECK_URL: "ftp://10.66.0.1" }), /bare origin|http or https/);
});

test("findJob asks for the exact group and name, with the token and a deadline", async () => {
  const calls: Call[] = [];
  const rundeck = createRundeckClient(CONFIG, {
    fetch: stubFetch(200, [{ id: JOB_ID, group: "actions", name: "restart_otel_agent_pod", project: "sentinel" }], calls),
    timeoutMs: 1000,
  });

  assert.deepEqual(await rundeck.findJob("sentinel", "actions", "restart_otel_agent_pod"), {
    id: JOB_ID,
    group: "actions",
    name: "restart_otel_agent_pod",
  });
  const [{ url, init }] = calls;
  assert.equal(url, "http://10.66.0.1:30440/api/60/project/sentinel/jobs?groupPathExact=actions&jobExactFilter=restart_otel_agent_pod");
  assert.equal(init.method, "GET");
  assert.equal(new Headers(init.headers).get("X-Rundeck-Auth-Token"), "agent-token");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
});

test("findJob refuses anything but exactly one exact match", async () => {
  const lookalike = [{ id: "x", group: "actions/test", name: "restart_otel_agent_pod" }];
  const twice = [
    { id: "a", group: "actions", name: "restart_otel_agent_pod" },
    { id: "b", group: "actions", name: "restart_otel_agent_pod" },
  ];
  for (const listing of [[], lookalike, twice]) {
    const rundeck = createRundeckClient(CONFIG, { fetch: stubFetch(200, listing), timeoutMs: 1000 });
    await assert.rejects(rundeck.findJob("sentinel", "actions", "restart_otel_agent_pod"), /expected exactly one job/);
  }
});

test("jobOptions reads the declared options from the job definition", async () => {
  const calls: Call[] = [];
  const definition = [
    {
      id: JOB_ID,
      options: [
        { name: "target", enforced: true, required: true, values: ["platform-prod/signoz/signoz-k8s-infra-otel-agent"] },
        { name: "fingerprint", required: true, regex: "^[A-Za-z0-9._:-]{1,128}$" },
      ],
    },
  ];
  const rundeck = createRundeckClient(CONFIG, { fetch: stubFetch(200, definition, calls), timeoutMs: 1000 });

  assert.deepEqual(await rundeck.jobOptions(JOB_ID), [
    { name: "target", enforced: true, values: ["platform-prod/signoz/signoz-k8s-infra-otel-agent"] },
    { name: "fingerprint", enforced: false, values: [] },
  ]);
  assert.equal(calls[0].url, `http://10.66.0.1:30440/api/60/job/${JOB_ID}?format=json`);
});

test("runJob posts exactly the given options and returns the execution", async () => {
  const calls: Call[] = [];
  const rundeck = createRundeckClient(CONFIG, {
    fetch: stubFetch(200, { id: 42, permalink: "http://10.66.0.1:30440/project/sentinel/execution/show/42", status: "running" }, calls),
    timeoutMs: 1000,
  });
  const options = { target: "platform-prod/signoz/signoz-k8s-infra-otel-agent", fingerprint: "0123456789abcdef", incident: "none" };

  assert.deepEqual(await rundeck.runJob(JOB_ID, options), {
    id: 42,
    permalink: "http://10.66.0.1:30440/project/sentinel/execution/show/42",
  });
  const [{ url, init }] = calls;
  assert.equal(url, `http://10.66.0.1:30440/api/60/job/${JOB_ID}/run`);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body as string), { options });
});

test("an HTTP error is a RundeckError with the status and Rundeck's error code", async () => {
  const rundeck = createRundeckClient(CONFIG, {
    fetch: stubFetch(400, { error: true, apiversion: 60, errorCode: "api.error.job.options-invalid", message: "Option 'target' value is not allowed" }),
    timeoutMs: 1000,
  });
  await assert.rejects(rundeck.runJob(JOB_ID, {}), (err: unknown) => {
    assert.ok(err instanceof RundeckError);
    assert.equal(err.status, 400);
    assert.equal(err.errorCode, "api.error.job.options-invalid");
    assert.match(err.message, /run job .* failed with HTTP 400: Option 'target' value is not allowed/);
    return true;
  });
});

test("a non-JSON error page still surfaces its status", async () => {
  const rundeck = createRundeckClient(CONFIG, { fetch: stubFetch(503, "<html>Service Unavailable</html>"), timeoutMs: 1000 });
  await assert.rejects(rundeck.runJob(JOB_ID, {}), (err: unknown) => err instanceof RundeckError && err.status === 503 && err.errorCode === undefined);
});

test("an unexpected success shape is an error, never a run without an execution id", async () => {
  const rundeck = createRundeckClient(CONFIG, { fetch: stubFetch(200, { status: "running" }), timeoutMs: 1000 });
  await assert.rejects(rundeck.runJob(JOB_ID, {}), /unexpected response shape/);
});

test("a hung Rundeck fails the call with a timeout", async () => {
  const hanging: FetchLike = (_url, init) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
  const rundeck = createRundeckClient(CONFIG, { fetch: hanging, timeoutMs: 20 });

  await assert.rejects(rundeck.findJob("sentinel", "actions", "restart_otel_agent_pod"), OperationTimeoutError);
});
