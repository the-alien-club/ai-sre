#!/usr/bin/env bun

// SigNoz Webhook Channel — One-way channel that receives SigNoz alert webhooks
// and pushes them into the Claude Code SRE agent session.
//
// SigNoz sends Alertmanager-compatible webhook payloads when alerts fire/resolve.
// This channel parses those payloads and pushes each alert as a separate event.
//
// Architecture:
//   SigNoz cloud / sentinel AM-S / AM-R → POST /alert → this server → Claude Code session
//   Health check: GET /health (the listener is up)
//   Session check: GET /health/session (the session answered a heartbeat recently)
//
// Sentinel's stage-1 `remediable` alerts (sentinel_class=remediable) never reach the session:
// this server runs the Rundeck job they name itself, deterministically (sentinel-remediation.ts).
// Both sentinel Alertmanagers deliver every alert; the second copy is dropped here
// (alert-dedupe.ts). A heartbeat round trip through the session proves it still answers
// (session-heartbeat.ts).
//
// Works with both Bun and Node.js (via tsx).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAlertDedupe } from "./alert-dedupe.js";
import { deliverAlerts, type AlertmanagerAlert, type AlertmanagerPayload } from "./alert-delivery.js";
import { requireLoopbackHost } from "./bind-address.js";
import { createRemediationStore } from "./remediation-store.js";
import { readBodyWithLimit, RequestBodyTooLarge } from "./request-body.js";
import { createRundeckClient, readRundeckConfig } from "./rundeck-client.js";
import { createRemediator, DEFAULT_REMEDIATION_CONFIG_PATH, readRemediationConfig } from "./sentinel-remediation.js";
import { createSessionHeartbeat, HEARTBEAT_ACK_TOOL } from "./session-heartbeat.js";
import { extractPresentedToken, isAuthorized, requireWebhookToken } from "./webhook-auth.js";
import { createWatchdogRestartsReader, DEFAULT_WATCHDOG_LAST_RESTART_PATH, withWatchdogRestarts } from "./watchdog-restarts.js";
import { withTimeout } from "./with-timeout.js";

// -- Configuration (env vars, with sensible defaults) -------------------------

const PORT = parseInt(process.env.SIGNOZ_WEBHOOK_PORT ?? "8788", 10);
const HOST = requireLoopbackHost(process.env, "SIGNOZ_WEBHOOK_HOST"); // reached only through Caddy TLS
const AUTH_TOKEN = requireWebhookToken(process.env, "SIGNOZ_WEBHOOK_TOKEN"); // shared secret, required
// An Alertmanager payload carries a handful of alerts; 1 MiB is far beyond any real one
const MAX_BODY_BYTES = 1024 * 1024;
// Sentinel remediation: Rundeck on VM-A over WireGuard, required (no default for either)
const RUNDECK = readRundeckConfig(process.env);
const REMEDIATION = readRemediationConfig(DEFAULT_REMEDIATION_CONFIG_PATH);
// Same data/ directory as slack-sre.ts, trivy-webhook.ts and incidents.db
const DATA_DIR = process.env.SRE_DATA_DIR ?? join(dirname(dirname(resolve(fileURLToPath(import.meta.url)))), "data");
// The session watchdog's restart record (scripts/session-watchdog.sh), reported by /health/session
const WATCHDOG_LAST_RESTART_PATH = process.env.SRE_WATCHDOG_LAST_RESTART_PATH ?? DEFAULT_WATCHDOG_LAST_RESTART_PATH;

// Bounds on everything this process waits for (CLAUDE_ERROR_PATTERNS.md §14). A run request
// returns as soon as Rundeck has queued the execution; the job itself runs for up to 30 min.
const RUNDECK_TIMEOUT_MS = 10 * 1000;
const AGENT_NOTIFY_TIMEOUT_MS = 10 * 1000;

const remediationStore = createRemediationStore({ path: join(DATA_DIR, "sentinel-remediations.json") });
const remediationRecords = remediationStore.load();
const remediator = createRemediator({
  config: REMEDIATION,
  rundeck: createRundeckClient(RUNDECK, { timeoutMs: RUNDECK_TIMEOUT_MS }),
  records: remediationRecords,
  persist: () => remediationStore.save(remediationRecords),
});

const alertDedupe = createAlertDedupe();
const readWatchdogRestarts = createWatchdogRestartsReader({ path: WATCHDOG_LAST_RESTART_PATH });

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "signoz-webhook", version: "0.1.0" },
  {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: `You are an SRE agent. Alert events from SigNoz arrive as <channel source="signoz-webhook" ...> tags.

Each alert has these meta attributes:
- alert_name: the alert rule name (e.g. "High Error Rate", "Pod CrashLooping")
- severity: "critical", "warning", or "info"
- status: "firing" (problem active) or "resolved" (problem cleared)
- service: the affected service name (if available)
- cluster: the affected cluster (if available from labels)
- namespace: the affected namespace (if available from labels)
- fingerprint: unique alert instance identifier (use to track firing→resolved pairs)

The content body contains a formatted summary with annotations (description, summary) and timing.

When you receive an alert:
1. VERIFY: Query SigNoz (search_logs, search_traces, query_metrics) to confirm the alert is real and not a blip
2. DIAGNOSE: Use kubectl to inspect affected pods, deployments, events, logs
3. DECIDE: Is this a quick fix you can handle, or does it need CTO escalation?
4. ACT: Either fix it (if safe) or escalate via the slack-sre reply tool

Sentinel's stage-1 alerts labelled sentinel_class="remediable" never reach you: this channel runs the Rundeck job
they name itself, and the job reports to #alerts-ops. If it does not fix the problem, sentinel's stage 2 alert
("Hop down: ...") follows as an ordinary ticket. Do not run or re-run sentinel Rundeck jobs yourself.

Both of sentinel's Alertmanagers deliver every alert; exact duplicates are dropped by this channel before they reach you.

Heartbeats: an event whose content is "heartbeat <nonce>" (meta kind="heartbeat") is not an alert. Immediately call the
${HEARTBEAT_ACK_TOOL} tool with that nonce: no sub-agent, no investigation, no Slack message, nothing else. It is how the
platform knows you are responsive; if you do not answer, you are restarted.

For "resolved" alerts: acknowledge them, note the resolution, no action needed unless the same alert keeps flapping.

Severity-based behavior:
- dev cluster alerts: investigate, fix if obvious, single summary message
- staging cluster alerts: investigate, fix if safe, message with details
- prod cluster alerts: investigate carefully, auto-fix ONLY safe operations, escalate aggressively for anything complex`,
  }
);

// -- Tools: the heartbeat answer ---------------------------------------------

const heartbeat = createSessionHeartbeat({
  push: (content, meta) =>
    withTimeout(mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }), AGENT_NOTIFY_TIMEOUT_MS, "heartbeat notification"),
});

const HeartbeatAckArgs = z.object({ nonce: z.string().min(1) }).strict();

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: HEARTBEAT_ACK_TOOL,
      description:
        'Answer a "heartbeat <nonce>" event from this channel. Call it immediately with the nonce, and do nothing else for that event.',
      inputSchema: {
        type: "object" as const,
        properties: {
          nonce: { type: "string", description: "The nonce from the heartbeat event, exactly as received." },
        },
        required: ["nonce"],
      },
    },
  ],
}));

// Never throws (CLAUDE_ERROR_PATTERNS.md §15): every failure is an error result the agent can read.
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== HEARTBEAT_ACK_TOOL) {
    return { content: [{ type: "text" as const, text: `unknown tool: ${name}` }], isError: true };
  }

  const parsed = HeartbeatAckArgs.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: "text" as const, text: `invalid arguments: nonce must be a non-empty string (${parsed.error.issues.map((i) => i.message).join("; ")})` }], isError: true };
  }

  const result = heartbeat.ack(parsed.data.nonce);
  if (!result.ok) {
    console.error(`[signoz-webhook] refused a heartbeat ack: ${result.error}`);
    return { content: [{ type: "text" as const, text: result.error }], isError: true };
  }
  return { content: [{ type: "text" as const, text: "ok" }] };
});

await mcp.connect(new StdioServerTransport());

// -- Helper: format a single alert into readable content ----------------------

function formatAlertContent(alert: AlertmanagerAlert, groupStatus: string): string {
  const lines: string[] = [];

  const alertName = alert.labels.alertname ?? "Unknown Alert";
  const severity = alert.labels.severity ?? "unknown";
  const status = alert.status ?? groupStatus;

  lines.push(`Alert: ${alertName}`);
  lines.push(`Status: ${status.toUpperCase()}`);
  lines.push(`Severity: ${severity}`);

  if (alert.annotations.summary) {
    lines.push(`Summary: ${alert.annotations.summary}`);
  }
  if (alert.annotations.description) {
    lines.push(`Description: ${alert.annotations.description}`);
  }

  // Timing
  lines.push(`Started: ${alert.startsAt}`);
  if (alert.status === "resolved" && alert.endsAt) {
    lines.push(`Resolved: ${alert.endsAt}`);
  }

  // All labels (useful for diagnosis)
  const labelEntries = Object.entries(alert.labels)
    .filter(([k]) => k !== "alertname" && k !== "severity")
    .map(([k, v]) => `  ${k}: ${v}`);

  if (labelEntries.length > 0) {
    lines.push(`Labels:`);
    lines.push(...labelEntries);
  }

  if (alert.generatorURL) {
    lines.push(`SigNoz URL: ${alert.generatorURL}`);
  }

  return lines.join("\n");
}

// -- Helper: extract meta attributes from an alert ----------------------------

function extractMeta(alert: AlertmanagerAlert, groupStatus: string): Record<string, string> {
  const meta: Record<string, string> = {
    alert_name: alert.labels.alertname ?? "unknown",
    severity: alert.labels.severity ?? "unknown",
    status: alert.status ?? groupStatus,
    fingerprint: alert.fingerprint ?? "unknown",
  };

  // Extract common label patterns from SigNoz alerts
  if (alert.labels["service.name"]) meta.service = alert.labels["service.name"];
  if (alert.labels.service_name) meta.service = alert.labels.service_name;
  if (alert.labels["k8s.cluster.name"]) meta.cluster = alert.labels["k8s.cluster.name"];
  if (alert.labels["k8s.namespace.name"]) meta.namespace = alert.labels["k8s.namespace.name"];
  if (alert.labels.namespace) meta.namespace = alert.labels.namespace;

  // Underscores only in meta keys (hyphens are silently dropped by Claude Code)
  return meta;
}

// -- HTTP helpers for Node.js -------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function respond(res: ServerResponse, status: number, body: string, contentType = "text/plain") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

// -- HTTP Server --------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Health check: the listener is up
  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, JSON.stringify({ status: "ok", channel: "signoz-webhook" }), "application/json");
    return;
  }

  // Session check: the session answered a heartbeat recently. Public through Caddy, no secrets.
  // The watchdog's restarts ride along in the body; only the heartbeat decides the status.
  if (req.method === "GET" && url.pathname === "/health/session") {
    const { httpStatus, body } = withWatchdogRestarts(heartbeat.health(), await readWatchdogRestarts());
    respond(res, httpStatus, JSON.stringify(body), "application/json");
    return;
  }

  // Only accept POST to /alert
  if (req.method !== "POST" || url.pathname !== "/alert") {
    respond(res, 404, "not found");
    return;
  }

  // SigNoz sends the secret as the basic-auth password; see webhook-auth.ts
  if (!isAuthorized(extractPresentedToken(req.headers), AUTH_TOKEN)) {
    respond(res, 401, "unauthorized");
    return;
  }

  // Parse the webhook payload
  let payload: AlertmanagerPayload;
  try {
    const body = await readBodyWithLimit(req, MAX_BODY_BYTES);
    payload = JSON.parse(body) as AlertmanagerPayload;
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      respond(res, 413, "payload too large");
      return;
    }
    respond(res, 400, "invalid json");
    return;
  }

  if (!payload.alerts || !Array.isArray(payload.alerts)) {
    respond(res, 400, "missing alerts array");
    return;
  }

  const { httpStatus, counts } = await deliverAlerts(payload, {
    dedupe: alertDedupe,
    // handle() never rejects; the catch is the last line of defence
    remediate: (alert) => {
      remediator.handle(alert).catch((err: unknown) => console.error(`[signoz-webhook] remediation failed unexpectedly: ${errorMessage(err)}`));
    },
    push: (alert, groupStatus) =>
      withTimeout(
        mcp.notification({
          method: "notifications/claude/channel",
          params: { content: formatAlertContent(alert, groupStatus), meta: extractMeta(alert, groupStatus) },
        }),
        AGENT_NOTIFY_TIMEOUT_MS,
        "agent notification"
      ),
  });

  respond(res, httpStatus, JSON.stringify(counts), "application/json");
});

httpServer.listen(PORT, HOST, () => {
  // Log to stderr (stdout is reserved for MCP stdio transport)
  console.error(
    `[signoz-webhook] listening on ${HOST}:${PORT}/alert (auth enabled), ` +
      `remediable actions ${REMEDIATION.actions.join(", ")} via ${RUNDECK.baseUrl}`
  );
  heartbeat.start();
});
