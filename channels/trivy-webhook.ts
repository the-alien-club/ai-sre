#!/usr/bin/env bun

// Trivy Webhook Channel — receives Trivy Operator webhooks for security findings.
//
// Filters:
// - VulnerabilityReport: fixable HIGH/CRITICAL only, recorded and sent as ONE daily digest
// - ExposedSecretReport: forwarded at once, once per image, known false positives dropped
// - ConfigAuditReport: IGNORED
// - ClusterComplianceReport: IGNORED
//
// Architecture:
//   Trivy Operator → POST /trivy → this server → Claude Code session

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireLoopbackHost } from "./bind-address.js";
import { readBodyWithLimit, RequestBodyTooLarge } from "./request-body.js";
import {
  actionableSecrets,
  buildDigest,
  createTrivyStore,
  displayImage,
  isDigestDue,
  isNewSecretFinding,
  markDigestSent,
  recordVulnerabilityReport,
} from "./trivy-findings.js";
import { extractPresentedToken, isAuthorized, requireWebhookToken } from "./webhook-auth.js";

// -- Configuration ------------------------------------------------------------

const PORT = parseInt(process.env.TRIVY_WEBHOOK_PORT ?? "8790", 10);
const HOST = requireLoopbackHost(process.env, "TRIVY_WEBHOOK_HOST"); // reached only through Caddy TLS
const AUTH_TOKEN = requireWebhookToken(process.env, "TRIVY_WEBHOOK_TOKEN");
// A VulnerabilityReport for a large image lists every CVE and runs to several MB
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Same data/ directory as slack-sre.ts and incidents.db
const DATA_DIR = process.env.SRE_DATA_DIR ?? join(dirname(dirname(resolve(fileURLToPath(import.meta.url)))), "data");
// The daily digest goes out at this UTC hour (07:00 UTC is 08:00 or 09:00 in Paris)
const DIGEST_HOUR_UTC = parseInt(process.env.TRIVY_DIGEST_HOUR_UTC ?? "7", 10);
const DIGEST_CHECK_INTERVAL_MS = 60 * 1000;

const store = createTrivyStore(join(DATA_DIR, "trivy-findings.json"));
const state = store.load();

// -- Trivy CRD payload types --------------------------------------------------

interface TrivyVulnerability {
  vulnerabilityID: string;
  resource: string;
  installedVersion: string;
  fixedVersion?: string;
  severity: string;
  title?: string;
  primaryLink?: string;
}

interface VulnerabilityReport {
  apiVersion: string;
  kind: "VulnerabilityReport";
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  report: {
    artifact: {
      repository: string;
      tag?: string;
      digest?: string;
    };
    summary: {
      criticalCount: number;
      highCount: number;
      mediumCount: number;
      lowCount: number;
      unknownCount: number;
    };
    vulnerabilities: TrivyVulnerability[];
  };
}

interface ExposedSecret {
  ruleID: string;
  category: string;
  severity: string;
  title: string;
  target: string;
  match?: string;
}

interface ExposedSecretReport {
  apiVersion: string;
  kind: "ExposedSecretReport";
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  report: {
    artifact: {
      repository: string;
      tag?: string;
      digest?: string;
    };
    summary: {
      criticalCount: number;
      highCount: number;
      mediumCount: number;
      lowCount: number;
    };
    secrets: ExposedSecret[];
  };
}

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "trivy-webhook", version: "0.1.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: `Security findings from Trivy Operator arrive as <channel source="trivy-webhook" ...> tags.

Two kinds of event come through:

1. **Vulnerability digest** (once a day, only images new or worse since the previous digest)
   Meta: kind=vulnerability-digest, severity=info, image_count, own_image_count, third_party_image_count, fingerprint
   Body: our images (ns-data-streaming) with their top fixable CVEs, then third-party images grouped by namespace
   Action: post it ONCE with the reply tool, NEVER with escalate (no mentions, no nag timer). For each of our
   images add one line on what to bump (base image or package). Do not investigate third-party images, they
   need upstream upgrades: list them as they are. No incidents.sh entry.

2. **ExposedSecret** (forwarded once per image, package-metadata false positives already dropped)
   Meta: kind=secret, severity, namespace, image, secret_count, fingerprint
   Body: list of detected secrets (API keys, tokens, credentials)
   Action: IMMEDIATE escalation to CTO. Exposed secrets in container images are a serious
   security issue regardless of severity. The image needs rebuilding without the secret,
   and if the secret is real, it needs rotation.

For an ExposedSecret:
1. Check if the affected image is actively deployed: kubectl get pods -A -o jsonpath='{..image}' | grep <image>
2. ALWAYS escalate, even if the pod isn't running anymore
3. Log the finding via incidents.sh with verdict=real, action=escalated, severity=critical`,
  }
);

await mcp.connect(new StdioServerTransport());

// -- HTTP helpers -------------------------------------------------------------

function respond(res: ServerResponse, status: number, body: string, contentType = "text/plain") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

// -- Filtering and formatting -------------------------------------------------

type ChannelEvent = { content: string; meta: Record<string, string> };

/** Records a report for the daily digest, nothing is sent. Returns false when nothing is actionable. */
function recordVulnerability(report: VulnerabilityReport): boolean {
  const recorded = recordVulnerabilityReport(
    state,
    {
      artifact: report.report.artifact,
      namespace: report.metadata.namespace ?? "unknown",
      workload: report.metadata.labels?.["trivy-operator.resource.name"] ?? report.metadata.name,
      vulnerabilities: report.report.vulnerabilities ?? [],
    },
    Date.now()
  );

  if (recorded) store.save(state);

  return recorded;
}

function processExposedSecretReport(report: ExposedSecretReport): ChannelEvent | "duplicate" | null {
  const secrets = actionableSecrets(report.report.secrets ?? []);
  if (secrets.length === 0) return null;

  // The operator rescans daily: an image already reported stays silent
  if (!isNewSecretFinding(state, report.report.artifact, secrets, Date.now())) return "duplicate";
  store.save(state);

  const totalSecrets = secrets.length;
  const namespace = report.metadata.namespace ?? "unknown";
  const image = displayImage(report.report.artifact);
  const targetWorkload = report.metadata.labels?.["trivy-operator.resource.name"] ?? report.metadata.name;

  const criticalCount = secrets.filter((s) => s.severity === "CRITICAL").length;
  const highCount = secrets.filter((s) => s.severity === "HIGH").length;
  const severity = criticalCount > 0 ? "critical" : highCount > 0 ? "high" : "medium";

  const content = [
    `EXPOSED SECRETS DETECTED in container image`,
    `Image: ${image}`,
    `Workload: ${targetWorkload}`,
    `Namespace: ${namespace}`,
    `Summary: ${criticalCount} critical, ${highCount} high, ${totalSecrets} total`,
    "",
    "Detected secrets:",
    ...secrets.slice(0, 10).map(
      (s) => `  - [${s.severity}] ${s.ruleID} (${s.category}): ${s.title} in ${s.target}`
    ),
    totalSecrets > 10 ? `  ... and ${totalSecrets - 10} more` : "",
    "",
    "ACTION REQUIRED: Image must be rebuilt without the secret, and if real, the secret must be rotated.",
  ].filter(Boolean).join("\n");

  return {
    content,
    meta: {
      kind: "secret",
      severity,
      namespace,
      image,
      workload: targetWorkload,
      secret_count: String(totalSecrets),
      critical_count: String(criticalCount),
      high_count: String(highCount),
      fingerprint: `trivy-secret-${report.metadata.name}`,
    },
  };
}

// -- HTTP Server --------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, JSON.stringify({ status: "ok", channel: "trivy-webhook" }), "application/json");
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/trivy") {
    respond(res, 404, "not found");
    return;
  }

  if (!isAuthorized(extractPresentedToken(req.headers), AUTH_TOKEN)) {
    respond(res, 401, "unauthorized");
    return;
  }

  // The operator posts several report kinds, so the body is genuinely unknown until
  // its "kind" has been inspected — typing it as one of the two we handle would be a
  // lie that narrows the ignore branch to `never`.
  let payload: unknown;
  try {
    const body = await readBodyWithLimit(req, MAX_BODY_BYTES);
    payload = JSON.parse(body);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      respond(res, 413, "payload too large");
      return;
    }
    respond(res, 400, "invalid json");
    return;
  }

  if (typeof payload !== "object" || payload === null) {
    respond(res, 400, "payload is not an object");
    return;
  }

  const kind =
    "kind" in payload && typeof payload.kind === "string"
      ? payload.kind
      : undefined;

  // Route by kind
  if (kind === "VulnerabilityReport") {
    // Never pushed one by one: it waits for the daily digest
    const status = recordVulnerability(payload as VulnerabilityReport) ? "queued" : "no_action";
    respond(res, 200, JSON.stringify({ status, kind }), "application/json");
    return;
  }

  if (kind !== "ExposedSecretReport") {
    // ConfigAuditReport, ClusterComplianceReport, etc. — silently ignore
    respond(res, 200, JSON.stringify({ status: "ignored", kind: kind ?? "unknown" }), "application/json");
    return;
  }

  const result = processExposedSecretReport(payload as ExposedSecretReport);

  if (result === "duplicate") {
    respond(res, 200, JSON.stringify({ status: "duplicate", kind }), "application/json");
    return;
  }

  if (!result) {
    // Nothing left once known false positives are dropped
    respond(res, 200, JSON.stringify({ status: "no_action", kind }), "application/json");
    return;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: result.content, meta: result.meta },
  });

  respond(res, 200, JSON.stringify({ status: "pushed", kind }), "application/json");
});

httpServer.listen(PORT, HOST, () => {
  console.error(`[trivy-webhook] listening on ${HOST}:${PORT}/trivy (auth enabled)`);
});

// -- Daily digest -------------------------------------------------------------

async function sendDigestIfDue(): Promise<void> {
  const now = Date.now();
  if (!isDigestDue(state, now, DIGEST_HOUR_UTC)) return;

  const digest = buildDigest(state, now);

  if (digest) {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: digest.content, meta: digest.meta },
    });
  }

  // Also on a quiet day, so nothing is checked again before tomorrow's slot
  markDigestSent(state, digest?.keys ?? [], now);
  store.save(state);
}

setInterval(() => {
  sendDigestIfDue().catch((err) =>
    console.error("[trivy-webhook] digest failed, retrying next minute:", err instanceof Error ? err.message : String(err))
  );
}, DIGEST_CHECK_INTERVAL_MS);
