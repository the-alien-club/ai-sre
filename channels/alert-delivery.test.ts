// Tests for the dedupe of alert deliveries across the two Alertmanagers. Run with: npm test
//
// AM-S (VM-A) and AM-R (Railway) deliver every alert to POST /alert: the same fingerprint,
// status and startsAt, a different receiver and groupKey, seconds to minutes apart. The
// session must see one of them, and must still see a resolve, a later re-notification, and
// any alert that cannot be keyed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createAlertDedupe, DEDUPE_WINDOW_MS } from "./alert-dedupe.js";
import { deliverAlerts, type AlertmanagerAlert, type AlertmanagerPayload } from "./alert-delivery.js";

const STARTS_AT = "2026-10-28T08:40:00.123456789Z";

function alert(overrides: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return {
    status: "firing",
    labels: { alertname: "High Error Rate", severity: "critical" },
    annotations: { summary: "5xx above 5%" },
    startsAt: STARTS_AT,
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: "a1b2c3d4e5f60718",
    ...overrides,
  };
}

function payload(alerts: AlertmanagerAlert[], from: "am-s" | "am-r"): AlertmanagerPayload {
  return {
    version: "4",
    groupKey: from === "am-s" ? '{}/{sentinel_route="am-s"}:{alertname="High Error Rate"}' : '{}:{alertname="High Error Rate"}',
    status: alerts.some((a) => a.status === "firing") ? "firing" : "resolved",
    receiver: from === "am-s" ? "sre-agent" : "sre-agent-railway",
    groupLabels: {},
    commonLabels: {},
    commonAnnotations: {},
    alerts,
  };
}

function harness(options: { failPushes?: number } = {}) {
  let clock = Date.parse("2026-10-28T09:00:00Z");
  let failuresLeft = options.failPushes ?? 0;
  const pushed: AlertmanagerAlert[] = [];
  const remediated: AlertmanagerAlert[] = [];
  const logs: string[] = [];
  const dedupe = createAlertDedupe({ now: () => clock });
  const deps = {
    dedupe,
    push: async (a: AlertmanagerAlert) => {
      if (failuresLeft > 0) {
        failuresLeft--;
        throw new Error("agent notification timed out after 10000 ms");
      }
      pushed.push(a);
    },
    remediate: (a: AlertmanagerAlert) => {
      remediated.push(a);
    },
    log: (line: string) => logs.push(line),
  };
  return {
    pushed,
    remediated,
    logs,
    dedupe,
    advance: (ms: number) => {
      clock += ms;
    },
    deliver: (body: AlertmanagerPayload) => deliverAlerts(body, deps),
  };
}

test("the second Alertmanager's copy 1 s later is not pushed, and is counted", async () => {
  const h = harness();

  const first = await h.deliver(payload([alert()], "am-s"));
  h.advance(1000);
  const second = await h.deliver(payload([alert()], "am-r"));

  assert.equal(h.pushed.length, 1);
  assert.deepEqual(first, { httpStatus: 200, counts: { received: 1, pushed: 1, remediable: 0, failed: 0, duplicates: 0 } });
  assert.deepEqual(second, { httpStatus: 200, counts: { received: 1, pushed: 0, remediable: 0, failed: 0, duplicates: 1 } });
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0], /dropped a duplicate delivery of a1b2c3d4e5f60718 \(firing\), first accepted 1 s ago/);
});

test("a resolve of the same fingerprint and startsAt is not swallowed by its firing", async () => {
  const h = harness();

  await h.deliver(payload([alert()], "am-s"));
  h.advance(60_000);
  const resolved = await h.deliver(payload([alert({ status: "resolved", endsAt: "2026-10-28T09:01:00Z" })], "am-s"));

  assert.equal(h.pushed.length, 2);
  assert.deepEqual(
    h.pushed.map((a) => a.status),
    ["firing", "resolved"]
  );
  assert.equal(resolved.counts.duplicates, 0);
});

test("the same delivery 11 min later is pushed again, as a re-notification", async () => {
  const h = harness();

  await h.deliver(payload([alert()], "am-s"));
  h.advance(11 * 60 * 1000);
  const later = await h.deliver(payload([alert()], "am-r"));

  assert.equal(h.pushed.length, 2);
  assert.equal(later.counts.duplicates, 0);
});

test("a copy just inside the window is still a duplicate", async () => {
  const h = harness();

  await h.deliver(payload([alert()], "am-s"));
  h.advance(DEDUPE_WINDOW_MS - 1);
  const second = await h.deliver(payload([alert()], "am-r"));

  assert.equal(second.counts.duplicates, 1);
  assert.equal(h.pushed.length, 1);
});

test("an alert with an empty fingerprint is pushed on every delivery, warned about, and not recorded", async () => {
  const h = harness();

  for (const from of ["am-s", "am-r", "am-s"] as const) {
    const result = await h.deliver(payload([alert({ fingerprint: "" })], from));
    assert.equal(result.counts.duplicates, 0);
  }

  assert.equal(h.pushed.length, 3);
  assert.equal(h.dedupe.size(), 0);
  assert.equal(h.logs.length, 3);
  for (const line of h.logs) assert.match(line, /WARNING: pushing an alert that cannot be deduplicated \(the alert has no fingerprint\)/);
});

test("an alert with an empty startsAt is never deduped either", async () => {
  const h = harness();

  await h.deliver(payload([alert({ startsAt: "" })], "am-s"));
  await h.deliver(payload([alert({ startsAt: "" })], "am-r"));

  assert.equal(h.pushed.length, 2);
  assert.equal(h.dedupe.size(), 0);
});

test("two copies of one alert in a single payload push once", async () => {
  const h = harness();

  const result = await h.deliver(payload([alert(), alert()], "am-s"));

  assert.equal(h.pushed.length, 1);
  assert.deepEqual(result.counts, { received: 2, pushed: 1, remediable: 0, failed: 0, duplicates: 1 });
});

test("a failed push is not an acceptance: the other Alertmanager's copy still gets through", async () => {
  const h = harness({ failPushes: 1 });

  const first = await h.deliver(payload([alert()], "am-s"));
  h.advance(30_000);
  const second = await h.deliver(payload([alert()], "am-r"));

  assert.equal(first.httpStatus, 207);
  assert.deepEqual(first.counts, { received: 1, pushed: 0, remediable: 0, failed: 1, duplicates: 0 });
  assert.equal(second.counts.duplicates, 0);
  assert.equal(h.pushed.length, 1);
});

test("remediable alerts go to the remediator, keep its own dedupe, and are never counted as duplicates", async () => {
  const h = harness();
  const remediable = alert({ labels: { alertname: "Remediable: otel_agent", sentinel_class: "remediable" } });

  await h.deliver(payload([remediable], "am-s"));
  const second = await h.deliver(payload([remediable], "am-r"));

  assert.equal(h.remediated.length, 2);
  assert.equal(h.pushed.length, 0);
  assert.deepEqual(second.counts, { received: 1, pushed: 0, remediable: 1, failed: 0, duplicates: 0 });
});
