#!/usr/bin/env bun

// Slack SRE Channel — Two-way channel with permission relay and escalation timer
//
// Uses Slack Bolt SDK with Socket Mode (WebSocket, no public URL needed).
// The agent lives in a shared team channel: escalations, permission requests and
// alert reports are posted there, and any operator on the allowlist can talk back.
// DMs to the bot keep working as a fallback.
//
// Architecture:
//   Slack (Socket Mode WSS) ←→ this server ←→ Claude Code session
//
// Channel-message gating (CRITICAL — this is what keeps the agent alive):
//   The team channel carries ordinary human conversation. The agent's context window
//   is its lifeline, so a channel message is only forwarded to Claude when it is
//   addressed to the agent: it @-mentions the bot, or it is a reply inside a thread
//   the agent itself started. Everything else is dropped before it reaches the session.
//
// Slack app requirements:
//   Bot scopes:          chat:write, chat:write.public, channels:history, channels:read,
//                        channels:join, im:history, im:read, im:write
//   Event subscriptions: message.channels, message.im
//                        (do NOT also subscribe app_mention — a mention already arrives
//                         as a message.channels event, and both would double-handle it)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { App } from "@slack/bolt";
import { isAddressedToAgent, stripBotMention } from "./message-gate.js";

// -- Configuration (env vars) -------------------------------------------------

/**
 * Read a required env var, or exit with an actionable message. There are no
 * defaults here on purpose: a Slack channel silently running against the wrong
 * channel, or with an empty operator allowlist, is worse than one that refuses
 * to start.
 */
function requireEnv(name: string, help: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[slack-sre] ${name} is required.\n${help}`);
    process.exit(1);
  }
  return value;
}

const SLACK_BOT_TOKEN = requireEnv(
  "SLACK_BOT_TOKEN",
  "  xoxb-... (Bot User OAuth Token)"
);
const SLACK_APP_TOKEN = requireEnv(
  "SLACK_APP_TOKEN",
  "  xapp-... (App-Level Token with connections:write scope)"
);
// Channel ID the agent lives in — escalations, permission requests and reports go here.
const SRE_SLACK_CHANNEL = requireEnv(
  "SRE_SLACK_CHANNEL",
  "  The Slack channel ID the agent lives in (e.g. C09MWNB6WL8)."
);
// "U123:Leo,U456:Adrien,U789:Ghislain" — the only users the agent listens to,
// and the only ones who may approve or deny permission requests.
const SRE_OPERATORS_RAW = requireEnv(
  "SRE_OPERATORS",
  '  Format: "U054PDMV69X:Leo,U059X19MH8U:Adrien,U09KNNY8GGJ:Ghislain"'
);

// Escalation settings
const ESCALATION_INTERVAL_MS = parseInt(
  process.env.ESCALATION_INTERVAL_MS ?? String(10 * 60 * 1000), // 10 minutes
  10
);
const DEV_ESCALATION_INTERVAL_MS = parseInt(
  process.env.DEV_ESCALATION_INTERVAL_MS ?? String(60 * 60 * 1000), // 1 hour for dev
  10
);
// After this many nags, stop pushing events into the Claude session (context preservation).
// Slack nags continue at a slower rate (every 2h) so the team still gets poked.
const MAX_AGENT_NAGS = parseInt(
  process.env.MAX_AGENT_NAGS ?? "6", // 6 × 10min = 1h for prod; 6 × 1h = 6h for dev
  10
);
const SLACK_ONLY_INTERVAL_MS = parseInt(
  process.env.SLACK_ONLY_INTERVAL_MS ?? String(2 * 60 * 60 * 1000), // 2 hours
  10
);

/**
 * Parse the operator allowlist. Operators are the only people whose messages reach
 * the agent, and the only people who may approve or deny permission requests.
 *
 * Format: "<slack_user_id>:<display_name>" entries, comma-separated. The display name
 * is carried so the agent can address people by name without needing the users:read
 * scope or a lookup round-trip.
 */
function parseOperators(raw: string): Map<string, string> {
  const operators = new Map<string, string>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(
        `SRE_OPERATORS entry "${trimmed}" is malformed — expected "<slack_user_id>:<display_name>"`
      );
    }

    const userId = trimmed.slice(0, separator).trim();
    const displayName = trimmed.slice(separator + 1).trim();
    if (!userId || !displayName) {
      throw new Error(
        `SRE_OPERATORS entry "${trimmed}" is malformed — both user ID and display name are required`
      );
    }

    operators.set(userId, displayName);
  }

  if (operators.size === 0) {
    throw new Error("SRE_OPERATORS is empty — at least one operator is required");
  }

  return operators;
}

let OPERATORS: Map<string, string>;
try {
  OPERATORS = parseOperators(SRE_OPERATORS_RAW);
} catch (err) {
  console.error(
    `[slack-sre] ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

// Mention string used to page the team on critical escalations.
const OPERATOR_MENTIONS = [...OPERATORS.keys()]
  .map((id) => `<@${id}>`)
  .join(" ");
const OPERATOR_ROSTER = [...OPERATORS.entries()]
  .map(([id, name]) => `${name} (${id})`)
  .join(", ");

// -- Escalation tracking ------------------------------------------------------

interface Escalation {
  alertFingerprint: string;
  alertName: string;
  severity: string;
  environment: string; // "dev", "staging", "prod"
  slackThreadTs: string | undefined; // thread to nag in
  slackChannel: string | undefined; // channel to nag in
  escalatedAt: number; // timestamp of first escalation
  lastNagAt: number; // timestamp of last nag
  acknowledged: boolean; // an operator replied
  acknowledgedBy: string | undefined; // display name of whoever acknowledged
  nagCount: number;
}

const activeEscalations = new Map<string, Escalation>();

// -- Agent thread tracking ----------------------------------------------------
//
// Threads the agent itself started. A channel reply inside one of these is treated
// as addressed to the agent even without an explicit @-mention, so escalation
// conversations flow naturally. Bounded in both size and age — this process runs
// for weeks and an unbounded set would leak.

const agentThreads = new Map<string, number>(); // thread_ts -> last touched (ms)
const MAX_TRACKED_THREADS = 500;
const THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function trackAgentThread(threadTs: string | undefined): void {
  if (!threadTs) return;

  // Re-insert rather than overwrite: Map.set on an existing key keeps its original
  // position, which would let a busy thread be evicted as the "oldest" one below.
  agentThreads.delete(threadTs);
  agentThreads.set(threadTs, Date.now());

  // Map preserves insertion order — evict oldest entries when over the cap.
  while (agentThreads.size > MAX_TRACKED_THREADS) {
    const oldest = agentThreads.keys().next();
    if (oldest.done) break;
    agentThreads.delete(oldest.value);
  }
}

function pruneAgentThreads(): void {
  const cutoff = Date.now() - THREAD_TTL_MS;
  for (const [threadTs, touchedAt] of agentThreads) {
    if (touchedAt < cutoff) agentThreads.delete(threadTs);
  }
}

// -- Pending permission requests ----------------------------------------------
//
// Tracked so a verdict for an unknown or expired request gets an explicit answer
// instead of silently doing nothing.

interface PendingPermission {
  toolName: string;
  requestedAt: number;
}

const pendingPermissions = new Map<string, PendingPermission>();
const PERMISSION_TTL_MS = 60 * 60 * 1000; // 1 hour

function prunePendingPermissions(): void {
  const cutoff = Date.now() - PERMISSION_TTL_MS;
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.requestedAt < cutoff) pendingPermissions.delete(requestId);
  }
}

// -- Slack App (Socket Mode) --------------------------------------------------

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Resolved during startup validation — needed to detect @-mentions of the bot.
let BOT_USER_ID = "";

// -- MCP Channel Server -------------------------------------------------------

const mcp = new Server(
  { name: "slack-sre", version: "0.2.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: `You talk to the ops team in a shared Slack channel (ID "${SRE_SLACK_CHANNEL}").

Operators (the only people who can reach you or approve your tool use): ${OPERATOR_ROSTER}.

Messages arrive as <channel source="slack_sre" sender="..." sender_name="..." channel="..." thread_ts="..." channel_type="...">.
Address people by their sender_name — you are talking to a team, not to one person.

Channel messages only reach you when they are addressed to you (an @-mention of the bot,
or a reply in a thread you started). Direct messages always reach you.

To reply, use the "reply" tool. Omit "channel" to post in the team channel; pass the
thread_ts from the inbound tag to keep the conversation in-thread.
To escalate an alert, use the "escalate" tool — it posts to the team channel and pages
every operator when severity is critical.
To close one out, use the "resolve_escalation" tool.

Escalation behavior:
- For critical prod alerts: the channel nags in-thread every 10 minutes until an operator replies
- For dev/staging: nag interval is 1 hour
- When any operator replies in the escalation thread, nagging stops automatically
- Always include actionable context in escalation messages (what's broken, what you tried, what you need)

Thread discipline: keep one alert in one thread. Post the escalation, then reply in that
thread as you learn more — do not start a new top-level message per update. The channel is
shared with people who are not on the ops rotation.

Three special message types arrive automatically:
- <channel source="slack_sre" type="escalation_timeout" final_agent_nag="false" ...>: nobody has replied. Note it and stand by — do NOT re-investigate.
- <channel source="slack_sre" type="escalation_timeout" final_agent_nag="true" ...>: the team is offline. Acknowledge this ONCE ("team appears offline, Slack nags will continue every 2h, standing by silently"), then stop responding to further nags — the channel will switch to Slack-only mode automatically.
- <channel source="slack_sre" type="operator_reply" ...>: an operator replied in an escalation thread. Continue the conversation.`,
  }
);

// -- Tools: talk back to Slack ------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a message to the team channel, a thread, or a DM. Use for responding to operators or posting updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: {
            type: "string",
            description:
              "Slack channel ID to send to. Omit to post in the team channel. Use the channel from the inbound tag when replying to a DM.",
          },
          text: {
            type: "string",
            description: "The message text (supports Slack mrkdwn formatting).",
          },
          thread_ts: {
            type: "string",
            description:
              "Thread timestamp to reply in-thread. Use the thread_ts from the inbound tag to keep context, and to keep one alert in one thread.",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "escalate",
      description:
        "Escalate an alert to the ops team in the team channel. Pages every operator when severity is critical, and starts the automatic nag timer until someone replies.",
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
            description:
              "Alert severity level. 'critical' @-mentions every operator.",
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
              "The escalation message. Include: what's broken, what you investigated, what you need from the team.",
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
        "Mark an escalation as resolved. Stops the nag timer and posts a resolution message in the escalation thread.",
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
      channel?: string;
      text: string;
      thread_ts?: string;
    };

    const target = channel ?? SRE_SLACK_CHANNEL;

    try {
      const result = await slackApp.client.chat.postMessage({
        channel: target,
        text,
        thread_ts,
      });

      // Remember the thread so operator replies to it come back to us without
      // needing an explicit @-mention.
      trackAgentThread(thread_ts ?? result.ts);

      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `failed to send: ${msg}` }],
        isError: true,
      };
    }
  }

  if (name === "escalate") {
    const { alert_fingerprint, alert_name, severity, environment, message } =
      args as {
        alert_fingerprint: string;
        alert_name: string;
        severity: string;
        environment: string;
        message: string;
      };

    try {
      // Build escalation message with severity-appropriate urgency
      const severityEmoji =
        severity === "critical"
          ? ":rotating_light:"
          : severity === "warning"
            ? ":warning:"
            : ":information_source:";
      const envTag = environment.toUpperCase();

      // Only critical alerts page the whole team — warnings and info post quietly.
      const page = severity === "critical" ? `${OPERATOR_MENTIONS}\n` : "";

      const escalationText =
        `${severityEmoji} *SRE Alert Escalation* [${envTag}]\n` +
        page +
        `\n*Alert:* ${alert_name}\n` +
        `*Severity:* ${severity}\n` +
        `*Environment:* ${environment}\n\n` +
        `${message}\n\n` +
        `_Reply in this thread to talk to the SRE agent._`;

      const result = await slackApp.client.chat.postMessage({
        channel: SRE_SLACK_CHANNEL,
        text: escalationText,
      });

      trackAgentThread(result.ts);

      // Track the escalation for nagging
      const now = Date.now();
      activeEscalations.set(alert_fingerprint, {
        alertFingerprint: alert_fingerprint,
        alertName: alert_name,
        severity,
        environment,
        slackThreadTs: result.ts,
        slackChannel: SRE_SLACK_CHANNEL,
        escalatedAt: now,
        lastNagAt: now,
        acknowledged: false,
        acknowledgedBy: undefined,
        nagCount: 0,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `escalated to the team channel (thread: ${result.ts})`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `escalation failed: ${msg}` }],
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
          text: `:white_check_mark: *Resolved*\n\n${resolution_message}`,
        });
      } catch (err) {
        // Non-fatal for the agent's bookkeeping, but it means the team never saw
        // the resolution — say so rather than reporting a clean success.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[slack-sre] failed to post resolution for ${alert_fingerprint}:`,
          err
        );
        activeEscalations.delete(alert_fingerprint);
        return {
          content: [
            {
              type: "text" as const,
              text: `escalation resolved internally, but posting to Slack failed: ${msg}`,
            },
          ],
          isError: true,
        };
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
  try {
    // Truncate input_preview for readability
    const preview =
      params.input_preview.length > 300
        ? params.input_preview.slice(0, 300) + "..."
        : params.input_preview;

    const result = await slackApp.client.chat.postMessage({
      channel: SRE_SLACK_CHANNEL,
      text:
        `:lock: *Permission Request* \`${params.request_id}\` ${OPERATOR_MENTIONS}\n\n` +
        `The SRE agent wants to run *${params.tool_name}*:\n` +
        `> ${params.description}\n\n` +
        "```\n" +
        preview +
        "\n```\n\n" +
        `Any operator: reply \`yes ${params.request_id}\` to approve or \`no ${params.request_id}\` to deny.`,
    });

    trackAgentThread(result.ts);
    pendingPermissions.set(params.request_id, {
      toolName: params.tool_name,
      requestedAt: Date.now(),
    });
  } catch (err) {
    console.error("[slack-sre] failed to relay permission request:", err);
  }
});

// -- Permission verdict regex (matches "y/yes/n/no <5-letter id>") ------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// -- Startup validation -------------------------------------------------------
//
// Fail loudly rather than running half-connected. A Slack channel that cannot reach
// its channel is worse than one that is visibly down: the agent would keep
// investigating alerts nobody ever sees.

async function validateSlackSetup(): Promise<void> {
  const auth = await slackApp.client.auth.test();
  if (!auth.user_id) {
    throw new Error("auth.test returned no bot user ID");
  }
  BOT_USER_ID = auth.user_id;
  console.error(
    `[slack-sre] authenticated as ${auth.user ?? "unknown"} (${BOT_USER_ID}) in team ${auth.team ?? "unknown"}`
  );

  const info = await slackApp.client.conversations.info({
    channel: SRE_SLACK_CHANNEL,
  });
  const channelName = info.channel?.name ?? SRE_SLACK_CHANNEL;

  if (info.channel?.is_member) {
    console.error(`[slack-sre] already a member of #${channelName}`);
    return;
  }

  // Public channels the bot can join itself; private ones need a human invite.
  if (info.channel?.is_private) {
    throw new Error(
      `bot is not a member of private channel #${channelName} — invite it with "/invite @${auth.user}" from Slack`
    );
  }

  await slackApp.client.conversations.join({ channel: SRE_SLACK_CHANNEL });
  console.error(`[slack-sre] joined #${channelName}`);
}

try {
  await validateSlackSetup();
} catch (err) {
  console.error(
    "[slack-sre] startup validation failed:",
    err instanceof Error ? err.message : String(err)
  );
  console.error(
    "[slack-sre] check that SRE_SLACK_CHANNEL is correct and the bot has scopes:\n" +
      "  chat:write, chat:write.public, channels:history, channels:read, channels:join, im:history, im:read, im:write"
  );
  process.exit(1);
}

// -- Connect MCP and start Slack ----------------------------------------------

await mcp.connect(new StdioServerTransport());

// Handle incoming Slack messages
slackApp.message(async ({ message }) => {
  // Only handle real user messages (not bot messages, not edits, not joins)
  if (message.subtype) return;
  if ("bot_id" in message && message.bot_id) return;
  if (!("user" in message) || !("text" in message)) return;
  if (!message.text) return;

  const senderId = message.user;
  const text = message.text;

  // Allowlist: only operators can interact with the agent.
  const senderName = OPERATORS.get(senderId);
  if (!senderName) return;

  const channelId = "channel" in message ? message.channel : undefined;
  const channelType =
    "channel_type" in message ? String(message.channel_type) : "unknown";
  const isDirectMessage = channelType === "im";
  const parentThreadTs =
    "thread_ts" in message && message.thread_ts ? message.thread_ts : undefined;

  // Permission verdicts are accepted anywhere an operator can reach us — they are
  // strictly formatted and deliberately frictionless, so no @-mention is required.
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    const requestId = permMatch[2].toLowerCase();
    const approved = permMatch[1].toLowerCase().startsWith("y");
    const replyThreadTs = parentThreadTs ?? message.ts;

    if (!pendingPermissions.has(requestId)) {
      // Don't leave the operator wondering whether it landed.
      await slackApp.client.chat.postMessage({
        channel: channelId ?? SRE_SLACK_CHANNEL,
        thread_ts: replyThreadTs,
        text: `:grey_question: No pending permission request \`${requestId}\` — it may have already been answered or expired.`,
      });
      return;
    }

    pendingPermissions.delete(requestId);

    await mcp.notification({
      method: "notifications/claude/channel/permission",
      params: {
        request_id: requestId,
        behavior: approved ? "allow" : "deny",
      },
    });

    await slackApp.client.chat.postMessage({
      channel: channelId ?? SRE_SLACK_CHANNEL,
      thread_ts: replyThreadTs,
      text: `:white_check_mark: Permission ${approved ? "approved" : "denied"} for \`${requestId}\` by ${senderName}.`,
    });
    return;
  }

  // Channel gating — the agent's context window is its lifeline. A channel message
  // is only forwarded when it is addressed to the agent. See message-gate.ts.
  const addressed = isAddressedToAgent({
    isDirectMessage,
    text,
    botUserId: BOT_USER_ID,
    parentThreadTs,
    isAgentThread: (threadTs) => agentThreads.has(threadTs),
  });
  if (!addressed) return;

  // A reply in an escalation thread counts as acknowledgement — stop nagging.
  let isEscalationReply = false;
  if (parentThreadTs) {
    for (const esc of activeEscalations.values()) {
      if (esc.slackThreadTs !== parentThreadTs) continue;
      isEscalationReply = true;
      if (!esc.acknowledged) {
        esc.acknowledged = true;
        esc.acknowledgedBy = senderName;
        console.error(
          `[slack-sre] ${senderName} acknowledged escalation for ${esc.alertName}`
        );
      }
    }
  }

  // Strip the bot mention — the agent already knows it was addressed.
  const content = stripBotMention(text, BOT_USER_ID);
  if (!content) return;

  // Keep the conversation in one thread: track the thread this message belongs to
  // so follow-ups land back here without needing another @-mention.
  const conversationThreadTs = parentThreadTs ?? message.ts;
  trackAgentThread(conversationThreadTs);

  const meta: Record<string, string> = {
    sender: senderId,
    sender_name: senderName,
    channel_type: channelType,
    type: isEscalationReply ? "operator_reply" : "message",
    thread_ts: conversationThreadTs,
  };

  if (channelId) {
    meta.channel = channelId;
  }

  await mcp.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
});

// Start Slack Socket Mode
await slackApp.start();
console.error(
  `[slack-sre] connected to Slack via Socket Mode — channel ${SRE_SLACK_CHANNEL}, operators: ${OPERATOR_ROSTER}`
);

// -- Escalation nag timer -----------------------------------------------------

setInterval(async () => {
  pruneAgentThreads();
  prunePendingPermissions();

  const now = Date.now();

  for (const [fingerprint, esc] of activeEscalations) {
    if (esc.acknowledged) continue;

    // Once MAX_AGENT_NAGS is reached, only Slack-nag at a slower cadence.
    // Stop pushing events into Claude's session to preserve context window.
    const agentExhausted = esc.nagCount >= MAX_AGENT_NAGS;
    const interval = agentExhausted
      ? SLACK_ONLY_INTERVAL_MS
      : esc.environment === "dev"
        ? DEV_ESCALATION_INTERVAL_MS
        : ESCALATION_INTERVAL_MS;

    if (now - esc.lastNagAt < interval) continue;

    esc.lastNagAt = now;
    esc.nagCount++;

    const minutesWaiting = Math.round((now - esc.escalatedAt) / (60 * 1000));

    // Always nag the team on Slack
    if (esc.slackChannel && esc.slackThreadTs) {
      try {
        const urgency =
          esc.severity === "critical" && esc.environment === "prod"
            ? `:rotating_light: *STILL WAITING* (${minutesWaiting} min) ${OPERATOR_MENTIONS}`
            : `:bell: Reminder (${minutesWaiting} min)`;

        const slackOnlyNote = agentExhausted
          ? " _(Slack-only nag — agent standing by silently)_"
          : "";

        await slackApp.client.chat.postMessage({
          channel: esc.slackChannel,
          thread_ts: esc.slackThreadTs,
          text: `${urgency} — alert *${esc.alertName}* [${esc.environment.toUpperCase()}] is still unacknowledged. Nag #${esc.nagCount}.${slackOnlyNote}`,
        });
      } catch (err) {
        console.error(`[slack-sre] failed to nag for ${fingerprint}:`, err);
      }
    }

    // Only push timeout events into Claude's session up to MAX_AGENT_NAGS.
    // After that, Slack nags continue but the agent's context is preserved.
    if (!agentExhausted) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `Escalation for "${esc.alertName}" has been unacknowledged for ${minutesWaiting} minutes. Nag #${esc.nagCount} sent to the team.${esc.nagCount === MAX_AGENT_NAGS ? ` This is the final agent notification — the team appears offline. Will continue Slack-only nags every 2 hours.` : ""}`,
          meta: {
            type: "escalation_timeout",
            alert_fingerprint: fingerprint,
            alert_name: esc.alertName,
            severity: esc.severity,
            environment: esc.environment,
            minutes_waiting: String(minutesWaiting),
            nag_count: String(esc.nagCount),
            final_agent_nag: esc.nagCount === MAX_AGENT_NAGS ? "true" : "false",
          },
        },
      });
    }
  }
}, 60_000); // check every minute
