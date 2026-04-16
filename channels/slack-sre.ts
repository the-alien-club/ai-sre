#!/usr/bin/env bun

// Slack SRE Channel — Two-way channel with permission relay and escalation timer
//
// Uses Slack Bolt SDK with Socket Mode (WebSocket, no public URL needed).
// The CTO can DM the bot to interact with the SRE agent.
// Claude can reply back via the reply tool.
// Permission relay lets the CTO approve/deny tool use from Slack.
// Built-in escalation timer nags the CTO every N minutes for unacknowledged critical alerts.
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

// -- Configuration (env vars) -------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN; // xapp-... token for Socket Mode
const CTO_SLACK_ID = process.env.CTO_SLACK_ID ?? ""; // Slack user ID for the CTO

// Escalation settings
const ESCALATION_INTERVAL_MS = parseInt(
  process.env.ESCALATION_INTERVAL_MS ?? String(10 * 60 * 1000), // 10 minutes
  10
);
const DEV_ESCALATION_INTERVAL_MS = parseInt(
  process.env.DEV_ESCALATION_INTERVAL_MS ?? String(60 * 60 * 1000), // 1 hour for dev
  10
);

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(
    "[slack-sre] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.\n" +
      "  SLACK_BOT_TOKEN: xoxb-... (Bot User OAuth Token)\n" +
      "  SLACK_APP_TOKEN: xapp-... (App-Level Token with connections:write scope)"
  );
  process.exit(1);
}

if (!CTO_SLACK_ID) {
  console.error(
    "[slack-sre] WARNING: CTO_SLACK_ID not set. Escalation messages will fail.\n" +
      "  Set it to the Slack user ID (e.g., U01ABCDEF) of the CTO."
  );
}

// -- Escalation tracking ------------------------------------------------------

interface Escalation {
  alertFingerprint: string;
  alertName: string;
  severity: string;
  environment: string; // "dev", "staging", "prod"
  slackThreadTs: string | undefined; // thread to nag in
  slackChannel: string | undefined; // channel/DM to nag in
  escalatedAt: number; // timestamp of first escalation
  lastNagAt: number; // timestamp of last nag
  acknowledged: boolean; // CTO replied
  nagCount: number;
}

const activeEscalations = new Map<string, Escalation>();

// -- Slack App (Socket Mode) --------------------------------------------------

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "slack-sre", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: `Messages from the CTO arrive as <channel source="slack_sre" sender="..." thread_ts="..." channel="...">.
The CTO's Slack user ID is "${CTO_SLACK_ID}".

To reply, use the "reply" tool with the channel and thread_ts from the inbound tag.
To escalate an alert to the CTO, use the "escalate" tool with alert details.
To acknowledge an escalation is handled, use the "resolve_escalation" tool.

Escalation behavior:
- For critical prod alerts: the channel will automatically nag every 10 minutes until the CTO replies
- For dev/staging: nag interval is 1 hour
- When the CTO replies to an escalation thread, nagging stops automatically
- Always include actionable context in escalation messages (what's broken, what you tried, what you need)

Two special message types arrive automatically:
- <channel source="slack_sre" type="escalation_timeout" ...>: the CTO hasn't replied to an escalation. Re-send a nag.
- <channel source="slack_sre" type="cto_reply" ...>: the CTO replied to your message. Continue the conversation.`,
  }
);

// -- Reply tool: send messages back to Slack ----------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message to a Slack channel or DM. Use for responding to CTO messages or posting updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description:
              "Slack channel ID to send to. Use the channel from the inbound tag, or the CTO's DM channel.",
          },
          text: {
            type: "string",
            description: "The message text (supports Slack mrkdwn formatting).",
          },
          thread_ts: {
            type: "string",
            description:
              "Thread timestamp to reply in-thread. Use the thread_ts from the inbound tag to keep context.",
          },
        },
        required: ["channel", "text"],
      },
    },
    {
      name: "escalate",
      description:
        "Escalate an alert to the CTO via Slack DM. Starts the automatic nag timer if the CTO doesn't respond.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alert_fingerprint: {
            type: "string",
            description:
              "Unique fingerprint from the SigNoz alert. Used to track escalation state.",
          },
          alert_name: {
            type: "string",
            description: "Human-readable alert name.",
          },
          severity: {
            type: "string",
            enum: ["critical", "warning", "info"],
            description: "Alert severity level.",
          },
          environment: {
            type: "string",
            enum: ["dev", "staging", "prod"],
            description:
              "Which environment is affected. Determines nag frequency.",
          },
          message: {
            type: "string",
            description:
              "The escalation message. Include: what's broken, what you investigated, what you need from the CTO.",
          },
        },
        required: [
          "alert_fingerprint",
          "alert_name",
          "severity",
          "environment",
          "message",
        ],
      },
    },
    {
      name: "resolve_escalation",
      description:
        "Mark an escalation as resolved. Stops the nag timer and posts a resolution message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alert_fingerprint: {
            type: "string",
            description: "Fingerprint of the alert to resolve.",
          },
          resolution_message: {
            type: "string",
            description:
              "What was done to resolve the issue. Posted to the escalation thread.",
          },
        },
        required: ["alert_fingerprint", "resolution_message"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { channel, text, thread_ts } = args as {
      channel: string;
      text: string;
      thread_ts?: string;
    };

    try {
      await slackApp.client.chat.postMessage({
        channel,
        text,
        thread_ts,
      });
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text" as const, text: `failed to send: ${msg}` },
        ],
        isError: true,
      };
    }
  }

  if (name === "escalate") {
    const {
      alert_fingerprint,
      alert_name,
      severity,
      environment,
      message,
    } = args as {
      alert_fingerprint: string;
      alert_name: string;
      severity: string;
      environment: string;
      message: string;
    };

    try {
      // Open a DM with the CTO
      const dm = await slackApp.client.conversations.open({
        users: CTO_SLACK_ID,
      });
      const dmChannel = dm.channel?.id;
      if (!dmChannel) throw new Error("Could not open DM with CTO");

      // Build escalation message with severity-appropriate urgency
      const severityEmoji =
        severity === "critical" ? ":rotating_light:" : severity === "warning" ? ":warning:" : ":information_source:";
      const envTag = environment.toUpperCase();

      const escalationText =
        `${severityEmoji} *SRE Alert Escalation* [${envTag}]\n\n` +
        `*Alert:* ${alert_name}\n` +
        `*Severity:* ${severity}\n` +
        `*Environment:* ${environment}\n\n` +
        `${message}\n\n` +
        `_Reply to this thread to communicate with the SRE agent._`;

      const result = await slackApp.client.chat.postMessage({
        channel: dmChannel,
        text: escalationText,
      });

      // Track the escalation for nagging
      const now = Date.now();
      activeEscalations.set(alert_fingerprint, {
        alertFingerprint: alert_fingerprint,
        alertName: alert_name,
        severity,
        environment,
        slackThreadTs: result.ts,
        slackChannel: dmChannel,
        escalatedAt: now,
        lastNagAt: now,
        acknowledged: false,
        nagCount: 0,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `escalated to CTO in DM (thread: ${result.ts})`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: `escalation failed: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "resolve_escalation") {
    const { alert_fingerprint, resolution_message } = args as {
      alert_fingerprint: string;
      resolution_message: string;
    };

    const escalation = activeEscalations.get(alert_fingerprint);
    if (!escalation) {
      return {
        content: [
          {
            type: "text" as const,
            text: `no active escalation found for fingerprint: ${alert_fingerprint}`,
          },
        ],
      };
    }

    // Post resolution to the escalation thread
    if (escalation.slackChannel && escalation.slackThreadTs) {
      try {
        await slackApp.client.chat.postMessage({
          channel: escalation.slackChannel,
          thread_ts: escalation.slackThreadTs,
          text:
            `:white_check_mark: *Resolved*\n\n${resolution_message}`,
        });
      } catch {
        // Non-fatal: resolution still tracked even if Slack post fails
      }
    }

    activeEscalations.delete(alert_fingerprint);

    return {
      content: [{ type: "text" as const, text: "escalation resolved" }],
    };
  }

  throw new Error(`unknown tool: ${name}`);
});

// -- Permission relay: forward tool approval prompts to Slack -----------------

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
  if (!CTO_SLACK_ID) return;

  try {
    const dm = await slackApp.client.conversations.open({
      users: CTO_SLACK_ID,
    });
    const dmChannel = dm.channel?.id;
    if (!dmChannel) return;

    // Truncate input_preview for readability
    const preview =
      params.input_preview.length > 300
        ? params.input_preview.slice(0, 300) + "..."
        : params.input_preview;

    await slackApp.client.chat.postMessage({
      channel: dmChannel,
      text:
        `:lock: *Permission Request* \`${params.request_id}\`\n\n` +
        `The SRE agent wants to run *${params.tool_name}*:\n` +
        `> ${params.description}\n\n` +
        "```\n" +
        preview +
        "\n```\n\n" +
        `Reply \`yes ${params.request_id}\` to approve or \`no ${params.request_id}\` to deny.`,
    });
  } catch (err) {
    console.error("[slack-sre] failed to relay permission request:", err);
  }
});

// -- Permission verdict regex (matches "y/yes/n/no <5-letter id>") ------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// -- Connect MCP and start Slack ----------------------------------------------

await mcp.connect(new StdioServerTransport());

// Handle incoming Slack messages
slackApp.message(async ({ message, say }) => {
  // Only handle real user messages (not bot messages, not edits)
  if (message.subtype) return;
  if (!("user" in message) || !("text" in message)) return;
  if (!message.text) return;

  const senderId = message.user;
  const text = message.text;

  // Sender allowlist: only the CTO can interact
  if (CTO_SLACK_ID && senderId !== CTO_SLACK_ID) return;

  // Check if this is a permission verdict
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: permMatch[2].toLowerCase(),
        behavior: permMatch[1].toLowerCase().startsWith("y")
          ? "allow"
          : "deny",
      },
    });
    // Acknowledge in Slack
    await say({
      text: `:white_check_mark: Permission ${permMatch[1].toLowerCase().startsWith("y") ? "approved" : "denied"} for \`${permMatch[2].toLowerCase()}\``,
      thread_ts: ("thread_ts" in message ? message.thread_ts : message.ts) as string | undefined,
    });
    return;
  }

  // Check if this reply is in an escalation thread — mark as acknowledged
  if ("thread_ts" in message && message.thread_ts) {
    for (const [, esc] of activeEscalations) {
      if (esc.slackThreadTs === message.thread_ts && !esc.acknowledged) {
        esc.acknowledged = true;
        console.error(
          `[slack-sre] CTO acknowledged escalation for ${esc.alertName}`
        );
      }
    }
  }

  // Determine message type for meta
  const isEscalationReply =
    "thread_ts" in message &&
    message.thread_ts &&
    [...activeEscalations.values()].some(
      (e) => e.slackThreadTs === message.thread_ts
    );

  // Forward to Claude session
  const meta: Record<string, string> = {
    sender: senderId,
    type: isEscalationReply ? "cto_reply" : "message",
  };

  if ("channel" in message && message.channel) {
    meta.channel = message.channel;
  }
  if ("thread_ts" in message && message.thread_ts) {
    meta.thread_ts = message.thread_ts;
  } else if (message.ts) {
    meta.thread_ts = message.ts;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content: text, meta },
  });
});

// Start Slack Socket Mode
await slackApp.start();
console.error("[slack-sre] connected to Slack via Socket Mode");

// -- Escalation nag timer -----------------------------------------------------

setInterval(async () => {
  const now = Date.now();

  for (const [fingerprint, esc] of activeEscalations) {
    if (esc.acknowledged) continue;

    const interval =
      esc.environment === "dev"
        ? DEV_ESCALATION_INTERVAL_MS
        : ESCALATION_INTERVAL_MS;

    if (now - esc.lastNagAt < interval) continue;

    esc.lastNagAt = now;
    esc.nagCount++;

    const minutesWaiting = Math.round(
      (now - esc.escalatedAt) / (60 * 1000)
    );

    // Nag the CTO on Slack
    if (esc.slackChannel && esc.slackThreadTs) {
      try {
        const urgency =
          esc.severity === "critical" && esc.environment === "prod"
            ? `:rotating_light: *STILL WAITING* (${minutesWaiting} min)`
            : `:bell: Reminder (${minutesWaiting} min)`;

        await slackApp.client.chat.postMessage({
          channel: esc.slackChannel,
          thread_ts: esc.slackThreadTs,
          text: `${urgency} — alert *${esc.alertName}* [${esc.environment.toUpperCase()}] is still unacknowledged. Nag #${esc.nagCount}.`,
        });
      } catch (err) {
        console.error(`[slack-sre] failed to nag for ${fingerprint}:`, err);
      }
    }

    // Also push a timeout event into the Claude session so it can re-assess
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Escalation for "${esc.alertName}" has been unacknowledged for ${minutesWaiting} minutes. Nag #${esc.nagCount} sent to CTO.`,
        meta: {
          type: "escalation_timeout",
          alert_fingerprint: fingerprint,
          alert_name: esc.alertName,
          severity: esc.severity,
          environment: esc.environment,
          minutes_waiting: String(minutesWaiting),
          nag_count: String(esc.nagCount),
        },
      },
    });
  }
}, 60_000); // check every minute
