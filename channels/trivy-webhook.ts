#!/usr/bin/env bun

// Trivy Webhook Channel — receives Trivy Operator webhooks for security findings.
//
// A CVE backlog is not a page. On 2026-10-26/27 the agent turned each VulnerabilityReport
// into a critical escalation: 263 incidents in 14 hours, 256 escalated, 16 threads nagged
// 8-12 times with mentions. So this channel posts Trivy findings to Slack itself, and the
// agent only ever hears about exposed secrets:
//
// - VulnerabilityReport: recorded on disk. Once a day, every image's CVE counts by severity
//   go out as ONE digest (new since the previous digest highlighted, no mention), and each
//   image repository's Jira ticket (SDS, label trivy) is opened or commented on. The agent
//   is not told: nothing to triage, no incident, no escalation, no nag.
// - ExposedSecretReport: posted at once, paging the operators ONCE per image build, and never
//   registered with slack-sre's nag loop. The agent is then told, to investigate and answer
//   in that thread.
// - ConfigAuditReport, ClusterComplianceReport: ignored.
//
// Architecture:
//   Trivy Operator → POST /trivy → this server → Slack (+ Jira, + the Claude session for secrets)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebClient } from "@slack/web-api";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireLoopbackHost } from "./bind-address.js";
import { createJiraClient, readJiraConfig } from "./jira-client.js";
import { operatorMentions, parseOperators } from "./operators.js";
import { readBodyWithLimit, RequestBodyTooLarge } from "./request-body.js";
import {
  describeIssues,
  ExposedSecretReportPayload,
  VulnerabilityReportPayload,
  workloadOf,
  type ExposedSecretReport,
  type VulnerabilityReport,
} from "./trivy-payload.js";
import { buildDigest } from "./trivy-digest.js";
import {
  actionableSecrets,
  createTrivyStore,
  displayImage,
  isDigestDue,
  isSecretReported,
  markDigestSent,
  markSecretReported,
  recordVulnerabilityReport,
  secretFingerprint,
  ticketUpdates,
} from "./trivy-findings.js";
import { syncTickets } from "./trivy-jira.js";
import {
  createSlackPoster,
  DigestPartiallyPostedError,
  postDigest,
  secretEscalationText,
  type SecretEscalation,
} from "./trivy-slack.js";
import { extractPresentedToken, isAuthorized, requireWebhookToken } from "./webhook-auth.js";
import { OperationTimeoutError, withTimeout } from "./with-timeout.js";

// -- Configuration ------------------------------------------------------------

const PORT = parseInt(process.env.TRIVY_WEBHOOK_PORT ?? "8790", 10);
const HOST = requireLoopbackHost(process.env, "TRIVY_WEBHOOK_HOST"); // reached only through Caddy TLS
const AUTH_TOKEN = requireWebhookToken(process.env, "TRIVY_WEBHOOK_TOKEN");
// This channel posts to Slack itself, with the same bot and channel as slack-sre.ts
const SLACK_BOT_TOKEN = requireSetting("SLACK_BOT_TOKEN", "the xoxb- bot token slack-sre.ts uses");
const SRE_SLACK_CHANNEL = requireSetting("SRE_SLACK_CHANNEL", "the team channel ID slack-sre.ts posts in");
const OPERATOR_MENTIONS = operatorMentions(parseOperators(requireSetting("SRE_OPERATORS", "the operator roster")));
const JIRA = readJiraConfig(process.env);
// A VulnerabilityReport for a large image lists every CVE and runs to several MB
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// Same data/ directory as slack-sre.ts and incidents.db
const DATA_DIR = process.env.SRE_DATA_DIR ?? join(dirname(dirname(resolve(fileURLToPath(import.meta.url)))), "data");
// The daily digest goes out at this UTC hour (07:00 UTC is 08:00 or 09:00 in Paris)
const DIGEST_HOUR_UTC = readHourUtc(process.env.TRIVY_DIGEST_HOUR_UTC ?? "7");
const DIGEST_CHECK_INTERVAL_MS = 60 * 1000;

// Bounds on everything this process waits for (CLAUDE_ERROR_PATTERNS.md §14)
const SLACK_TIMEOUT_MS = 20 * 1000;
const JIRA_TIMEOUT_MS = 15 * 1000;
const AGENT_NOTIFY_TIMEOUT_MS = 10 * 1000;
// Jira gets this long per digest; what does not fit is retried the next day
const JIRA_BUDGET_MS = 5 * 60 * 1000;
// Ceiling on a whole digest run: the Jira budget, one call past it, and the Slack posts
const DIGEST_RUN_TIMEOUT_MS = JIRA_BUDGET_MS + 5 * 60 * 1000;
// A digest that could not be posted is retried with backoff, never every minute
const DIGEST_RETRY_MIN_MS = 60 * 1000;
const DIGEST_RETRY_MAX_MS = 60 * 60 * 1000;
// A secret that could not be posted is retried sooner: it may be a live leak
const SECRET_RETRY_MIN_MS = 30 * 1000;
const SECRET_RETRY_MAX_MS = 15 * 60 * 1000;
const SECRET_RETRY_CHECK_MS = 15 * 1000;

const store = createTrivyStore({ path: join(DATA_DIR, "trivy-findings.json") });
const state = store.load();

// No retries inside the client: a retry that lands after withTimeout gave up would post the
// message twice, and this process decides when to try again.
const slack = createSlackPoster(
  new WebClient(SLACK_BOT_TOKEN, { timeout: SLACK_TIMEOUT_MS, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }),
  SRE_SLACK_CHANNEL,
  SLACK_TIMEOUT_MS
);
const jira = createJiraClient(JIRA, { timeoutMs: JIRA_TIMEOUT_MS });


function requireSetting(name: string, what: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set; the Trivy channel needs ${what}`);
  return value;
}

function readHourUtc(raw: string): number {
  const hour = Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`TRIVY_DIGEST_HOUR_UTC must be an integer hour from 0 to 23, got "${raw}"`);
  }
  return hour;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "trivy-webhook", version: "0.2.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: `Exposed-secret findings from Trivy Operator arrive as <channel source="trivy-webhook" kind="secret" ...> tags.

Vulnerability reports never reach you: this channel posts them to the team channel as one daily digest and keeps
one Jira ticket per image itself. Never escalate, log or post anything about Trivy CVEs.

kind=secret: the channel has ALREADY posted the finding to the team channel and paged the operators, once.
Meta: kind, severity, namespace, image, workload, secret_count, fingerprint, thread_ts, channel
Do NOT call escalate for it (the tool refuses trivy- fingerprints): there is no reminder loop for secrets.
1. Spawn a sub-agent to check whether the image is deployed and when the secret was introduced (trivy-exposed-secret.md).
2. Post what it found with the reply tool, in the thread given by thread_ts, so operator replies reach you.
3. Log it via incidents.sh with verdict=real (or false_positive), action=escalated, severity=critical.`,
  }
);

await mcp.connect(new StdioServerTransport());

// -- HTTP helpers -------------------------------------------------------------

function respond(res: ServerResponse, status: number, body: Record<string, string>) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Saves the state; a failure is logged and answered with a 500, so the operator can resend. */
function saveOrRespond500(res: ServerResponse, kind: string, context: string): boolean {
  try {
    store.save(state);
    return true;
  } catch (err) {
    console.error(`[trivy-webhook] ${context}: ${errorMessage(err)}`);
    respond(res, 500, { status: "persist_failed", kind });
    return false;
  }
}

// -- Report handlers ----------------------------------------------------------

function handleVulnerabilityReport(res: ServerResponse, report: VulnerabilityReport): void {
  const status = recordVulnerabilityReport(
    state,
    {
      artifact: report.report.artifact,
      namespace: report.metadata.namespace ?? "unknown",
      workload: workloadOf(report.metadata),
      vulnerabilities: report.report.vulnerabilities,
    },
    Date.now()
  );

  if (!saveOrRespond500(res, report.kind, `could not persist ${displayImage(report.report.artifact)}`)) return;
  respond(res, 200, { status, kind: report.kind });
}

interface PendingSecret {
  escalation: SecretEscalation;
  reportName: string;
  failures: number;
  nextAttemptAt: number;
  inFlight: boolean;
}

// Exposed secrets not yet posted. A failed post stays here and is retried with backoff, so
// a Slack blip can delay a page but never drop it, and a second report for the same image
// (several workloads run it) joins the pending one instead of paging twice. In memory only:
// a restart forgets it, and the next rescan, which finds the secret not yet reported, re-queues it.
const pendingSecrets = new Map<string, PendingSecret>();

async function handleExposedSecretReport(res: ServerResponse, report: ExposedSecretReport): Promise<void> {
  const kind = report.kind;
  const secrets = actionableSecrets(report.report.secrets);
  if (secrets.length === 0) {
    // Nothing left once known false positives are dropped
    respond(res, 200, { status: "no_action", kind });
    return;
  }

  const artifact = report.report.artifact;
  const fingerprint = secretFingerprint(artifact, secrets);

  // The operator rescans daily: a finding already escalated (or about to be) stays silent
  if (pendingSecrets.has(fingerprint) || isSecretReported(state, fingerprint, Date.now())) {
    if (saveOrRespond500(res, kind, "could not persist a secret sighting")) respond(res, 200, { status: "duplicate", kind });
    return;
  }

  pendingSecrets.set(fingerprint, {
    escalation: {
      image: displayImage(artifact),
      workload: workloadOf(report.metadata),
      namespace: report.metadata.namespace ?? "unknown",
      secrets,
    },
    reportName: report.metadata.name,
    failures: 0,
    nextAttemptAt: 0,
    inFlight: false,
  });

  const outcome = await escalateSecret(fingerprint);
  if (outcome === "persist_failed") respond(res, 500, { status: "persist_failed", kind });
  else respond(res, outcome === "escalated" ? 200 : 202, { status: outcome, kind });
}

/**
 * Posts one pending secret finding, paging the operators, then hands it to the agent.
 * A post that timed out may still have reached Slack; it is retried anyway, because for a
 * possible leak a second page is the lesser harm than none.
 */
async function escalateSecret(fingerprint: string): Promise<"escalated" | "retrying" | "persist_failed"> {
  const pending = pendingSecrets.get(fingerprint);
  if (!pending || pending.inFlight) return "retrying";

  const { escalation } = pending;
  pending.inFlight = true;
  let threadTs: string;
  try {
    threadTs = await slack.post(secretEscalationText(escalation, OPERATOR_MENTIONS));
  } catch (err) {
    pending.failures++;
    const delay = Math.min(SECRET_RETRY_MIN_MS * 2 ** (pending.failures - 1), SECRET_RETRY_MAX_MS);
    pending.nextAttemptAt = Date.now() + delay;
    console.error(
      `[trivy-webhook] could not post the exposed-secret escalation for ${escalation.image} ` +
        `(attempt ${pending.failures}), retrying in ${Math.round(delay / 1000)} s: ${errorMessage(err)}`
    );
    return "retrying";
  } finally {
    pending.inFlight = false;
  }

  pendingSecrets.delete(fingerprint);
  markSecretReported(state, fingerprint, Date.now());

  // Already visible and paged. If the write fails, the in-memory state still stops a
  // re-page until a restart; the caller reports the failure.
  let persisted = true;
  try {
    store.save(state);
  } catch (err) {
    persisted = false;
    console.error(`[trivy-webhook] escalated ${escalation.image} but could not persist it, a restart may page again: ${errorMessage(err)}`);
  }

  await notifyAgentOfSecret(escalation, pending.reportName, threadTs);
  return persisted ? "escalated" : "persist_failed";
}

async function notifyAgentOfSecret(escalation: SecretEscalation, reportName: string, threadTs: string): Promise<void> {
  const { image, workload, namespace, secrets } = escalation;
  const criticalCount = secrets.filter((s) => s.severity === "CRITICAL").length;
  const highCount = secrets.filter((s) => s.severity === "HIGH").length;

  try {
    await withTimeout(
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: [
            `Exposed secret(s) in ${image} (${workload}, ${namespace}), already posted and paged once in thread ${threadTs}.`,
            ...secrets.slice(0, 10).map((s) => `- [${s.severity}] ${s.ruleID} (${s.category}): ${s.title} in ${s.target}`),
          ].join("\n"),
          meta: {
            kind: "secret",
            severity: criticalCount > 0 ? "critical" : highCount > 0 ? "high" : "medium",
            namespace,
            image,
            workload,
            secret_count: String(secrets.length),
            fingerprint: `trivy-secret-${reportName}`,
            thread_ts: threadTs,
            channel: SRE_SLACK_CHANNEL,
          },
        },
      }),
      AGENT_NOTIFY_TIMEOUT_MS,
      "agent notification"
    );
  } catch (err) {
    console.error(`[trivy-webhook] escalated ${image} but could not hand it to the agent: ${errorMessage(err)}`);
    await slack
      .post(":warning: The SRE agent could not be notified of this finding: nobody is investigating it automatically.", threadTs)
      .catch((postErr: unknown) =>
        console.error(`[trivy-webhook] could not say so in thread ${threadTs} either: ${errorMessage(postErr)}`)
      );
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [fingerprint, pending] of pendingSecrets) {
    if (pending.inFlight || now < pending.nextAttemptAt) continue;
    escalateSecret(fingerprint).catch((err: unknown) =>
      console.error(`[trivy-webhook] secret escalation retry failed unexpectedly: ${errorMessage(err)}`)
    );
  }
}, SECRET_RETRY_CHECK_MS);

// -- HTTP Server --------------------------------------------------------------

const httpServer = createServer((req, res) => {
  // The last line of defence: whatever a handler throws is logged and answered, never left
  // as an unhandled rejection in the process that pages for secrets
  handleRequest(req, res).catch((err: unknown) => {
    console.error(`[trivy-webhook] request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (!res.headersSent) respond(res, 500, { status: "internal_error" });
  });
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, { status: "ok", channel: "trivy-webhook" });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/trivy") {
    respond(res, 404, { status: "not_found" });
    return;
  }

  if (!isAuthorized(extractPresentedToken(req.headers), AUTH_TOKEN)) {
    respond(res, 401, { status: "unauthorized" });
    return;
  }

  // The operator posts several report kinds, so the body is genuinely unknown until its
  // "kind" has been inspected.
  let payload: unknown;
  try {
    payload = JSON.parse(await readBodyWithLimit(req, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      respond(res, 413, { status: "payload_too_large" });
      return;
    }
    respond(res, 400, { status: "invalid_json" });
    return;
  }

  if (typeof payload !== "object" || payload === null) {
    respond(res, 400, { status: "payload_not_object" });
    return;
  }

  const kind = "kind" in payload && typeof payload.kind === "string" ? payload.kind : "unknown";

  if (kind !== "VulnerabilityReport" && kind !== "ExposedSecretReport") {
    // ConfigAuditReport, ClusterComplianceReport, etc.
    respond(res, 200, { status: "ignored", kind });
    return;
  }

  const parsed =
    kind === "VulnerabilityReport" ? VulnerabilityReportPayload.safeParse(payload) : ExposedSecretReportPayload.safeParse(payload);

  if (!parsed.success) {
    const reason = describeIssues(parsed.error);
    console.error(`[trivy-webhook] rejected a malformed ${kind}: ${reason}`);
    respond(res, 400, { status: "invalid_report", kind, reason });
    return;
  }

  if (parsed.data.kind === "VulnerabilityReport") handleVulnerabilityReport(res, parsed.data);
  else await handleExposedSecretReport(res, parsed.data);
}

httpServer.listen(PORT, HOST, () => {
  console.error(`[trivy-webhook] listening on ${HOST}:${PORT}/trivy (auth enabled), digest at ${DIGEST_HOUR_UTC}:00 UTC`);
});

// -- Daily digest -------------------------------------------------------------

async function runDigest(): Promise<void> {
  const now = Date.now();

  // Tickets first, so the digest can link them
  const tickets = await syncTickets(state, jira, ticketUpdates(state), {
    deadline: now + JIRA_BUDGET_MS,
    persist: () => store.save(state),
  });

  const digest = buildDigest(state, now, tickets, (key) => jira.browseUrl(key));

  if (digest) {
    try {
      await postDigest(slack, digest);
    } catch (err) {
      // Visible but incomplete: say so in the log, and do not post the whole digest again
      if (!(err instanceof DigestPartiallyPostedError)) throw err;
      console.error(`[trivy-webhook] ${err.message}`);
    }
  }

  // Also on a day with no findings, so nothing is checked again before tomorrow's slot
  markDigestSent(state, digest?.shown ?? {}, now);
  store.save(state);
  console.error(`[trivy-webhook] daily digest done: ${digest ? "posted" : "no findings, nothing posted"}, ${tickets.length} ticket update(s)`);
}

let digestRunning = false;
let digestFailures = 0;
let nextDigestAttemptAt = 0;

setInterval(() => {
  const now = Date.now();
  if (digestRunning || now < nextDigestAttemptAt || !isDigestDue(state, now, DIGEST_HOUR_UTC)) return;

  digestRunning = true;
  const run = runDigest();

  // The flag follows the run itself, not the timeout, so a run can never overlap another
  run.then(
    () => {
      digestFailures = 0;
    },
    (err: unknown) => {
      digestFailures++;
      const delay = Math.min(DIGEST_RETRY_MIN_MS * 2 ** (digestFailures - 1), DIGEST_RETRY_MAX_MS);
      nextDigestAttemptAt = Date.now() + delay;
      console.error(
        `[trivy-webhook] daily digest failed (attempt ${digestFailures}), retrying in ${Math.round(delay / 60000)} min: ${errorMessage(err)}`
      );
    }
  ).finally(() => {
    digestRunning = false;
  });

  // Only the ceiling is handled here: a run that fails by itself is reported just above
  withTimeout(run, DIGEST_RUN_TIMEOUT_MS, "daily digest").catch((err: unknown) => {
    if (err instanceof OperationTimeoutError) {
      console.error(`[trivy-webhook] ${err.message}; no new digest starts until it settles`);
    }
  });
}, DIGEST_CHECK_INTERVAL_MS);
