// Tests for sentinel stage-1 remediation. Run with: npm test
//
// The contract (sentinel signoz/README.md D-8): a firing `remediable` alert starts the Rundeck
// job it names, once per episode, with exactly target, fingerprint and incident=none. Never
// another action, target or node; never a retry of a refusal; nothing on resolve; and no
// Rundeck failure may take the webhook channel down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemediationStore, type RemediationRecord } from "./remediation-store.js";
import { RundeckError, type RundeckClient, type RundeckExecution, type RundeckJob, type RundeckJobOption } from "./rundeck-client.js";
import {
  createRemediator,
  DEFAULT_REMEDIATION_CONFIG_PATH,
  isRemediable,
  readRemediationConfig,
  type IncomingAlert,
  type RemediationConfig,
} from "./sentinel-remediation.js";
import { OperationTimeoutError } from "./with-timeout.js";

const CONFIG: RemediationConfig = {
  rundeckProject: "sentinel",
  jobGroup: "actions",
  actions: ["restart_otel_agent_pod", "restart_otel_collector"],
};
const AGENT_TARGET = "platform-prod/signoz/signoz-k8s-infra-otel-agent";
const JOB_ID = "cc3859db-5289-5e1c-8c0b-4e4c31a7dd88";

// The option block of generated/rundeck/jobs/restart_otel_agent_pod.yaml, as Rundeck returns it
const AGENT_JOB_OPTIONS: RundeckJobOption[] = [
  {
    name: "target",
    enforced: true,
    values: [AGENT_TARGET, "data-cluster-alien-hosted/signoz/signoz-k8s-infra-otel-agent", "data-cluster-biorxiv/signoz/signoz-k8s-infra-otel-agent"],
  },
  { name: "fingerprint", enforced: false, values: [] },
  { name: "incident", enforced: false, values: [] },
];

function alert(overrides: { status?: string; labels?: Record<string, string>; startsAt?: string; fingerprint?: string } = {}): IncomingAlert {
  return {
    status: overrides.status ?? "firing",
    labels: {
      alertname: "Remediable: otel_agent",
      sentinel_class: "remediable",
      remediable_hop: "otel_agent",
      sentinel_action: "restart_otel_agent_pod",
      sentinel_target: AGENT_TARGET,
      k8s_cluster_name: "platform-prod",
      ...overrides.labels,
    },
    startsAt: overrides.startsAt ?? "2026-10-28T08:40:00Z",
    fingerprint: overrides.fingerprint ?? "0123456789abcdef",
  };
}

interface FakeRundeck extends RundeckClient {
  finds: Array<{ project: string; group: string; name: string }>;
  runs: Array<{ jobId: string; options: Record<string, string> }>;
}

function fakeRundeck(behaviour: { run?: () => Promise<RundeckExecution>; options?: RundeckJobOption[]; find?: () => Promise<RundeckJob> } = {}): FakeRundeck {
  const finds: FakeRundeck["finds"] = [];
  const runs: FakeRundeck["runs"] = [];
  return {
    finds,
    runs,
    async findJob(project, group, name) {
      finds.push({ project, group, name });
      return behaviour.find ? behaviour.find() : { id: JOB_ID, group, name };
    },
    async jobOptions() {
      return behaviour.options ?? AGENT_JOB_OPTIONS;
    },
    async runJob(jobId, options) {
      runs.push({ jobId, options });
      return behaviour.run ? behaviour.run() : { id: 42, permalink: "http://10.66.0.1:30440/project/sentinel/execution/show/42" };
    },
  };
}

function harness(rundeck: RundeckClient, options: { persist?: () => void; records?: Map<string, RemediationRecord> } = {}) {
  const records = options.records ?? new Map<string, RemediationRecord>();
  const logs: string[] = [];
  const remediator = createRemediator({
    config: CONFIG,
    rundeck,
    records,
    persist: options.persist ?? (() => {}),
    now: () => Date.UTC(2026, 9, 28, 9, 0),
    log: (line) => logs.push(line),
  });
  return { remediator, records, logs };
}

test("a firing remediable alert runs the named job once, with exactly target, fingerprint and incident=none", async () => {
  const rundeck = fakeRundeck();
  const { remediator, records, logs } = harness(rundeck);

  assert.deepEqual(await remediator.handle(alert()), { status: "started", executionId: 42 });

  assert.deepEqual(rundeck.finds, [{ project: "sentinel", group: "actions", name: "restart_otel_agent_pod" }]);
  assert.deepEqual(rundeck.runs, [{ jobId: JOB_ID, options: { target: AGENT_TARGET, fingerprint: "0123456789abcdef", incident: "none" } }]);
  const saved = records.get("0123456789abcdef");
  assert.equal(saved?.outcome, "started");
  assert.equal(saved?.executionId, 42);
  assert.match(logs.join("\n"), /started actions\/restart_otel_agent_pod .* execution 42/);
});

test("a repeat of the same episode does not run again", async () => {
  const rundeck = fakeRundeck();
  const { remediator } = harness(rundeck);

  await remediator.handle(alert());
  const repeat = await remediator.handle(alert());

  assert.equal(repeat.status, "duplicate");
  assert.equal(rundeck.runs.length, 1);
});

test("concurrent deliveries of one alert start one run", async () => {
  const rundeck = fakeRundeck();
  const { remediator } = harness(rundeck);

  const results = await Promise.all([remediator.handle(alert()), remediator.handle(alert())]);

  assert.deepEqual(results.map((r) => r.status).sort(), ["duplicate", "started"]);
  assert.equal(rundeck.runs.length, 1);
});

test("the dedupe survives a restart, through the store on disk", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "sre-remediation-")), "sentinel-remediations.json");
  const first = fakeRundeck();
  const store = createRemediationStore({ path });
  const before = store.load();
  await harness(first, { records: before, persist: () => store.save(before) }).remediator.handle(alert());

  const second = fakeRundeck();
  const after = createRemediationStore({ path }).load();
  const repeat = await harness(second, { records: after }).remediator.handle(alert());

  assert.equal(first.runs.length, 1);
  assert.equal(repeat.status, "duplicate");
  assert.equal(second.runs.length, 0);
});

test("a new firing episode of the same fingerprint runs again", async () => {
  const rundeck = fakeRundeck();
  const { remediator } = harness(rundeck);

  await remediator.handle(alert());
  const later = await remediator.handle(alert({ startsAt: "2026-11-02T14:05:00Z" }));

  assert.equal(later.status, "started");
  assert.equal(rundeck.runs.length, 2);
});

test("a resolved notification runs nothing and records nothing", async () => {
  const rundeck = fakeRundeck();
  const { remediator, records, logs } = harness(rundeck);

  assert.deepEqual(await remediator.handle(alert({ status: "resolved" })), { status: "ignored_resolved" });
  assert.equal(rundeck.finds.length + rundeck.runs.length, 0);
  assert.equal(records.size, 0);
  assert.deepEqual(logs, []);
});

test("an action outside the allowlist never reaches Rundeck", async () => {
  for (const action of ["restart_deployment", "argocd_hard_refresh", "RESTART_OTEL_AGENT_POD", "restart_otel_agent_pod "]) {
    const rundeck = fakeRundeck();
    const { remediator, records, logs } = harness(rundeck);

    const result = await remediator.handle(alert({ labels: { sentinel_action: action } }));

    assert.equal(result.status, "invalid", action);
    assert.equal(rundeck.finds.length + rundeck.runs.length, 0, action);
    assert.equal(records.size, 0);
    assert.match(logs.join("\n"), /not in the allowlist/);
  }
});

test("a target that is not a plain path of lowercase segments never reaches Rundeck", async () => {
  const targets = [
    "",
    "platform-prod/signoz/../kube-system/coredns",
    "platform-prod/signoz/x;id",
    "platform-prod/signoz/x y",
    "-platform-prod",
    "platform-prod/signoz-/x",
    "Platform-Prod/signoz/signoz-k8s-infra-otel-agent",
    "platform-prod//signoz",
    "platform-prod/signoz/x\n",
    `${"a".repeat(254)}`,
  ];
  for (const target of targets) {
    const rundeck = fakeRundeck();
    const { remediator } = harness(rundeck);

    const result = await remediator.handle(alert({ labels: { sentinel_target: target } }));

    assert.equal(result.status, "invalid", JSON.stringify(target));
    assert.equal(rundeck.finds.length + rundeck.runs.length, 0, JSON.stringify(target));
  }
});

test("missing labels or a malformed fingerprint are skipped", async () => {
  const rundeck = fakeRundeck();
  const { remediator } = harness(rundeck);
  const withoutAction = alert();
  delete (withoutAction.labels as Record<string, string>).sentinel_action;

  assert.equal((await remediator.handle(withoutAction)).status, "invalid");
  assert.equal((await remediator.handle(alert({ fingerprint: "fp; id" }))).status, "invalid");
  assert.equal((await remediator.handle(alert({ startsAt: "yesterday" }))).status, "invalid");
  assert.equal((await remediator.handle({ status: "firing", labels: { sentinel_class: "remediable" } })).status, "invalid");
  assert.equal(rundeck.runs.length, 0);
});

test("a target the live job does not list is refused before any run, and not retried", async () => {
  const rundeck = fakeRundeck();
  const { remediator, records } = harness(rundeck);
  const unlisted = alert({ labels: { sentinel_target: "platform-prod/datastreaming-prod/postgres" } });

  const result = await remediator.handle(unlisted);
  const repeat = await remediator.handle(unlisted);

  assert.equal(result.status, "refused");
  assert.match(result.status === "refused" ? result.reason : "", /not one of the job's values/);
  assert.equal(repeat.status, "duplicate");
  assert.equal(rundeck.runs.length, 0);
  assert.equal(records.get("0123456789abcdef")?.outcome, "refused");
});

test("a job that no longer declares an option it is sent, or no longer enforces its targets, is refused", async () => {
  const withoutIncident = AGENT_JOB_OPTIONS.filter((option) => option.name !== "incident");
  const freeTarget = AGENT_JOB_OPTIONS.map((option) => (option.name === "target" ? { ...option, enforced: false } : option));
  for (const options of [withoutIncident, freeTarget]) {
    const rundeck = fakeRundeck({ options });
    const result = await harness(rundeck).remediator.handle(alert());
    assert.equal(result.status, "refused");
    assert.equal(rundeck.runs.length, 0);
  }
});

test("a Rundeck refusal is logged, recorded, never thrown and never retried", async () => {
  const rundeck = fakeRundeck({
    run: async () => {
      throw new RundeckError("run job x", 400, "api.error.job.options-invalid", "Option 'target' value is not allowed");
    },
  });
  const { remediator, records, logs } = harness(rundeck);

  const result = await remediator.handle(alert());
  const repeat = await remediator.handle(alert());

  assert.equal(result.status, "refused");
  assert.equal(repeat.status, "duplicate");
  assert.equal(rundeck.runs.length, 1);
  assert.match(records.get("0123456789abcdef")?.detail ?? "", /options-invalid/);
  assert.match(logs.join("\n"), /refused actions\/restart_otel_agent_pod .* not retried/);
});

test("Rundeck unreachable or timing out is logged and not thrown; the episode is not retried", async () => {
  const failures = [
    new OperationTimeoutError("Rundeck run job x", 10_000),
    new TypeError("fetch failed"),
    new RundeckError("run job x", 503, undefined, "Service Unavailable"),
  ];
  for (const failure of failures) {
    const rundeck = fakeRundeck({
      run: async () => {
        throw failure;
      },
    });
    const { remediator, logs } = harness(rundeck);

    const result = await remediator.handle(alert());
    const repeat = await remediator.handle(alert());

    assert.equal(result.status, "failed", failure.message);
    assert.equal(repeat.status, "duplicate");
    assert.equal(rundeck.runs.length, 1);
    assert.match(logs.join("\n"), /failed actions\/restart_otel_agent_pod/);
  }
});

test("a job lookup that fails is logged and not thrown", async () => {
  const rundeck = fakeRundeck({
    find: async () => {
      throw new RundeckError("find job actions/restart_otel_agent_pod", 403, "api.error.item.unauthorized", "Not authorized");
    },
  });
  const result = await harness(rundeck).remediator.handle(alert());
  assert.equal(result.status, "refused");
  assert.equal(rundeck.runs.length, 0);
});

test("when the claim cannot be written, nothing runs and the next repeat may try again", async () => {
  const rundeck = fakeRundeck();
  let writable = false;
  const { remediator, records } = harness(rundeck, {
    persist: () => {
      if (!writable) throw new Error("ENOSPC");
    },
  });

  const first = await remediator.handle(alert());
  assert.equal(first.status, "not_persisted");
  assert.equal(rundeck.finds.length + rundeck.runs.length, 0);
  assert.equal(records.size, 0);

  writable = true;
  assert.equal((await remediator.handle(alert())).status, "started");
  assert.equal(rundeck.runs.length, 1);
});

test("only sentinel_class=remediable entries are remediable, whatever the JSON holds", () => {
  assert.equal(isRemediable(alert()), true);
  assert.equal(isRemediable(alert({ labels: { sentinel_class: "hop" } })), false);
  for (const value of [null, undefined, 1, "remediable", [], {}, { labels: null }, { labels: "x" }]) {
    assert.equal(isRemediable(value), false, JSON.stringify(value));
  }
});

test("the shipped allowlist is exactly the two OTel restart actions in sentinel's actions group", () => {
  assert.deepEqual(readRemediationConfig(DEFAULT_REMEDIATION_CONFIG_PATH), {
    rundeckProject: "sentinel",
    jobGroup: "actions",
    actions: ["restart_otel_agent_pod", "restart_otel_collector"],
  });
});

test("an invalid allowlist refuses to load", () => {
  const dir = mkdtempSync(join(tmpdir(), "sre-remediation-config-"));
  const cases: Array<[string, unknown]> = [
    ["free-form", { rundeckProject: "sentinel", jobGroup: "actions", actions: ["restart_*"] }],
    ["empty", { rundeckProject: "sentinel", jobGroup: "actions", actions: [] }],
    ["repeated", { rundeckProject: "sentinel", jobGroup: "actions", actions: ["a", "a"] }],
    ["unknown key", { rundeckProject: "sentinel", jobGroup: "actions", actions: ["a"], targets: [] }],
  ];
  for (const [name, content] of cases) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(content));
    assert.throws(() => readRemediationConfig(path), /is invalid/, name);
  }
  assert.throws(() => readRemediationConfig(join(dir, "missing.json")), /cannot read/);
});
