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
//   the agent has posted in. Everything else is dropped before it reaches the session.
//
//   Thread ownership is resolved from Slack, not from process memory — see
//   thread-ownership.ts for why. Escalation bookkeeping is persisted to disk for the same
//   reason: this process is restarted nightly and must not lose state it alone holds.
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAddressing, stripBotMention } from "./message-gate.js";
import { createThreadOwnership } from "./thread-ownership.js";
import { createEscalationStore } from "./escalation-store.js";
import { createEscalator } from "./escalator.js";
import { createSlackPostClient, createSlackPoster, SlackPostRejected } from "./slack-poster.js";
import { withTimeout } from "./with-timeout.js";
import { isTrivyEscalation, TRIVY_ESCALATION_REFUSED } from "./escalation-policy.js";
import {
  operatorMentions,
  operatorRoster,
  parseOperators,
  type OperatorRoster,
} from "./operators.js";
import { DEFAULT_KEDB_DIR } from "./kedb-index.js";
import { createKedbGit } from "./kedb-git.js";
import { createKedbLoop, type KedbLoop, type ToolOutcome } from "./kedb-loop.js";
import { createProposalStore } from "./proposal-store.js";
import { parseApprovers } from "./kedb-approvers.js";
import { createIncidentLookup } from "./incident-lookup.js";
import { createOperatorWait } from "./operator-wait.js";

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

// Slack user IDs, comma-separated, of the only people whose "yes" applies a runbook
// (KEDB) change the agent proposed. Each must also be in SRE_OPERATORS. No default: who may
// change the agent's triage knowledge is never implicit.
const SRE_KEDB_APPROVERS_RAW = requireEnv(
  "SRE_KEDB_APPROVERS",
  '  Slack user IDs, comma-separated, e.g. "U054PDMV69X" (Leo).'
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
 * An optional integer setting in ms, or exit with an actionable message. A typo here must not
 * quietly turn a timer off (parseInt("5m") is 5, parseInt("") is NaN).
 */
function msEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    console.error(`[slack-sre] ${name} must be an integer number of ms, at least ${min}; got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  return value;
}

// How long an operator waits with no visible sign that their message landed before the
// channel says so on the agent's behalf. The runbook requires the agent to delegate all
// investigation to sub-agents, so a substantive question is silent for minutes by
// construction — and from Slack that is indistinguishable from a dead bot. Set to 0 to
// disable the acknowledgement entirely.
const ACK_DELAY_MS = msEnv("ACK_DELAY_MS", 20 * 1000, 0);

// How long after that "On it" the channel says there is still no answer, and tells the agent
// (type="operator_waiting"). 5 minutes: the agent runs investigations as background
// sub-agents, so its main loop is free within seconds, and a first answer (the result, or
// what it is waiting on) costs it one reply. The heartbeat that proves the loop is alive runs
// on the same 5-minute cadence. Anything longer is the 2026-10-29 silence again. Cannot be
// turned off.
const OPERATOR_FOLLOWUP_MS = msEnv("OPERATOR_FOLLOWUP_MS", 5 * 60 * 1000, 1);

// Where bookkeeping that only this process knows about is persisted. Relative to the repo
// root so it lands in the same data/ directory as incidents.db.
const DATA_DIR =
  process.env.SRE_DATA_DIR ??
  join(dirname(dirname(resolve(fileURLToPath(import.meta.url)))), "data");

let OPERATORS: OperatorRoster;
try {
  OPERATORS = parseOperators(SRE_OPERATORS_RAW);
} catch (err) {
  console.error(
    `[slack-sre] ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

let KEDB_APPROVERS: Map<string, string>;
try {
  KEDB_APPROVERS = parseApprovers(SRE_KEDB_APPROVERS_RAW, OPERATORS);
} catch (err) {
  console.error(`[slack-sre] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Mention string used to page the team on critical escalations.
const OPERATOR_MENTIONS = operatorMentions(OPERATORS);
const OPERATOR_ROSTER = operatorRoster(OPERATORS);

// -- Escalation tracking ------------------------------------------------------
//
// Persisted: an unacknowledged alert must keep nagging across the nightly restart, and
// nothing outside this process knows it is still waiting.

const escalationStore = createEscalationStore({
  path: join(DATA_DIR, "slack-escalations.json"),
});

const activeEscalations = escalationStore.load();
if (activeEscalations.size > 0) {
  console.error(
    `[slack-sre] restored ${activeEscalations.size} escalation(s) from disk`
  );
}

function persistEscalations(): void {
  escalationStore.save(activeEscalations);
}

// -- Pending permission requests ----------------------------------------------
//
// Tracked so a verdict for an unknown or expired request gets an explicit answer
// instead of silently doing nothing.
//
// Deliberately NOT persisted. A restart tears down the Claude session along with this
// process, so every tool call blocked on a verdict dies with it. Restoring the map would
// let an operator approve a request that nothing is waiting on.

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

// Bolt's App constructor calls auth.test() itself to resolve the bot identity, and that
// promise is not ours to await — an invalid or revoked token rejects it outside the
// try/catch around validateSlackSetup below, and Node kills the process with a raw stack
// trace. That is the single most likely startup failure, and it deserves the same
// actionable message as every other one.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[slack-sre] fatal: unhandled rejection —",
    reason instanceof Error ? reason.message : String(reason)
  );
  console.error(
    "[slack-sre] if this is a Slack API error, check SLACK_BOT_TOKEN and SLACK_APP_TOKEN " +
      "are valid and that the app has not been reinstalled or revoked."
  );
  process.exit(1);
});

const slackApp = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Bounds on everything this process waits for (CLAUDE_ERROR_PATTERNS.md §14)
const SLACK_TIMEOUT_MS = 20 * 1000;
const AGENT_NOTIFY_TIMEOUT_MS = 10 * 1000;

// Every post goes through this, never through slackApp.client: Bolt's client has no timeout
// and retries for ~30 min, and a retry that lands after the caller gave up posts the message
// twice. One bounded attempt; this process decides whether to try again (slack-poster.ts).
const slackPoster = createSlackPoster(createSlackPostClient(SLACK_BOT_TOKEN, SLACK_TIMEOUT_MS), SLACK_TIMEOUT_MS);

/** A post failure as the agent or the log should read it: refused, or of unknown outcome. */
function describePostFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof SlackPostRejected ? message : `${message} (the message may or may not be visible)`;
}

/** For posts nobody waits on: a failure is logged, never thrown. */
async function postOrLog(message: { channel: string; text: string; thread_ts?: string }, what: string): Promise<void> {
  try {
    await slackPoster.post(message);
  } catch (err) {
    console.error(`[slack-sre] failed to post ${what}: ${describePostFailure(err)}`);
  }
}

// Resolved during startup validation — needed to detect @-mentions of the bot.
let BOT_USER_ID = "";
// The workspace URL (https://<workspace>.slack.com/), for the permalinks the KEDB loop writes
// into its commits. Resolved during startup validation.
let SLACK_TEAM_URL = "";

// Answers "has the agent posted in this thread?" from Slack, with an in-memory cache.
// Reads BOT_USER_ID lazily: startup validation resolves it after this object is built.
const threadOwnership = createThreadOwnership({
  client: slackApp.client,
  botUserId: () => BOT_USER_ID,
});

// One top-level thread per waiting escalation; see escalator.ts.
const escalator = createEscalator({
  channel: SRE_SLACK_CHANNEL,
  operatorMentions: OPERATOR_MENTIONS,
  escalations: activeEscalations,
  persist: persistEscalations,
  poster: slackPoster,
  botUserId: () => BOT_USER_ID,
  rememberThread: (ts) => threadOwnership.remember(ts),
});

// -- Operator wait: receipt acknowledgement and follow-up ----------------------
//
// Armed when an operator's message is handed to the Claude session, cleared when the agent
// answers in that thread. After ACK_DELAY_MS the channel posts "On it" on the agent's behalf;
// after OPERATOR_FOLLOWUP_MS more it says there is still no answer and tells the agent. Each
// at most once per unanswered stretch of a thread (operator-wait.ts). Fast answers trigger
// neither, which keeps a shared channel quiet.

/** Pushes one event into the Claude session, bounded (CLAUDE_ERROR_PATTERNS.md §14). */
function notifyAgent(content: string, meta: Record<string, string>): Promise<void> {
  return withTimeout(
    mcp.notification({ method: "notifications/claude/channel", params: { content, meta } }),
    AGENT_NOTIFY_TIMEOUT_MS,
    "agent notification"
  );
}

// A thread whose follow-up went out and that the agent never answered is forgotten after a
// day, so a new question there gets a fresh "On it" and follow-up.
const OPERATOR_WAIT_RETENTION_MS = 24 * 60 * 60 * 1000;

const operatorWait = createOperatorWait({
  ackDelayMs: ACK_DELAY_MS,
  followUpMs: OPERATOR_FOLLOWUP_MS,
  async postAck({ channel, threadTs, senderName }) {
    await slackPoster.post({
      channel,
      thread_ts: threadTs,
      text: `:eyes: On it, ${senderName} — investigating. I'll answer in this thread.`,
    });
  },
  async postFollowUp({ channel, threadTs, senderName }, waitedMs) {
    await slackPoster.post({
      channel,
      thread_ts: threadTs,
      text:
        `:hourglass: ${senderName}, still no answer after ${Math.round(waitedMs / 60_000)} min. ` +
        "The agent has been told you are waiting. If nothing follows in the next few minutes, it is stuck " +
        "and its session needs a look.",
    });
  },
  async signalAgent({ channel, threadTs, senderName }, waitedMs) {
    const minutes = String(Math.round(waitedMs / 60_000));
    await notifyAgent(
      `${senderName} has had no answer from you for ${minutes} min in thread ${threadTs}. Answer there now with "reply": ` +
        "the result, what you are still waiting on, or what failed and why. Run investigations as background sub-agents.",
      { type: "operator_waiting", channel, thread_ts: threadTs, sender_name: senderName, minutes_waiting: minutes }
    );
  },
});

// -- KEDB learning loop -------------------------------------------------------
//
// The agent proposes runbook changes with the tools below; an approver's reply in Slack is
// applied by code (kedb-loop.ts), committed and pushed to sre-kedb. See plan §4.

// The sre-kedb checkout the loop commits to; the same one signoz-webhook reads.
const KEDB_DIR = process.env.SRE_KEDB_DIR ?? DEFAULT_KEDB_DIR;
// Read-only sentinel clone: an entry's auto_fix must name an action and target it allows.
const SENTINEL_DIR = process.env.SRE_SENTINEL_DIR ?? "/home/sre-agent/repos/sentinel";
const KEDB_WEB_URL = "https://gitlab.com/alias3/datastreaming/tooling/sre-kedb";
const KEDB_GIT_TIMEOUT_MS = 60 * 1000;
const KEDB_LINT_TIMEOUT_MS = 90 * 1000;
const KEDB_READ_TIMEOUT_MS = 10 * 1000;
const KEDB_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The SigNoz host links in an entry may point to, from the URL the SigNoz MCP uses. */
function signozHost(): string | undefined {
  const raw = process.env.SIGNOZ_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    console.error("[slack-sre] SIGNOZ_URL is not a URL; KEDB proposals may not link to SigNoz");
    return undefined;
  }
}

// Undefined when the proposal store cannot be read: the loop is then off (its tools say why)
// rather than restarting the KB-<n> counter, and the rest of the channel keeps working.
let kedbLoop: KedbLoop | undefined;
let kedbUnavailable = "";
try {
  kedbLoop = createKedbLoop({
    store: createProposalStore({ path: join(DATA_DIR, "kedb-proposals.json") }),
    git: createKedbGit({
      dir: KEDB_DIR,
      stageDir: join(DATA_DIR, "kedb-stage"),
      timeoutMs: KEDB_GIT_TIMEOUT_MS,
      lintTimeoutMs: KEDB_LINT_TIMEOUT_MS,
    }),
    poster: slackPoster,
    notifyAgent,
    approvers: KEDB_APPROVERS,
    channel: SRE_SLACK_CHANNEL,
    teamUrl: () => SLACK_TEAM_URL,
    payloadDir: join(DATA_DIR, "alert-payloads"),
    sentinelDir: SENTINEL_DIR,
    // The same database incidents.sh writes (its default path, relative to the repo)
    incidents: createIncidentLookup({ dbPath: join(DATA_DIR, "incidents.db"), timeoutMs: KEDB_READ_TIMEOUT_MS }),
    urlPolicy: { signozHost: signozHost() },
    readTimeoutMs: KEDB_READ_TIMEOUT_MS,
    commitUrl: (sha) => `${KEDB_WEB_URL}/-/commit/${sha}`,
  });
} catch (err) {
  kedbUnavailable = err instanceof Error ? err.message : String(err);
  console.error(`[slack-sre] KEDB learning loop is OFF: ${kedbUnavailable}`);
}

const KEDB_TOOLS = [
  {
    name: "propose_runbook_update",
    description:
      "Propose a change to one KEDB entry (sre-kedb). Code checks it (schema, lint, guardrails), posts it with its diff in thread_ts, " +
      "and applies it only when an approver answers yes in Slack. Refused: diffs over 80 changed lines, copies of the alert payload " +
      "outside ```evidence fences, a second open proposal for the entry or incident, more than 3 open. Returns the KB-<n> id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        entry_id: { type: "string", description: "Entry id, the path under entries/ without .md, e.g. falco/delete-or-rename-shell-history." },
        op: { type: "string", enum: ["create", "update", "retire"], description: "retire: new_content with status: retired." },
        new_content: { type: "string", description: "The full new file: YAML front matter and Markdown body." },
        learned: { type: "string", description: "1-3 sentences, one paragraph: what you learned, including what you got wrong." },
        incident_id: { type: "string", description: "incidents.db id of the incident this comes from." },
        fingerprint: { type: "string", description: "The alert fingerprint of that incident (its raw payload must still be kept)." },
        thread_ts: { type: "string", description: "The incident's Slack thread; the proposal is posted there." },
        supersedes: { type: "string", description: "KB-<n> this revises (after feedback, a rejection or a stale proposal)." },
      },
      required: ["entry_id", "op", "new_content", "learned", "incident_id", "fingerprint", "thread_ts"],
    },
  },
  {
    name: "apply_runbook_update",
    description: "Retry applying an approved proposal whose apply failed (status failed). Code applies approvals itself; never call this otherwise.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "KB-<n>" } },
      required: ["id"],
    },
  },
  {
    name: "list_runbook_proposals",
    description: "List runbook proposals (newest revision of each), optionally by status: pending, approved, applied, rejected, expired, superseded, stale, failed, withdrawn.",
    inputSchema: {
      type: "object" as const,
      properties: { status: { type: "string" } },
    },
  },
  {
    name: "withdraw_runbook_proposal",
    description: "Withdraw a pending, stale or failed proposal, with the reason posted in its thread.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "KB-<n>" }, reason: { type: "string" } },
      required: ["id", "reason"],
    },
  },
];
const KEDB_TOOL_NAMES = new Set(KEDB_TOOLS.map((tool) => tool.name));

function toolResult(outcome: ToolOutcome) {
  return { content: [{ type: "text" as const, text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) };
}

/**
 * A proposal, as an answer in its thread: a posted one answers the operator who asked there;
 * a refused one, while an operator waits there, comes back with the duty to tell them.
 */
async function proposeRunbookUpdate(loop: KedbLoop, args: Record<string, unknown>): Promise<ToolOutcome> {
  const outcome = await loop.propose(args);
  const threadTs = typeof args.thread_ts === "string" ? args.thread_ts : undefined;
  if (threadTs === undefined) return outcome;
  if (!outcome.isError) {
    operatorWait.answered(threadTs);
    return outcome;
  }
  if (!operatorWait.isWaiting(threadTs)) return outcome;
  return {
    text:
      `${outcome.text}\n\nAn operator is waiting for this in thread ${threadTs}. Tell them now, with "reply" in that thread, that it was ` +
      "refused and why. Do not retry around the refusal: no other incident's fingerprint or id.",
    isError: true,
  };
}

async function callKedbTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (kedbLoop === undefined) return { text: `the KEDB learning loop is off: ${kedbUnavailable}`, isError: true };
  switch (name) {
    case "propose_runbook_update":
      return proposeRunbookUpdate(kedbLoop, args);
    case "apply_runbook_update":
      return kedbLoop.apply(args.id);
    case "list_runbook_proposals":
      return kedbLoop.list(args.status);
    case "withdraw_runbook_proposal":
      return kedbLoop.withdraw(args);
    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}

// -- MCP Channel Server -------------------------------------------------------

// MUST render under 2048 characters. Claude Code truncates server instructions at that
// limit and only says so in the MCP debug log, so anything past it is lost in silence.
// This had already overrun by 103 characters, which cost exactly the operator_reply line
// at the end — the one telling the agent to answer an operator replying in an escalation
// thread. checkInstructionBudget() below refuses to start rather than let that recur.
const CHANNEL_INSTRUCTIONS = `You talk to the ops team in a shared Slack channel (ID "${SRE_SLACK_CHANNEL}").

Operators — the only people who can reach you or approve your tool use: ${OPERATOR_ROSTER}.

Messages arrive as <channel source="slack_sre" sender sender_name channel thread_ts channel_type>.
Address people by sender_name — you are talking to a team, not one person.

A channel message reaches you only when addressed to you: an @-mention, or a reply in any
thread you have posted in. DMs always reach you.

Tools:
- "reply" — omit "channel" to post in the team channel; pass the inbound thread_ts to stay in-thread.
- "escalate" — posts to the team channel and pages every operator when severity is critical.
- "resolve_escalation" — closes one out.

Escalations nag in-thread every 10 min (critical prod) or 1 hour (dev/staging) until an
operator replies, which stops the nagging. Say what broke, what you tried, what you need.

Keep one alert in one thread: post the escalation, then reply in that thread as you learn
more. Never open a new top-level message for something already in flight; the channel is
shared. "escalate" holds you to this: for a fingerprint whose escalation is still waiting, it
posts nothing and answers with that thread (deduplicated: true); "reply" there.

Message types that arrive automatically:
- type="escalation_timeout" final_agent_nag="false": nobody replied. Note it and stand by — do NOT re-investigate.
- type="escalation_timeout" final_agent_nag="true": the team is offline. Say so ONCE, then ignore further nags; the channel drops to Slack-only automatically.
- type="operator_reply": an operator replied in an escalation thread. Continue the conversation.
- type="operator_waiting": an operator has had no answer in thread_ts for minutes. Answer there now.
type="runbook_*" (feedback, applied, rejected, stale, failed) is about your runbook proposal proposal_id: CLAUDE.md "Learning loop".`;

// Fail loudly if the instructions overrun. The overrun is invisible from the source —
// SRE_OPERATORS is interpolated, so the roster's length is what decides whether the last
// line survives. Refusing to start beats running with instructions the agent never sees.
const MAX_INSTRUCTION_CHARS = 2048;

if (CHANNEL_INSTRUCTIONS.length > MAX_INSTRUCTION_CHARS) {
  console.error(
    `[slack-sre] channel instructions are ${CHANNEL_INSTRUCTIONS.length} chars, ${MAX_INSTRUCTION_CHARS} max — ` +
      `the last ${CHANNEL_INSTRUCTIONS.length - MAX_INSTRUCTION_CHARS} would be silently dropped, starting with: ` +
      JSON.stringify(
        CHANNEL_INSTRUCTIONS.slice(
          MAX_INSTRUCTION_CHARS,
          MAX_INSTRUCTION_CHARS + 80
        )
      )
  );
  console.error(
    "[slack-sre] shorten the instructions template, or trim the SRE_OPERATORS display names."
  );
  process.exit(1);
}

console.error(
  `[slack-sre] channel instructions: ${CHANNEL_INSTRUCTIONS.length}/${MAX_INSTRUCTION_CHARS} chars`
);

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
    instructions: CHANNEL_INSTRUCTIONS,
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
    ...KEDB_TOOLS,
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
      const ts = await slackPoster.post({
        channel: target,
        text,
        thread_ts,
      });

      // Remember the thread so operator replies to it come back to us without
      // needing an explicit @-mention.
      const conversationTs = thread_ts ?? ts;
      threadOwnership.remember(conversationTs);

      // The agent has spoken for itself — no need for the channel to do it.
      operatorWait.answered(conversationTs);

      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `failed to send: ${describePostFailure(err)}` }],
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

    // Trivy findings are posted, and paged at most once, by the Trivy channel itself
    if (isTrivyEscalation(alert_fingerprint)) {
      console.error(`[slack-sre] refused a Trivy escalation from the agent: ${alert_fingerprint} (${alert_name})`);
      return {
        content: [{ type: "text" as const, text: TRIVY_ESCALATION_REFUSED }],
        isError: true,
      };
    }

    try {
      const outcome = await escalator.escalate({
        alertFingerprint: alert_fingerprint,
        alertName: alert_name,
        severity,
        environment,
        message,
      });

      if (outcome.deduplicated) {
        console.error(
          `[slack-sre] ${alert_fingerprint} (${alert_name}) is already escalated and waiting; answered with thread ${outcome.ts}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text:
                `already escalated and still waiting for the team, so nothing new was posted; ` +
                `post updates in that thread with the reply tool: ` +
                JSON.stringify(outcome),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `escalated to the team channel (thread: ${outcome.ts})`,
          },
        ],
      };
    } catch (err) {
      const text =
        err instanceof SlackPostRejected
          ? `escalation failed, nothing was posted: ${err.message}`
          : `escalation outcome unknown: ${describePostFailure(err)}. Calling escalate again for this fingerprint is ` +
            `safe: it checks the channel first and never posts a second thread.`;
      return { content: [{ type: "text" as const, text }], isError: true };
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
        await slackPoster.post({
          channel: escalation.slackChannel,
          thread_ts: escalation.slackThreadTs,
          text: `:white_check_mark: *Resolved*\n\n${resolution_message}`,
        });
      } catch (err) {
        // Non-fatal for the agent's bookkeeping, but it means the team never saw
        // the resolution — say so rather than reporting a clean success.
        const msg = describePostFailure(err);
        console.error(
          `[slack-sre] failed to post resolution for ${alert_fingerprint}:`,
          err
        );
        activeEscalations.delete(alert_fingerprint);
        persistEscalations();
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
    persistEscalations();

    return {
      content: [{ type: "text" as const, text: "escalation resolved" }],
    };
  }

  if (KEDB_TOOL_NAMES.has(name)) return toolResult(await callKedbTool(name, args ?? {}));

  // Never throw out of a tool call (CLAUDE_ERROR_PATTERNS.md §15)
  return {
    content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
    isError: true,
  };
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

    const ts = await slackPoster.post({
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

    threadOwnership.remember(ts);
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
  if (!auth.url) {
    throw new Error("auth.test returned no workspace URL");
  }
  SLACK_TEAM_URL = auth.url;
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

    const pending = pendingPermissions.get(requestId);
    if (pending === undefined) {
      // Don't leave the operator wondering whether it landed. A restart is the common
      // cause and is worth naming: the tool call that asked is gone with the session, so
      // there is nothing left to approve and the agent will ask again if it still needs to.
      console.error(
        `[slack-sre] ${senderName} answered unknown permission request ${requestId}`
      );
      await postOrLog(
        {
          channel: channelId ?? SRE_SLACK_CHANNEL,
          thread_ts: replyThreadTs,
          text:
            `:grey_question: No pending permission request \`${requestId}\` — it was already answered, ` +
            "expired, or the agent restarted since it asked. Nothing is waiting on this verdict; " +
            "the agent will ask again if it still needs approval.",
        },
        `the unknown-permission notice for ${requestId}`
      );
      return;
    }

    pendingPermissions.delete(requestId);

    try {
      await withTimeout(
        mcp.notification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: requestId,
            behavior: approved ? "allow" : "deny",
          },
        }),
        AGENT_NOTIFY_TIMEOUT_MS,
        "permission verdict"
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[slack-sre] could not pass ${senderName}'s verdict on ${requestId} to the agent: ${reason}`);
      await postOrLog(
        {
          channel: channelId ?? SRE_SLACK_CHANNEL,
          thread_ts: replyThreadTs,
          text: `:x: Could not pass your verdict on \`${requestId}\` to the agent (${reason}). It may still be waiting; answer again.`,
        },
        `the failed permission verdict for ${requestId}`
      );
      // Still pending: a second answer must be accepted, not called unknown.
      pendingPermissions.set(requestId, pending);
      return;
    }

    await postOrLog(
      {
        channel: channelId ?? SRE_SLACK_CHANNEL,
        thread_ts: replyThreadTs,
        text: `:white_check_mark: Permission ${approved ? "approved" : "denied"} for \`${requestId}\` by ${senderName}.`,
      },
      `the permission verdict for ${requestId}`
    );
    return;
  }

  // Runbook proposals: an approver's "yes"/"no" is acted on here, in code, and never reaches
  // the agent as a message; other replies in a proposal's thread reach it as feedback.
  let runbookMeta: Record<string, string> | undefined;
  if (kedbLoop !== undefined && channelId !== undefined) {
    const outcome = await kedbLoop.onMessage({
      user: senderId,
      text,
      channel: channelId,
      ts: message.ts,
      threadTs: parentThreadTs,
    });
    if (outcome.handled) return;
    runbookMeta = outcome.meta;
  }

  // Channel gating — the agent's context window is its lifeline. A channel message
  // is only forwarded when it is addressed to the agent. See message-gate.ts.
  const addressing = classifyAddressing({
    isDirectMessage,
    text,
    botUserId: BOT_USER_ID,
    parentThreadTs,
  });

  let addressed: boolean;
  switch (addressing.kind) {
    case "direct_message":
    case "mention":
      addressed = true;
      break;
    case "thread_reply":
      // Asked of Slack, not of process memory — a thread opened before the nightly
      // restart must still reach the agent. See thread-ownership.ts.
      addressed = await threadOwnership.owns(
        channelId ?? SRE_SLACK_CHANNEL,
        addressing.threadTs
      );
      break;
    case "unaddressed":
      addressed = false;
      break;
  }

  if (!addressed) {
    // Log it. A silent drop is indistinguishable from a broken agent, which is exactly how
    // this went unnoticed for eleven days.
    console.error(
      `[slack-sre] dropped message from ${senderName} in ${channelId ?? "unknown channel"}` +
        `${parentThreadTs ? ` (thread ${parentThreadTs})` : ""} — ${addressing.kind}, not addressed to the agent`
    );
    return;
  }

  // A reply in an escalation thread counts as acknowledgement — stop nagging.
  let isEscalationReply = false;
  if (parentThreadTs) {
    for (const esc of activeEscalations.values()) {
      if (esc.slackThreadTs !== parentThreadTs) continue;
      isEscalationReply = true;
      if (!esc.acknowledged) {
        esc.acknowledged = true;
        esc.acknowledgedBy = senderName;
        persistEscalations();
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
  threadOwnership.remember(conversationThreadTs);

  // Promise the operator an answer if the agent stays quiet, and chase it if it stays quiet
  // for minutes.
  operatorWait.messageReceived(channelId ?? SRE_SLACK_CHANNEL, conversationThreadTs, senderName);

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
  if (runbookMeta) Object.assign(meta, runbookMeta);

  try {
    await notifyAgent(content, meta);
  } catch (err) {
    // Most likely the agent never got it, so nobody is working on it: say so instead of "On it".
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[slack-sre] could not hand ${senderName}'s message in ${conversationThreadTs} to the agent: ${reason}`);
    operatorWait.answered(conversationThreadTs);
    await postOrLog(
      {
        channel: channelId ?? SRE_SLACK_CHANNEL,
        thread_ts: conversationThreadTs,
        text: `:x: ${senderName}, your message may not have reached the agent (${reason}). Send it again; if this repeats, the agent session needs a look.`,
      },
      `the undelivered-message notice in ${conversationThreadTs}`
    );
  }
});

// Start Slack Socket Mode
await slackApp.start();
console.error(
  `[slack-sre] connected to Slack via Socket Mode — channel ${SRE_SLACK_CHANNEL}, operators: ${OPERATOR_ROSTER}`
);

// -- Escalation nag timer -----------------------------------------------------

// One sweep at a time: with every Slack post bounded at SLACK_TIMEOUT_MS, a sweep over many
// escalations can outlast the 1-min tick, and two overlapping sweeps would nag twice.
let sweeping = false;

async function nagSweep(): Promise<void> {
  threadOwnership.prune();
  prunePendingPermissions();
  operatorWait.prune(OPERATOR_WAIT_RETENTION_MS);

  const now = Date.now();
  let escalationsChanged = false;

  for (const [fingerprint, esc] of activeEscalations) {
    if (esc.acknowledged) continue;
    // Restored from before the Trivy channel posted its own findings: never nag about one
    if (isTrivyEscalation(fingerprint)) continue;

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
    escalationsChanged = true;

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

        await slackPoster.post({
          channel: esc.slackChannel,
          thread_ts: esc.slackThreadTs,
          text: `${urgency} — alert *${esc.alertName}* [${esc.environment.toUpperCase()}] is still unacknowledged. Nag #${esc.nagCount}.${slackOnlyNote}`,
        });
      } catch (err) {
        console.error(`[slack-sre] failed to nag for ${fingerprint}: ${describePostFailure(err)}`);
      }
    }

    // Only push timeout events into Claude's session up to MAX_AGENT_NAGS.
    // After that, Slack nags continue but the agent's context is preserved.
    if (!agentExhausted) {
      await withTimeout(
        mcp.notification({
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
        }),
        AGENT_NOTIFY_TIMEOUT_MS,
        "agent notification"
      ).catch((err: unknown) => {
        console.error(
          `[slack-sre] could not push the nag for ${fingerprint} to the agent: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  }

  // One write per sweep rather than one per escalation: the nag counters only have to
  // survive a restart, and a restart cannot land mid-loop.
  if (escalationsChanged) persistEscalations();
}

// Runbook proposals: 24 h reminder, 7 day expiry, and applying an approval that a restart
// interrupted. Its own guard: a sweep can include a fetch, a lint and a push.
let kedbSweeping = false;
if (kedbLoop !== undefined) {
  const loop = kedbLoop;
  setInterval(() => {
    if (kedbSweeping) return;
    kedbSweeping = true;
    loop
      .sweep()
      .catch((err: unknown) => {
        console.error(`[slack-sre] KEDB sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        kedbSweeping = false;
      });
  }, KEDB_SWEEP_INTERVAL_MS);
}

setInterval(() => {
  if (sweeping) return;
  sweeping = true;
  nagSweep()
    .catch((err: unknown) => {
      console.error(`[slack-sre] nag sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      sweeping = false;
    });
}, 60_000); // check every minute
