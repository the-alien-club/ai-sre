#!/usr/bin/env bun

// GitLab Webhook Channel — One-way channel that receives GitLab MR and pipeline
// events and pushes them into the Claude Code E2E QA agent session.
//
// We listen for two GitLab event types:
//   - Merge Request Hook (object_kind: "merge_request") — opened, updated, merged
//   - Pipeline Hook (object_kind: "pipeline") — running, success, failed
//
// The agent cares most about pipeline success on an open MR — that's the cue to
// run E2E tests against the deployed preview. The MR open/update events warm up
// context (the agent can pre-read the diff while CI is still running).
//
// Architecture:
//   GitLab → POST /webhook → this server → Claude Code session
//   Health check: GET /health

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// -- Configuration ------------------------------------------------------------

const PORT = parseInt(process.env.GITLAB_WEBHOOK_PORT ?? "8791", 10);
const HOST = process.env.GITLAB_WEBHOOK_HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.GITLAB_WEBHOOK_TOKEN ?? "";

// -- GitLab webhook payload types (subset of fields we use) -------------------

interface GitLabUser {
  id: number;
  name: string;
  username: string;
}

interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  default_branch: string;
}

interface MergeRequestAttributes {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: "opened" | "closed" | "merged" | "locked";
  source_branch: string;
  target_branch: string;
  url: string;
  action?: "open" | "close" | "reopen" | "update" | "approved" | "merge";
  last_commit?: { id: string; message: string };
}

interface PipelineAttributes {
  id: number;
  ref: string;
  status: "created" | "pending" | "running" | "success" | "failed" | "canceled" | "skipped" | "manual";
  detailed_status: string;
  source: string;
  sha: string;
  url?: string;
}

interface GitLabWebhookPayload {
  object_kind: "merge_request" | "pipeline" | string;
  user?: GitLabUser;
  project: GitLabProject;
  // Merge Request hook
  object_attributes?: MergeRequestAttributes | PipelineAttributes;
  // Pipeline hook also includes:
  merge_request?: MergeRequestAttributes;
  commit?: { id: string; message: string; url: string };
}

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "gitlab-webhook", version: "0.1.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: `You are an E2E QA agent. GitLab events arrive as <channel source="gitlab-webhook" ...> tags.

Each event has these meta attributes:
- event_type: "merge_request" or "pipeline"
- project_id: numeric GitLab project ID
- project_path: full project path (e.g. "the-alien-club/web-app")
- mr_iid: merge request internal ID (the number you see in MR URLs)
- mr_title: MR title
- source_branch / target_branch: branch names
- pipeline_status: only for pipeline events — "running", "success", "failed", etc.
- commit_sha: latest commit SHA
- mr_url: full URL to the MR

When an event arrives:
1. If event_type=merge_request and action=open|update: pre-read the MR diff so context is warm.
   No tests yet — wait for CI to ship.
2. If event_type=pipeline and pipeline_status=success on an open MR: this is the cue to run E2E.
   Invoke /test-mr with the MR details. Spawn a sub-agent to analyze the diff, pick tests
   from the playbook, run them headless, and report.
3. If pipeline_status=failed: usually a build/unit-test problem, not your job. Log and ignore
   unless it's a regression test you maintain.
4. If event_type=merge_request and action=merge: the MR shipped. If it was on the default
   branch, kick off the regression suite against staging.

Always log every test run to ./scripts/tests.sh log before returning.`,
  }
);

await mcp.connect(new StdioServerTransport());

// -- Helpers ------------------------------------------------------------------

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

function isMergeRequestPayload(p: GitLabWebhookPayload): p is GitLabWebhookPayload & {
  object_attributes: MergeRequestAttributes;
} {
  return p.object_kind === "merge_request";
}

function isPipelinePayload(p: GitLabWebhookPayload): p is GitLabWebhookPayload & {
  object_attributes: PipelineAttributes;
  merge_request?: MergeRequestAttributes;
} {
  return p.object_kind === "pipeline";
}

function formatMergeRequestEvent(p: GitLabWebhookPayload & { object_attributes: MergeRequestAttributes }): {
  content: string;
  meta: Record<string, string>;
} {
  const mr = p.object_attributes;
  const lines = [
    `GitLab Merge Request ${mr.action ?? "event"}`,
    `Project: ${p.project.path_with_namespace}`,
    `MR !${mr.iid}: ${mr.title}`,
    `State: ${mr.state}`,
    `Source: ${mr.source_branch} → Target: ${mr.target_branch}`,
    `URL: ${mr.url}`,
  ];
  if (mr.last_commit) lines.push(`Latest commit: ${mr.last_commit.id.slice(0, 8)} — ${mr.last_commit.message.split("\n")[0]}`);
  if (p.user) lines.push(`Author: ${p.user.name} (@${p.user.username})`);
  if (mr.description) lines.push(`Description: ${mr.description.slice(0, 500)}${mr.description.length > 500 ? "..." : ""}`);

  const meta: Record<string, string> = {
    event_type: "merge_request",
    project_id: String(p.project.id),
    project_path: p.project.path_with_namespace,
    mr_iid: String(mr.iid),
    mr_title: mr.title,
    source_branch: mr.source_branch,
    target_branch: mr.target_branch,
    state: mr.state,
    mr_url: mr.url,
  };
  if (mr.action) meta.action = mr.action;
  if (mr.last_commit) meta.commit_sha = mr.last_commit.id;
  return { content: lines.join("\n"), meta };
}

function formatPipelineEvent(p: GitLabWebhookPayload & {
  object_attributes: PipelineAttributes;
  merge_request?: MergeRequestAttributes;
}): { content: string; meta: Record<string, string> } {
  const pipe = p.object_attributes;
  const lines = [
    `GitLab Pipeline ${pipe.status}`,
    `Project: ${p.project.path_with_namespace}`,
    `Pipeline #${pipe.id} on ${pipe.ref} (${pipe.sha.slice(0, 8)})`,
    `Status: ${pipe.detailed_status}`,
    `Source: ${pipe.source}`,
  ];
  if (pipe.url) lines.push(`URL: ${pipe.url}`);
  if (p.merge_request) {
    lines.push(`MR !${p.merge_request.iid}: ${p.merge_request.title} (${p.merge_request.state})`);
    lines.push(`MR URL: ${p.merge_request.url}`);
  }
  if (p.commit) lines.push(`Commit: ${p.commit.message.split("\n")[0]}`);

  const meta: Record<string, string> = {
    event_type: "pipeline",
    project_id: String(p.project.id),
    project_path: p.project.path_with_namespace,
    pipeline_id: String(pipe.id),
    pipeline_status: pipe.status,
    ref: pipe.ref,
    commit_sha: pipe.sha,
    source: pipe.source,
  };
  if (p.merge_request) {
    meta.mr_iid = String(p.merge_request.iid);
    meta.mr_title = p.merge_request.title;
    meta.mr_url = p.merge_request.url;
    meta.source_branch = p.merge_request.source_branch;
    meta.target_branch = p.merge_request.target_branch;
    meta.mr_state = p.merge_request.state;
  }
  return { content: lines.join("\n"), meta };
}

// -- HTTP Server --------------------------------------------------------------

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    respond(res, 200, JSON.stringify({ status: "ok", channel: "gitlab-webhook" }), "application/json");
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/webhook") {
    respond(res, 404, "not found");
    return;
  }

  // Auth check (GitLab uses X-Gitlab-Token header)
  if (AUTH_TOKEN) {
    const token = (req.headers["x-gitlab-token"] as string) ?? "";
    if (token !== AUTH_TOKEN) {
      respond(res, 401, "unauthorized");
      return;
    }
  }

  let payload: GitLabWebhookPayload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body) as GitLabWebhookPayload;
  } catch {
    respond(res, 400, "invalid json");
    return;
  }

  // Filter to events we care about. Skip everything else with a 204 so GitLab is happy.
  let formatted: { content: string; meta: Record<string, string> } | null = null;
  if (isMergeRequestPayload(payload)) {
    formatted = formatMergeRequestEvent(payload);
  } else if (isPipelinePayload(payload)) {
    formatted = formatPipelineEvent(payload);
  }

  if (!formatted) {
    respond(res, 204, "");
    return;
  }

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: formatted,
    });
    respond(res, 200, JSON.stringify({ pushed: 1 }), "application/json");
  } catch (err) {
    console.error("[gitlab-webhook] failed to push event:", err);
    respond(res, 500, "push failed");
  }
});

httpServer.listen(PORT, HOST, () => {
  console.error(
    `[gitlab-webhook] listening on ${HOST}:${PORT}/webhook` +
      (AUTH_TOKEN ? " (auth enabled)" : " (WARNING: no auth token set)")
  );
});
