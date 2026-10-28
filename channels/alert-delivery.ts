// What POST /alert does with a parsed Alertmanager payload, apart from HTTP.
//
// Each alert takes exactly one path:
// - sentinel's remediable alerts go to the remediator (sentinel-remediation.ts), which has its
//   own per-episode dedupe and never reaches the session;
// - an exact duplicate of an alert accepted in the last window (alert-dedupe.ts), which is the
//   second Alertmanager's copy, is counted and dropped;
// - everything else is pushed to the session.

import type { AlertDedupe } from "./alert-dedupe.js";
import { isRemediable } from "./sentinel-remediation.js";

// -- Types for Alertmanager-compatible webhook payload ------------------------

export interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint: string;
}

export interface AlertmanagerPayload {
  version?: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status: "firing" | "resolved";
  receiver: string;
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
  externalURL?: string;
  alerts: AlertmanagerAlert[];
}

// -- Delivery -----------------------------------------------------------------

export interface AlertDeliveryDeps {
  dedupe: AlertDedupe;
  /** Pushes one alert to the session. Bounded by the caller; rejects when the push failed. */
  push: (alert: AlertmanagerAlert, groupStatus: AlertmanagerPayload["status"]) => Promise<void>;
  /** Hands one remediable alert to the remediator. Must not throw; the work is not awaited. */
  remediate: (alert: AlertmanagerAlert) => void;
  log?: (line: string) => void;
}

export interface AlertDeliveryCounts {
  received: number;
  pushed: number;
  remediable: number;
  failed: number;
  duplicates: number;
}

export interface AlertDeliveryResult {
  /** 207 when at least one push failed, so the sender's log shows a partial delivery. */
  httpStatus: 200 | 207;
  counts: AlertDeliveryCounts;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export async function deliverAlerts(payload: AlertmanagerPayload, deps: AlertDeliveryDeps): Promise<AlertDeliveryResult> {
  const { dedupe, push, remediate, log = (line: string) => console.error(line) } = deps;

  // Remediable alerts are handled in code and never reach the session. The Rundeck calls are
  // not awaited: Alertmanager needs no more than receipt, and a retry it made on a slow answer
  // would be deduplicated by the remediator anyway.
  const remediable = new Set(payload.alerts.filter((alert) => isRemediable(alert)));
  for (const alert of remediable) remediate(alert);

  // Claimed synchronously, before any push is awaited, so two copies in one payload or in
  // two concurrent requests cannot both pass.
  const toPush: Array<{ alert: AlertmanagerAlert; key: string | undefined }> = [];
  let duplicates = 0;
  for (const alert of payload.alerts) {
    if (remediable.has(alert)) continue;
    const status = alert.status ?? payload.status;
    const verdict = dedupe.claim({ fingerprint: alert.fingerprint, status, startsAt: alert.startsAt });
    if (verdict.kind === "duplicate") {
      duplicates++;
      log(`[signoz-webhook] dropped a duplicate delivery of ${alert.fingerprint} (${status}), first accepted ${seconds(verdict.ageMs)} ago`);
      continue;
    }
    if (verdict.kind === "unkeyed") {
      log(`[signoz-webhook] WARNING: pushing an alert that cannot be deduplicated (${verdict.reason}); every copy of it will reach the agent`);
      toPush.push({ alert, key: undefined });
      continue;
    }
    toPush.push({ alert, key: verdict.key });
  }

  const results = await Promise.allSettled(toPush.map(({ alert }) => push(alert, payload.status)));

  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    failed++;
    log(`[signoz-webhook] could not push an alert to the agent: ${errorMessage(result.reason)}`);
    // Not accepted after all: let the other Alertmanager's copy through
    const { key } = toPush[index];
    if (key !== undefined) dedupe.release(key);
  });

  return {
    httpStatus: failed > 0 ? 207 : 200,
    counts: {
      received: payload.alerts.length,
      pushed: results.length - failed,
      remediable: remediable.size,
      failed,
      duplicates,
    },
  };
}
