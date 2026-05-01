#!/usr/bin/env bun

// Slack QA Channel — Two-way channel for the E2E agent. Mirrors the SRE agent's
// slack-sre channel but adds:
//   - upload_screenshot: attach Playwright PNG/video to a Slack thread
//   - propose_playbook_change: queue a markdown patch for human review
//   - reply / escalate / resolve_escalation: same as SRE
//
// The owner DMs the bot to ask questions or approve playbook changes.
// Claude posts test reports, failure screenshots, and proposed playbook diffs.
//
// Architecture:
//   Slack (Socket Mode WSS) ←→ this server ←→ Claude Code session

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { App } from "@slack/bolt";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// -- Configuration ------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const OWNER_SLACK_ID = process.env.QA_OWNER_SLACK_ID ?? "";
const QA_CHANNEL_ID = process.env.QA_CHANNEL_ID ?? "";

const ESCALATION_INTERVAL_MS = parseInt(
  process.env.ESCALATION_INTERVAL_MS ?? String(10 * 60 * 1000),
  10
);
const DEV_ESCALATION_INTERVAL_MS = parseInt(
  process.env.DEV_ESCALATION_INTERVAL_MS ?? String(60 * 60 * 1000),
  10
);

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(
    "[slack-qa] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.\n" +
      "  SLACK_BOT_TOKEN: xoxb-... (Bot User OAuth Token)\n" +
      "  SLACK_APP_TOKEN: xapp-... (App-Level Token with connections:write scope)"
  );
  process.exit(1);
}

if (!OWNER_SLACK_ID) {
  console.error(
    "[slack-qa] WARNING: QA_OWNER_SLACK_ID not set. Escalation messages will fail."
  );
}

// -- Escalation tracking ------------------------------------------------------

interface Escalation {
  id: string; // mr_iid or test_run id — caller-supplied
  title: string;
  severity: string;
  environment: string;
  slackThreadTs: string | undefined;
  slackChannel: string | undefined;
  escalatedAt: number;
  lastNagAt: number;
  acknowledged: boolean;
  nagCount: number;
}

const activeEscalations = new Map<string, Escalation>();

// -- Pending playbook proposals (in-memory; restart drops them) ---------------

interface PendingProposal {
  file_path: string;
  change_kind: string;
  rationale: string;
  proposed_markdown: string;
}
const pendingProposals = new Map<string, PendingProposal>();

// -- Slack App ----------------------------------------------------------------

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "slack-qa", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: `Messages from the QA owner arrive as <channel source="slack_qa" sender="..." thread_ts="..." channel="...">.
The owner's Slack user ID is "${OWNER_SLACK_ID}".

Tools you have:
- reply: post a message to a channel/thread
- upload_screenshot: attach a PNG/video from disk (use after a Playwright failure)
- escalate: DM the owner with urgency (auto-nags every 10 min for prod issues)
- resolve_escalation: stop nagging once handled
- propose_playbook_change: queue a markdown patch for the owner to approve via Slack
- propose_code_fix: post a deep-dive root-cause analysis + fix diff to a Slack thread

Inbound special message types you'll see:
- <channel source="slack_qa" type="escalation_timeout" ...>: re-assess and re-nag
- <channel source="slack_qa" type="owner_reply" ...>: the owner replied; continue
- <channel source="slack_qa" type="playbook_decision" ...>: owner approved or rejected a playbook proposal
- <channel source="slack_qa" type="dive_request" ...>: owner authorized a deep dive — invoke /deep-dive
- <channel source="slack_qa" type="fix_decision" ...>: owner replied 'applied <id>' or 'more <id>' to a code-fix proposal

Two-step protocol — Raise then Dive:
1. After a failed E2E run, escalate with screenshots and the verdict. STOP there.
2. The owner replies "dive" (or "dig" / "investigate") in the escalation thread to authorize root-cause investigation.
3. ONLY then invoke /deep-dive — that sub-agent has access to kubectl, SigNoz, and the local repo clones.
4. Output: propose_code_fix posts a unified diff (or prose) to the same thread.
5. Owner replies "applied <id>" once shipped, or "more <id>" to dig further.

Playbook proposal flow (separate from code fixes):
1. You learn a recurring lesson worth recording in playbooks/
2. Call propose_playbook_change with the file, the proposed markdown, and a rationale
3. The owner replies "approve <id>" or "reject <id>"
4. On approve, the channel posts a playbook_decision event; you apply and commit the change
5. On reject, log it and move on`,
  }
);

// -- Tools --------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message to a Slack channel or DM. Use to respond to the owner or post test status updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Slack channel ID. Use the channel from the inbound tag, the QA channel, or the owner's DM." },
          text: { type: "string", description: "Message text (Slack mrkdwn supported)." },
          thread_ts: { type: "string", description: "Thread timestamp to reply in-thread." },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "upload_screenshot",
      description:
        "Upload a screenshot or video artifact from a Playwright run to a Slack thread. Use this after a test failure so the owner can see what broke.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Slack channel ID." },
          file_path: { type: "string", description: "Absolute or repo-relative path to the artifact (e.g., data/artifacts/test-results/.../screenshot.png)." },
          title: { type: "string", description: "Short caption for the artifact." },
          comment: { type: "string", description: "Optional message text posted with the upload." },
          thread_ts: { type: "string", description: "Thread timestamp to attach the file to." },
        },
        required: ["channel", "file_path", "title"],
      },
    },
    {
      name: "escalate",
      description:
        "Escalate a test failure or blocker to the owner via Slack DM. Starts the nag timer if unacknowledged.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Stable identifier for this escalation (e.g., 'mr-1234' or 'regression-2026-05-01')." },
          title: { type: "string", description: "Short headline (e.g., 'MR !1234 broke checkout flow')." },
          severity: { type: "string", enum: ["critical", "warning", "info"] },
          environment: { type: "string", enum: ["dev", "staging", "prod"] },
          message: { type: "string", description: "Full context: what was tested, what failed, what you tried, what you need." },
        },
        required: ["id", "title", "severity", "environment", "message"],
      },
    },
    {
      name: "resolve_escalation",
      description: "Mark an escalation as resolved. Stops the nag timer and posts a resolution message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "The id used in the original escalate call." },
          resolution_message: { type: "string", description: "What was done / decided." },
        },
        required: ["id", "resolution_message"],
      },
    },
    {
      name: "propose_playbook_change",
      description:
        "Propose a change to a markdown playbook for human approval. The owner sees it on Slack and replies 'approve <id>' or 'reject <id>'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal_id: { type: "string", description: "Short id (5-letter slug works well; reuse it across the conversation)." },
          file_path: { type: "string", description: "Path of the playbook file (e.g., 'playbooks/test-mcp-server.md')." },
          change_kind: { type: "string", enum: ["add_section", "edit_section", "new_file", "delete_section"] },
          rationale: { type: "string", description: "Why this change is needed (1-3 sentences)." },
          proposed_markdown: { type: "string", description: "The full markdown of the new/edited content." },
        },
        required: ["proposal_id", "file_path", "change_kind", "rationale", "proposed_markdown"],
      },
    },
    {
      name: "propose_code_fix",
      description:
        "Post a code fix proposal to a Slack thread after a deep-dive investigation. The proposal is read-only — the owner applies it themselves. Use this only after the owner authorized a dive (replied 'dive' to an escalation).",
      inputSchema: {
        type: "object" as const,
        properties: {
          proposal_id: { type: "string", description: "Short id (5-letter slug)." },
          run_id: { type: "number", description: "test_runs.id this proposal addresses." },
          channel: { type: "string", description: "Slack channel ID (the escalation thread's channel)." },
          thread_ts: { type: "string", description: "Slack thread_ts of the escalation thread." },
          affected_files: { type: "array", items: { type: "string" }, description: "Files the fix touches (repo-relative paths)." },
          cause_summary: { type: "string", description: "One-paragraph root cause." },
          fix_diff: { type: "string", description: "Unified diff or prose description of the fix." },
          risk: { type: "string", enum: ["low", "medium", "high"], description: "Estimated risk of the fix." },
          test_to_add: { type: "string", description: "Optional spec snippet that would catch this bug in regression." },
        },
        required: ["proposal_id", "run_id", "channel", "thread_ts", "affected_files", "cause_summary", "fix_diff", "risk"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { channel, text, thread_ts } = args as { channel: string; text: string; thread_ts?: string };
    try {
      await slackApp.client.chat.postMessage({ channel, text, thread_ts });
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `failed to send: ${msg}` }], isError: true };
    }
  }

  if (name === "upload_screenshot") {
    const { channel, file_path, title, comment, thread_ts } = args as {
      channel: string;
      file_path: string;
      title: string;
      comment?: string;
      thread_ts?: string;
    };
    try {
      const buf = await readFile(file_path);
      await slackApp.client.files.uploadV2({
        channel_id: channel,
        thread_ts,
        file: buf,
        filename: basename(file_path),
        title,
        initial_comment: comment,
      });
      return { content: [{ type: "text" as const, text: "uploaded" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `upload failed: ${msg}` }], isError: true };
    }
  }

  if (name === "escalate") {
    const { id, title, severity, environment, message } = args as {
      id: string;
      title: string;
      severity: string;
      environment: string;
      message: string;
    };
    try {
      const dm = await slackApp.client.conversations.open({ users: OWNER_SLACK_ID });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) throw new Error("Could not open DM with owner");

      const emoji = severity === "critical" ? ":rotating_light:" : severity === "warning" ? ":warning:" : ":information_source:";
      const envTag = environment.toUpperCase();
      const text =
        `${emoji} *E2E Escalation* [${envTag}]\n\n` +
        `*${title}*\n` +
        `*Severity:* ${severity}\n` +
        `*Environment:* ${environment}\n\n` +
        `${message}\n\n` +
        `_Reply to this thread to communicate with the QA agent._`;

      const result = await slackApp.client.chat.postMessage({ channel: dmChannel, text });
      const now = Date.now();
      activeEscalations.set(id, {
        id,
        title,
        severity,
        environment,
        slackThreadTs: result.ts,
        slackChannel: dmChannel,
        escalatedAt: now,
        lastNagAt: now,
        acknowledged: false,
        nagCount: 0,
      });
      return { content: [{ type: "text" as const, text: `escalated to owner (thread: ${result.ts})` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `escalation failed: ${msg}` }], isError: true };
    }
  }

  if (name === "resolve_escalation") {
    const { id, resolution_message } = args as { id: string; resolution_message: string };
    const esc = activeEscalations.get(id);
    if (!esc) return { content: [{ type: "text" as const, text: `no active escalation: ${id}` }] };
    if (esc.slackChannel && esc.slackThreadTs) {
      try {
        await slackApp.client.chat.postMessage({
          channel: esc.slackChannel,
          thread_ts: esc.slackThreadTs,
          text: `:white_check_mark: *Resolved*\n\n${resolution_message}`,
        });
      } catch {
        // non-fatal
      }
    }
    activeEscalations.delete(id);
    return { content: [{ type: "text" as const, text: "escalation resolved" }] };
  }

  if (name === "propose_code_fix") {
    const { proposal_id, run_id, channel, thread_ts, affected_files, cause_summary, fix_diff, risk, test_to_add } =
      args as {
        proposal_id: string;
        run_id: number;
        channel: string;
        thread_ts: string;
        affected_files: string[];
        cause_summary: string;
        fix_diff: string;
        risk: string;
        test_to_add?: string;
      };
    try {
      const fileList = affected_files.map((f) => `\`${f}\``).join(", ");
      const riskEmoji = risk === "high" ? ":warning:" : risk === "medium" ? ":small_orange_diamond:" : ":small_blue_diamond:";

      // Slack message blocks have a 3000-char limit per text; truncate the diff if needed.
      const diffLimit = 2500;
      const diffPreview = fix_diff.length > diffLimit ? fix_diff.slice(0, diffLimit) + "\n... [truncated; full diff in data/proposals/" + proposal_id + ".diff]" : fix_diff;

      const text =
        `:wrench: *Fix Proposal* \`${proposal_id}\` (run #${run_id})\n` +
        `${riskEmoji} *Risk:* ${risk}\n` +
        `*Files:* ${fileList}\n\n` +
        `*Cause:* ${cause_summary}\n\n` +
        "*Fix:*\n```\n" + diffPreview + "\n```\n" +
        (test_to_add ? "\n*Suggested regression test:*\n```\n" + test_to_add.slice(0, 1500) + "\n```\n" : "") +
        `\nReply \`applied ${proposal_id}\` once you've shipped the fix, or \`more ${proposal_id}\` to dig deeper.`;

      await slackApp.client.chat.postMessage({ channel, thread_ts, text });
      return { content: [{ type: "text" as const, text: `posted proposal ${proposal_id}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `proposal failed: ${msg}` }], isError: true };
    }
  }

  if (name === "propose_playbook_change") {
    const { proposal_id, file_path, change_kind, rationale, proposed_markdown } = args as {
      proposal_id: string;
      file_path: string;
      change_kind: string;
      rationale: string;
      proposed_markdown: string;
    };
    if (!OWNER_SLACK_ID) {
      return {
        content: [{ type: "text" as const, text: "QA_OWNER_SLACK_ID not set; cannot route proposal" }],
        isError: true,
      };
    }
    try {
      const dm = await slackApp.client.conversations.open({ users: OWNER_SLACK_ID });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) throw new Error("Could not open DM with owner");

      const previewLimit = 1500;
      const preview =
        proposed_markdown.length > previewLimit
          ? proposed_markdown.slice(0, previewLimit) + "\n\n... [truncated, full text saved to data/proposals/" + proposal_id + ".md]"
          : proposed_markdown;

      const text =
        `:memo: *Playbook Proposal* \`${proposal_id}\`\n\n` +
        `*File:* \`${file_path}\`\n` +
        `*Kind:* ${change_kind}\n` +
        `*Why:* ${rationale}\n\n` +
        "```\n" + preview + "\n```\n\n" +
        `Reply \`approve ${proposal_id}\` to commit, \`reject ${proposal_id} <reason>\` to skip.`;

      await slackApp.client.chat.postMessage({ channel: dmChannel, text });
      pendingProposals.set(proposal_id, { file_path, change_kind, rationale, proposed_markdown });
      return { content: [{ type: "text" as const, text: `proposal queued: ${proposal_id}` }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `proposal failed: ${msg}` }], isError: true };
    }
  }

  throw new Error(`unknown tool: ${name}`);
});

// -- Permission relay (same as SRE) -------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!OWNER_SLACK_ID) return;
  try {
    const dm = await slackApp.client.conversations.open({ users: OWNER_SLACK_ID });
    const dmChannel = dm.channel?.id;
    if (!dmChannel) return;
    const preview = params.input_preview.length > 300 ? params.input_preview.slice(0, 300) + "..." : params.input_preview;
    await slackApp.client.chat.postMessage({
      channel: dmChannel,
      text:
        `:lock: *Permission Request* \`${params.request_id}\`\n\n` +
        `The QA agent wants to run *${params.tool_name}*:\n> ${params.description}\n\n` +
        "```\n" + preview + "\n```\n\n" +
        `Reply \`yes ${params.request_id}\` to approve or \`no ${params.request_id}\` to deny.`,
    });
  } catch (err) {
    console.error("[slack-qa] failed to relay permission request:", err);
  }
});

// -- Slack message handlers ---------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const APPROVE_RE = /^\s*approve\s+(\S+)\s*$/i;
const REJECT_RE = /^\s*reject\s+(\S+)(?:\s+(.+))?\s*$/i;
const DIVE_RE = /^\s*(dive|dig|investigate)\b(.*)$/i;
const FIX_VERDICT_RE = /^\s*(applied|more)\s+(\S+)(?:\s+(.+))?\s*$/i;

await mcp.connect(new StdioServerTransport());

slackApp.message(async ({ message, say }) => {
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;
  if (!message.text) return;

  const senderId = message.user;
  const text = message.text;

  if (OWNER_SLACK_ID && senderId !== OWNER_SLACK_ID) return;

  // Permission verdict
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith("y") ? "allow" : "deny",
      },
    });
    await say({
      text: `:white_check_mark: Permission ${permMatch[1].toLowerCase().startsWith("y") ? "approved" : "denied"} for \`${permMatch[2].toLowerCase()}\``,
      thread_ts: ("thread_ts" in message ? message.thread_ts : message.ts) as string | undefined,
    });
    return;
  }

  // Playbook proposal verdict
  const approveMatch = APPROVE_RE.exec(text);
  const rejectMatch = REJECT_RE.exec(text);
  if (approveMatch || rejectMatch) {
    const proposalId = (approveMatch?.[1] ?? rejectMatch?.[1] ?? "").trim();
    const reason = rejectMatch?.[2]?.trim() ?? "";
    const decision = approveMatch ? "approved" : "rejected";
    const proposal = pendingProposals.get(proposalId);

    if (!proposal) {
      await say({ text: `:question: No pending proposal with id \`${proposalId}\`.` });
      return;
    }

    pendingProposals.delete(proposalId);
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content:
          `Playbook proposal ${decision}: ${proposalId}\n` +
          `File: ${proposal.file_path}\n` +
          `Kind: ${proposal.change_kind}\n` +
          (reason ? `Reason: ${reason}\n` : "") +
          (decision === "approved"
            ? `\nFull proposed markdown:\n${proposal.proposed_markdown}`
            : ""),
        meta: {
          type: "playbook_decision",
          proposal_id: proposalId,
          decision,
          file_path: proposal.file_path,
          change_kind: proposal.change_kind,
        },
      },
    });

    await say({
      text:
        decision === "approved"
          ? `:white_check_mark: Approved \`${proposalId}\`. The agent will commit ${proposal.file_path}.`
          : `:x: Rejected \`${proposalId}\`${reason ? ` (${reason})` : ""}.`,
    });
    return;
  }

  // Mark escalation as acknowledged if reply is in an escalation thread
  let escalationForThread: Escalation | undefined;
  if ("thread_ts" in message && message.thread_ts) {
    for (const [, esc] of activeEscalations) {
      if (esc.slackThreadTs === message.thread_ts) {
        escalationForThread = esc;
        if (!esc.acknowledged) {
          esc.acknowledged = true;
          console.error(`[slack-qa] owner acknowledged escalation: ${esc.title}`);
        }
      }
    }
  }

  // Dive request: owner replies "dive" / "dig" / "investigate" in an escalation
  // thread (or in DM, as long as the escalation id is mentioned in the trailing text).
  const diveMatch = DIVE_RE.exec(text);
  if (diveMatch && escalationForThread) {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content:
          `Owner authorized a deep dive on escalation "${escalationForThread.title}" (id: ${escalationForThread.id}).\n` +
          `Channel: ${"channel" in message ? message.channel : ""}\n` +
          `Thread: ${escalationForThread.slackThreadTs}\n` +
          (diveMatch[2]?.trim() ? `Owner note: ${diveMatch[2].trim()}` : ""),
        meta: {
          type: "dive_request",
          escalation_id: escalationForThread.id,
          title: escalationForThread.title,
          channel: ("channel" in message ? message.channel : "") as string,
          thread_ts: escalationForThread.slackThreadTs ?? "",
        },
      },
    });
    await say({ text: `:mag: Diving in. I'll post a fix proposal here when I find a cause.` });
    return;
  }

  // Fix-proposal verdict: "applied <id>" or "more <id> [reason]"
  const fixVerdict = FIX_VERDICT_RE.exec(text);
  if (fixVerdict) {
    const [, action, proposalId, note] = fixVerdict;
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content:
          `Owner ${action.toLowerCase() === "applied" ? "applied" : "wants more investigation on"} fix proposal ${proposalId}.\n` +
          (note ? `Note: ${note}` : ""),
        meta: {
          type: "fix_decision",
          proposal_id: proposalId,
          decision: action.toLowerCase(),
        },
      },
    });
    await say({
      text:
        action.toLowerCase() === "applied"
          ? `:white_check_mark: Marked \`${proposalId}\` as applied. I'll re-run the failing tests once the fix is deployed.`
          : `:mag: Will dig further on \`${proposalId}\`.`,
    });
    return;
  }

  const isEscalationReply =
    "thread_ts" in message &&
    message.thread_ts &&
    [...activeEscalations.values()].some((e) => e.slackThreadTs === message.thread_ts);

  const meta: Record<string, string> = {
    sender: senderId,
    type: isEscalationReply ? "owner_reply" : "message",
  };
  if ("channel" in message && message.channel) meta.channel = message.channel;
  if ("thread_ts" in message && message.thread_ts) meta.thread_ts = message.thread_ts;
  else if (message.ts) meta.thread_ts = message.ts;

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: text, meta },
  });
});

await slackApp.start();
console.error("[slack-qa] connected to Slack via Socket Mode");
if (QA_CHANNEL_ID) console.error(`[slack-qa] QA channel: ${QA_CHANNEL_ID}`);

// -- Escalation nag timer -----------------------------------------------------

setInterval(async () => {
  const now = Date.now();
  for (const [id, esc] of activeEscalations) {
    if (esc.acknowledged) continue;
    const interval = esc.environment === "dev" ? DEV_ESCALATION_INTERVAL_MS : ESCALATION_INTERVAL_MS;
    if (now - esc.lastNagAt < interval) continue;

    esc.lastNagAt = now;
    esc.nagCount++;
    const minutesWaiting = Math.round((now - esc.escalatedAt) / 60_000);

    if (esc.slackChannel && esc.slackThreadTs) {
      try {
        const urgency =
          esc.severity === "critical" && esc.environment === "prod"
            ? `:rotating_light: *STILL WAITING* (${minutesWaiting} min)`
            : `:bell: Reminder (${minutesWaiting} min)`;
        await slackApp.client.chat.postMessage({
          channel: esc.slackChannel,
          thread_ts: esc.slackThreadTs,
          text: `${urgency} — *${esc.title}* [${esc.environment.toUpperCase()}] is still unacknowledged. Nag #${esc.nagCount}.`,
        });
      } catch (err) {
        console.error(`[slack-qa] failed to nag for ${id}:`, err);
      }
    }

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Escalation "${esc.title}" has been unacknowledged for ${minutesWaiting} minutes. Nag #${esc.nagCount} sent.`,
        meta: {
          type: "escalation_timeout",
          id,
          title: esc.title,
          severity: esc.severity,
          environment: esc.environment,
          minutes_waiting: String(minutesWaiting),
          nag_count: String(esc.nagCount),
        },
      },
    });
  }
}, 60_000);
