#!/usr/bin/env bun

// Trivy Webhook Channel — receives Trivy Operator webhooks for security findings.
//
// Filters:
// - VulnerabilityReport: only HIGH/CRITICAL severity with available fixes
// - ExposedSecretReport: ALL findings (always urgent)
// - ConfigAuditReport: IGNORED
// - ClusterComplianceReport: IGNORED
//
// Architecture:
//   Trivy Operator → POST /trivy → this server → Claude Code session

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// -- Configuration ------------------------------------------------------------

const PORT = parseInt(process.env.TRIVY_WEBHOOK_PORT ?? "8790", 10);
const HOST = process.env.TRIVY_WEBHOOK_HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.TRIVY_WEBHOOK_TOKEN ?? "";

// Vulnerabilities below this severity are ignored
const VULN_SEVERITY_THRESHOLD = ["CRITICAL", "HIGH"];

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

Two report types come through:

1. **VulnerabilityReport** (HIGH/CRITICAL only, with fixes available)
   Meta: kind=vulnerability, severity=critical|high, namespace, image, vuln_count, fingerprint
   Body: list of CVEs with fix versions and affected packages
   Action: Investigate if it's in a production-deployed image. Check if there's an upgrade path.
   Most often: escalate to CTO with a tuning proposal (image update needed).

2. **ExposedSecret** (ALL severities — always urgent)
   Meta: kind=secret, severity, namespace, image, secret_count, fingerprint
   Body: list of detected secrets (API keys, tokens, credentials)
   Action: IMMEDIATE escalation to CTO. Exposed secrets in container images are a serious
   security issue regardless of severity. The image needs rebuilding without the secret,
   and if the secret is real, it needs rotation.

When you receive these:
1. Check if the affected image is actively deployed: kubectl get pods -A -o jsonpath='{..image}' | grep <image>
2. For ExposedSecret: ALWAYS escalate, even if the pod isn't running anymore
3. For VulnerabilityReport: check severity, count, and whether the image is in production
4. Log the finding via incidents.sh with verdict=real, action=escalated, severity=critical`,
  }
);

await mcp.connect(new StdioServerTransport());

// -- HTTP helpers -------------------------------------------------------------

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

// -- Filtering and formatting -------------------------------------------------

function processVulnerabilityReport(report: VulnerabilityReport): { content: string; meta: Record<string, string> } | null {
  const { criticalCount, highCount } = report.report.summary;

  // Skip if no high/critical vulns
  if (criticalCount === 0 && highCount === 0) return null;

  // Filter to high/critical with fix available
  const actionable = report.report.vulnerabilities.filter(
    (v) => VULN_SEVERITY_THRESHOLD.includes(v.severity) && v.fixedVersion
  );

  if (actionable.length === 0) return null;

  const namespace = report.metadata.namespace ?? "unknown";
  const image = `${report.report.artifact.repository}:${report.report.artifact.tag ?? "latest"}`;
  const targetWorkload = report.metadata.labels?.["trivy-operator.resource.name"] ?? report.metadata.name;

  // Pick the worst severity
  const severity = criticalCount > 0 ? "critical" : "high";

  const content = [
    `Image: ${image}`,
    `Workload: ${targetWorkload}`,
    `Namespace: ${namespace}`,
    `Summary: ${criticalCount} critical, ${highCount} high (with available fixes)`,
    "",
    "Top fixable vulnerabilities:",
    ...actionable.slice(0, 10).map(
      (v) => `  - ${v.severity} ${v.vulnerabilityID} in ${v.resource}@${v.installedVersion} → fix in ${v.fixedVersion}`
    ),
    actionable.length > 10 ? `  ... and ${actionable.length - 10} more` : "",
  ].filter(Boolean).join("\n");

  return {
    content,
    meta: {
      kind: "vulnerability",
      severity,
      namespace,
      image,
      workload: targetWorkload,
      critical_count: String(criticalCount),
      high_count: String(highCount),
      fixable_count: String(actionable.length),
      fingerprint: `trivy-vuln-${report.metadata.name}`,
    },
  };
}

function processExposedSecretReport(report: ExposedSecretReport): { content: string; meta: Record<string, string> } | null {
  const totalSecrets = report.report.secrets.length;
  if (totalSecrets === 0) return null;

  const namespace = report.metadata.namespace ?? "unknown";
  const image = `${report.report.artifact.repository}:${report.report.artifact.tag ?? "latest"}`;
  const targetWorkload = report.metadata.labels?.["trivy-operator.resource.name"] ?? report.metadata.name;

  const { criticalCount, highCount } = report.report.summary;
  const severity = criticalCount > 0 ? "critical" : highCount > 0 ? "high" : "medium";

  const content = [
    `EXPOSED SECRETS DETECTED in container image`,
    `Image: ${image}`,
    `Workload: ${targetWorkload}`,
    `Namespace: ${namespace}`,
    `Summary: ${criticalCount} critical, ${highCount} high, ${totalSecrets} total`,
    "",
    "Detected secrets:",
    ...report.report.secrets.slice(0, 10).map(
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

  // Auth check (Bearer or Basic)
  if (AUTH_TOKEN) {
    const authHeader = (req.headers.authorization ?? "") as string;
    let token = "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    } else if (authHeader.startsWith("Basic ")) {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
      token = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    } else {
      token = (req.headers["x-webhook-token"] as string) ?? "";
    }
    if (token !== AUTH_TOKEN) {
      respond(res, 401, "unauthorized");
      return;
    }
  }

  let payload: VulnerabilityReport | ExposedSecretReport;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body);
  } catch {
    respond(res, 400, "invalid json");
    return;
  }

  // Route by kind
  let result: { content: string; meta: Record<string, string> } | null = null;

  if (payload.kind === "VulnerabilityReport") {
    result = processVulnerabilityReport(payload as VulnerabilityReport);
  } else if (payload.kind === "ExposedSecretReport") {
    result = processExposedSecretReport(payload as ExposedSecretReport);
  } else {
    // ConfigAuditReport, ClusterComplianceReport, etc. — silently ignore
    respond(res, 200, JSON.stringify({ status: "ignored", kind: payload.kind ?? "unknown" }), "application/json");
    return;
  }

  if (!result) {
    // No actionable findings (e.g. only LOW/MEDIUM vulns without fixes)
    respond(res, 200, JSON.stringify({ status: "no_action", kind: payload.kind }), "application/json");
    return;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: result.content, meta: result.meta },
  });

  respond(res, 200, JSON.stringify({ status: "pushed", kind: payload.kind }), "application/json");
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `[trivy-webhook] listening on ${HOST}:${PORT}/trivy` +
      (AUTH_TOKEN ? " (auth enabled)" : " (WARNING: no auth token set)")
  );
});
