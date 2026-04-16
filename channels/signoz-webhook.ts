#!/usr/bin/env bun

// SigNoz Webhook Channel — One-way channel that receives SigNoz alert webhooks
// and pushes them into the Claude Code SRE agent session.
//
// SigNoz sends Alertmanager-compatible webhook payloads when alerts fire/resolve.
// This channel parses those payloads and pushes each alert as a separate event.
//
// Architecture:
//   SigNoz cloud → POST /alert → this server → Claude Code session
//   Health check: GET /health
//
// Works with both Bun and Node.js (via tsx).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// -- Configuration (env vars, with sensible defaults) -------------------------

const PORT = parseInt(process.env.SIGNOZ_WEBHOOK_PORT ?? "8788", 10);
const HOST = process.env.SIGNOZ_WEBHOOK_HOST ?? "0.0.0.0"; // needs to be reachable from SigNoz cloud
const AUTH_TOKEN = process.env.SIGNOZ_WEBHOOK_TOKEN ?? ""; // shared secret, checked in Authorization header

// -- Types for Alertmanager-compatible webhook payload ------------------------

interface AlertmanagerAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint: string;
}

interface AlertmanagerPayload {
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

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "signoz-webhook", version: "0.1.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
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

For "resolved" alerts: acknowledge them, note the resolution, no action needed unless the same alert keeps flapping.

Severity-based behavior:
- dev cluster alerts: investigate, fix if obvious, single summary message
- staging cluster alerts: investigate, fix if safe, message with details
- prod cluster alerts: investigate carefully, auto-fix ONLY safe operations, escalate aggressively for anything complex`,
  }
);

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, body: string, contentType = "text/plain") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

// -- HTTP Server --------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, JSON.stringify({ status: "ok", channel: "signoz-webhook" }), "application/json");
    return;
  }

  // Only accept POST to /alert
  if (req.method !== "POST" || url.pathname !== "/alert") {
    respond(res, 404, "not found");
    return;
  }

  // Auth check (if token is configured)
  // Supports: Bearer token, Basic auth (password = token), or X-Webhook-Token header
  // SigNoz uses Basic auth via http_config.basic_auth (password field)
  if (AUTH_TOKEN) {
    const authHeader = (req.headers.authorization ?? "") as string;
    let token = "";

    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      // Format: "username:password" — password is our token
      token = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    } else {
      token = (req.headers["x-webhook-token"] as string) ?? "";
    }

    if (token !== AUTH_TOKEN) {
      respond(res, 401, "unauthorized");
      return;
    }
  }

  // Parse the webhook payload
  let payload: AlertmanagerPayload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body) as AlertmanagerPayload;
  } catch {
    respond(res, 400, "invalid json");
    return;
  }

  if (!payload.alerts || !Array.isArray(payload.alerts)) {
    respond(res, 400, "missing alerts array");
    return;
  }

  // Push each alert as a separate channel event
  const results = await Promise.allSettled(
    payload.alerts.map(async (alert) => {
      const content = formatAlertContent(alert, payload.status);
      const meta = extractMeta(alert, payload.status);

      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      });
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  respond(
    res,
    failed > 0 ? 207 : 200,
    JSON.stringify({ received: payload.alerts.length, pushed: succeeded, failed }),
    "application/json"
  );
});

httpServer.listen(PORT, HOST, () => {
  // Log to stderr (stdout is reserved for MCP stdio transport)
  console.error(
    `[signoz-webhook] listening on ${HOST}:${PORT}/alert` +
      (AUTH_TOKEN ? " (auth enabled)" : " (WARNING: no auth token set)")
  );
});
