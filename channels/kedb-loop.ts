// The KEDB learning loop (plan §4): the agent proposes a runbook change in Slack, an approver
// answers, and code (never the agent) commits it to sre-kedb.
//
//   propose  → checks (incident binding, schema, lint, guardrails §5b-§5d), posts the
//              proposal, stores it
//   approve  → a reply classified by kedb-approval.ts; the approval is bound to the content
//              hash and to the revision's post
//   apply    → fetch, reset, base-blob check, write, lint, commit with trailers, push
//   sweep    → 24 h reminder, 7 day expiry, and resuming an approval a restart interrupted
//
// The incident binding: the fingerprint must be the one incidents.db logged for incident_id, so
// a refusal about one incident can never be passed with another incident's alert.
//
// The injection check (§5d) fails closed when no raw payload is kept for the fingerprint, with
// one exception: an approver asked for the proposal, in its thread. That request is taken from
// the Slack event (noteRequest: the sender's user id, the channel, the thread), never from the
// agent, so the agent cannot claim it. The proposal post and the commit then say the check did
// not run (Injection-Check trailer), and sre-kedb's verify-approvals checks both from Slack.
//
// Every entry point returns an outcome and never throws, so neither a tool call nor the Slack
// handler can be aborted by it (CLAUDE_ERROR_PATTERNS.md §15). Each failure is reported where
// someone will read it: the tool result, the proposal's thread, or the log.

import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyReply, compareSlackTs, slackPermalink, type InboundMessage } from "./kedb-approval.js";
import type { KedbGit } from "./kedb-git.js";
import type { IncidentLookup, IncidentRecord } from "./incident-lookup.js";
import {
  addedLines,
  autoFixProblems,
  detectDowngrade,
  evidenceLines,
  injectionProblems,
  learnedProblems,
  loadSentinelAllowlist,
  machineFieldProblems,
  NoRetainedPayloadError,
  parseCandidate,
  retainedPayloadStrings,
  securityProblems,
  textProblems,
  type CandidateEntry,
  type Downgrade,
  type UrlPolicy,
} from "./kedb-guardrails.js";
import { ENTRY_ID, KEDB_MAX_ENTRY_BYTES } from "./kedb-index.js";
import { GAP_FINGERPRINT, OPEN_STATUSES, PROPOSAL_ID, SLACK_TS, type Proposal, type ProposalStore } from "./proposal-store.js";
import { escapeSlackText } from "./slack-text.js";

/** A diff longer than this is refused: Leo must always be able to read all of it. */
export const MAX_DIFF_CHANGED_LINES = 80;
/** And no diff may be longer than this many characters, so the post fits one Slack message. */
export const MAX_DIFF_CHARS = 15_000;
/** Proposals that may be open (pending, approved, failed or stale) at once. */
export const MAX_OPEN_PROPOSALS = 3;
export const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
export const EXPIRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An approver's message that asks for a runbook proposal. Deliberately loose about the wording
 * ("propose the KB-1 Falco downgrade please", "can you write a runbook entry for this"): what
 * makes it a request is who sent it and where, both from Slack. sre-kedb ci/verify-approvals.ts
 * REQUEST_RE re-checks the message; keep the two equal.
 */
export const REQUEST_RE = /\b(?:propos(?:e|al|als|ing)|runbook|kedb|kb-\d+)\b/i;
/** How long an approver's request lets a payload-less proposal through in its thread. */
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface ToolOutcome {
  text: string;
  isError: boolean;
}

export interface SlackPost {
  post(message: { channel: string; text: string; thread_ts?: string }): Promise<string>;
}

export interface KedbLoopOptions {
  store: ProposalStore;
  git: KedbGit;
  poster: SlackPost;
  /** Pushes an event into the Claude session. Rejections are logged, never thrown. */
  notifyAgent(content: string, meta: Record<string, string>): Promise<void>;
  /** Slack user id → display name of the people who may approve (SRE_KEDB_APPROVERS). */
  approvers: ReadonlyMap<string, string>;
  /** The team channel proposals are posted in. */
  channel: string;
  /** The workspace URL from auth.test, resolved at startup. */
  teamUrl(): string;
  /** signoz-webhook's raw payload directory (data/alert-payloads). */
  payloadDir: string;
  /** Read-only sentinel clone, for the auto_fix allowlist. */
  sentinelDir: string;
  /** incidents.db: a proposal's fingerprint must be its incident's. */
  incidents: IncidentLookup;
  urlPolicy: UrlPolicy;
  /** Bound on local file reads (payloads, sentinel catalog). */
  readTimeoutMs: number;
  /** The web URL of a commit in sre-kedb. */
  commitUrl(sha: string): string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MessageOutcome {
  /** True when the message was consumed here and must not reach the agent as a message. */
  handled: boolean;
  /** Extra meta for a message that still goes to the agent (runbook_feedback). */
  meta?: Record<string, string>;
}

export interface KedbLoop {
  propose(args: unknown): Promise<ToolOutcome>;
  apply(id: unknown): Promise<ToolOutcome>;
  list(status: unknown): ToolOutcome;
  withdraw(args: unknown): Promise<ToolOutcome>;
  onMessage(message: InboundMessage): Promise<MessageOutcome>;
  /**
   * An operator's message that reached the agent. When an approver asks for a proposal in it,
   * the request is remembered for its thread (REQUEST_TTL_MS). Call it only with messages
   * straight from Slack: the user id is what makes it a request.
   */
  noteRequest(message: InboundMessage): void;
  sweep(): Promise<void>;
}

const ProposeArgs = z
  .object({
    entry_id: z.string().regex(ENTRY_ID),
    op: z.enum(["create", "update", "retire"]),
    new_content: z.string().min(1).max(KEDB_MAX_ENTRY_BYTES),
    learned: z.string().min(1).max(600),
    incident_id: z.string().regex(/^[0-9]{1,9}$/),
    fingerprint: z.string().min(1).max(256),
    thread_ts: z.string().regex(SLACK_TS),
    supersedes: z.string().regex(PROPOSAL_ID).optional(),
  })
  .strict();

const WithdrawArgs = z.object({ id: z.string().regex(PROPOSAL_ID), reason: z.string().min(1).max(300) }).strict();

const SUPERSEDABLE: ReadonlySet<Proposal["status"]> = new Set(["pending", "rejected", "stale", "failed"]);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function refuse(text: string): ToolOutcome {
  return { text, isError: true };
}

function entryPath(entryId: string): string {
  return `entries/${entryId}.md`;
}

function changedLines(diff: string): number {
  return diff.split("\n").filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))).length;
}

/**
 * The diff as it shows in a Slack code block: &, < and > escaped (Slack's rule), and a ```
 * inside it, which would close the block early, shown as ''' with a note saying so.
 */
export function slackDiffBlock(diff: string): string {
  const fenced = diff.includes("```");
  const shown = escapeSlackText(diff.replace(/```/g, "'''")).trimEnd();
  const note = fenced ? "\n_(Code fences ``` in the entry show as ''' in this preview.)_" : "";
  return "```\n" + shown + "\n```" + note;
}

function causeIds(entry: CandidateEntry | null): string[] {
  return (entry?.fm.benign_causes ?? []).map((c) => c.id);
}

function describeChange(op: Proposal["op"], entryId: string, before: CandidateEntry | null, after: CandidateEntry): string {
  if (op === "create") return `new entry \`${entryId}\`${causeIds(after).length > 0 ? ` with benign cause(s) ${causeIds(after).map((c) => `\`${c}\``).join(", ")}` : ""}`;
  if (op === "retire") return `retire entry \`${entryId}\` (its alerts fall back to the family entry)`;
  const added = causeIds(after).filter((c) => !causeIds(before).includes(c));
  const removed = causeIds(before).filter((c) => !causeIds(after).includes(c));
  const parts = [`update entry \`${entryId}\``];
  if (added.length > 0) parts.push(`adds benign cause(s) ${added.map((c) => `\`${c}\``).join(", ")}`);
  if (removed.length > 0) parts.push(`removes benign cause(s) ${removed.map((c) => `\`${c}\``).join(", ")}`);
  return parts.join("; ");
}

/** The proposal post's line for a payload gap. sre-kedb verify-approvals looks for its words. */
export function payloadGapNotice(gap: NonNullable<Proposal["payload_gap"]>): string {
  return (
    `:warning: *injection check NOT run: no raw payload kept for ${gap.fingerprint}*. This change was not compared ` +
    `with the alert's own text; read the diff as untrusted. Proposed because ${escapeSlackText(gap.requested_by.name)} asked: ${gap.requested_by.permalink}`
  );
}

export function formatProposalPost(p: Proposal, change: string): string {
  const lines = [
    `:books: *Runbook proposal ${p.id}* (rev ${p.rev}): incident #${p.incident_id}, entry \`${p.entry_id}\``,
    `*What I learned:* ${escapeSlackText(p.learned)}`,
    `*Change:* ${change}`,
  ];
  if (p.payload_gap !== null) lines.push(payloadGapNotice(p.payload_gap));
  if (p.downgrade !== null) {
    lines.push(
      `:warning: *SEVERITY DOWNGRADE:* ${p.downgrade.from ?? "none"} → ${p.downgrade.to ?? "none"} (${escapeSlackText(p.downgrade.scope.join("; "))}). ` +
        `To accept, reply exactly *yes downgrade ${p.id}*.`
    );
  }
  lines.push(slackDiffBlock(p.diff));
  lines.push(`Content-SHA256: \`${p.content_sha256}\``);
  lines.push(
    p.downgrade === null
      ? `Reply *yes* to apply, *no* to drop, or tell me what to change.`
      : `Reply *yes downgrade ${p.id}* to apply, *no* to drop, or tell me what to change.`
  );
  return lines.join("\n");
}

export function commitMessage(p: Proposal, approverName: string): string {
  if (p.approval === null || p.post_permalink === null) throw new Error(`${p.id} has no approval or no post`);
  const verb = p.op === "create" ? "add entry" : p.op === "retire" ? "retire entry" : "update entry";
  const trailers = [
    `Incident: #${p.incident_id} ${p.thread_permalink}`,
    `Entry: ${p.entry_id}`,
    `Proposal: ${p.id} rev ${p.rev}`,
    `Proposal-Post: ${p.post_permalink}`,
    `Approved-by: ${approverName} ${p.approval.user} ${p.approval.permalink}`,
  ];
  if (p.downgrade !== null) trailers.push(`Severity-Downgrade: ${p.downgrade.from ?? "none"}→${p.downgrade.to ?? "none"}`);
  if (p.payload_gap !== null) {
    const by = p.payload_gap.requested_by;
    trailers.push(`Injection-Check: not-run; no raw payload kept for ${p.payload_gap.fingerprint}; requested-by ${by.name} ${by.user} ${by.permalink}`);
  }
  trailers.push(`Content-SHA256: ${p.content_sha256}`);
  return `kedb(${p.entry_id}): ${verb} (${p.id} rev ${p.rev})\n\n${p.learned}\n\n${trailers.join("\n")}\n`;
}

export function createKedbLoop(options: KedbLoopOptions): KedbLoop {
  const { store, git, poster, approvers, channel, now = Date.now, log = (line) => console.error(line) } = options;
  const applying = new Set<string>();
  /** Thread ts → the latest approver request in it (team channel only). */
  const requests = new Map<string, { request: NonNullable<Proposal["payload_gap"]>["requested_by"]; at: number }>();

  function update(p: Proposal, changes: Partial<Proposal>): Proposal {
    const next = { ...p, ...changes, updated_at: now() };
    store.put(next);
    return next;
  }

  async function postInThread(p: Proposal, text: string): Promise<void> {
    try {
      await poster.post({ channel: p.slack_channel, thread_ts: p.thread_ts, text });
    } catch (err) {
      log(`[kedb-loop] could not post in the thread of ${p.id}: ${message(err)}`);
    }
  }

  async function notify(content: string, meta: Record<string, string>): Promise<void> {
    try {
      await options.notifyAgent(content, meta);
    } catch (err) {
      log(`[kedb-loop] could not tell the agent (${meta.type}): ${message(err)}`);
    }
  }

  // -- propose ------------------------------------------------------------------------------

  interface Checked {
    before: CandidateEntry | null;
    after: CandidateEntry;
    baseBlob: string | null;
    diff: string;
    downgrade: Downgrade | null;
    payloadGap: Proposal["payload_gap"];
  }

  /**
   * Null when the fingerprint is the one incidents.db logged for the incident, else why not.
   * Never echoes what incidents.db holds: an alert's fingerprint is its sender's text.
   */
  async function incidentProblem(args: z.infer<typeof ProposeArgs>): Promise<string | null> {
    let incident: IncidentRecord | null;
    try {
      incident = await options.incidents.find(args.incident_id);
    } catch (err) {
      return `cannot check incident #${args.incident_id} against incidents.db: ${message(err)}`;
    }
    if (incident === null) return `incident #${args.incident_id} does not exist in incidents.db`;
    if (incident.fingerprint === null) {
      return `incident #${args.incident_id} was logged without a fingerprint, so ${args.fingerprint} cannot be shown to be its alert`;
    }
    if (incident.fingerprint !== args.fingerprint) {
      return (
        `fingerprint ${args.fingerprint} is not the one incident #${args.incident_id} was logged with. A proposal is checked ` +
        `against its own incident's alert: never pass another incident's fingerprint or id to get past a check`
      );
    }
    return null;
  }

  /** The approver's request that lets a payload-less proposal in this thread through, if any. */
  function requestFor(args: z.infer<typeof ProposeArgs>, superseded: Proposal | undefined): NonNullable<Proposal["payload_gap"]>["requested_by"] | null {
    const live = requests.get(args.thread_ts);
    if (live !== undefined && now() - live.at <= REQUEST_TTL_MS) return live.request;
    // A revision after feedback carries the request its first revision was posted under.
    if (superseded === undefined || superseded.payload_gap === null) return null;
    const gap = superseded.payload_gap;
    return superseded.thread_ts === args.thread_ts && gap.fingerprint === args.fingerprint ? gap.requested_by : null;
  }

  async function check(args: z.infer<typeof ProposeArgs>, superseded: Proposal | undefined): Promise<Checked | string[]> {
    const path = entryPath(args.entry_id);
    let after: CandidateEntry;
    try {
      after = parseCandidate(args.new_content);
    } catch (err) {
      return [`new_content is not a valid entry: ${message(err)}`];
    }
    const problems: string[] = [];
    if (after.fm.id !== args.entry_id) problems.push(`new_content has id '${after.fm.id}', not '${args.entry_id}'`);
    if (args.op === "retire" && after.fm.status !== "retired") problems.push("op retire needs status: retired");
    if (args.op !== "retire" && after.fm.status === "retired") problems.push("set status: retired only with op retire");
    problems.push(...textProblems(args.new_content, "new_content"));
    problems.push(...machineFieldProblems(after.fm));
    problems.push(...securityProblems(after.fm));
    if (problems.length > 0) return problems;

    return git.exclusive(async () => {
      await git.sync();
      const baseBlob = await git.blobSha(path);
      const beforeText = await git.show(path);
      if (args.op === "create" && beforeText !== null) return [`${args.entry_id} already exists; use op update`];
      if (args.op !== "create" && beforeText === null) return [`${args.entry_id} does not exist on main; use op create`];

      let before: CandidateEntry | null = null;
      if (beforeText !== null) {
        try {
          before = parseCandidate(beforeText);
        } catch (err) {
          return [`the current ${path} on main does not parse (${message(err)}); fix it by MR first`];
        }
      }
      let family: CandidateEntry | null = null;
      if (after.fm.kind === "signature" && after.fm.family !== undefined) {
        const familyText = await git.show(entryPath(after.fm.family));
        if (familyText === null) return [`the family entry ${after.fm.family} does not exist on main`];
        family = parseCandidate(familyText);
      }

      const sentinel = (after.fm as Record<string, unknown>).auto_fix
        ? await loadSentinelAllowlist(options.sentinelDir, options.readTimeoutMs).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
        : new Error("not loaded");
      const found = autoFixProblems(after.fm, sentinel);
      if (found.length > 0) return found;

      const diff = await git.diff(path, beforeText, args.new_content);
      if (diff === "") return ["new_content is identical to the entry on main"];
      const changed = changedLines(diff);
      if (changed > MAX_DIFF_CHANGED_LINES) {
        return [`the change is ${changed} lines; at most ${MAX_DIFF_CHANGED_LINES}, so Leo can read all of it. Split it into smaller proposals.`];
      }
      if (diff.length > MAX_DIFF_CHARS) return [`the diff is ${diff.length} characters; at most ${MAX_DIFF_CHARS}. Split it.`];

      let payload: string[];
      let payloadGap: Proposal["payload_gap"] = null;
      try {
        payload = await retainedPayloadStrings(options.payloadDir, args.fingerprint, options.readTimeoutMs);
      } catch (err) {
        if (!(err instanceof NoRetainedPayloadError)) return [message(err)];
        const request = requestFor(args, superseded);
        if (request === null) {
          return [
            `${err.message}. Only an approver (${[...approvers.values()].join(" or ")}) asking for this proposal in thread ` +
              `${args.thread_ts} lets it through without the check. Report this refusal; never retry with another incident's fingerprint`,
          ];
        }
        if (!GAP_FINGERPRINT.test(args.fingerprint)) {
          return [`${err.message}, and fingerprint ${JSON.stringify(args.fingerprint.slice(0, 80))} cannot be written into the commit that would record it`];
        }
        // Copy check vacuous, links still checked. The post and the commit say it did not run.
        payload = [];
        payloadGap = { fingerprint: args.fingerprint, requested_by: request };
      }
      const injected = injectionProblems(addedLines(diff), evidenceLines(args.new_content), payload, options.urlPolicy);
      if (injected.length > 0) return injected;

      const linted = await git.lintCandidate(path, args.new_content);
      if (!linted.ok) return [`the sre-kedb lint rejects it:\n${linted.output}`];

      return { before, after, baseBlob, diff, downgrade: detectDowngrade(before?.fm ?? null, after.fm, family?.fm ?? null), payloadGap };
    });
  }

  async function propose(raw: unknown): Promise<ToolOutcome> {
    const parsed = ProposeArgs.safeParse(raw);
    if (!parsed.success) return refuse(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const args = parsed.data;

    const learned = learnedProblems(args.learned);
    if (learned.length > 0) return refuse(`refused: ${learned.join("; ")}`);

    const latest = store.latest();
    let superseded: Proposal | undefined;
    if (args.supersedes !== undefined) {
      superseded = latest.find((p) => p.id === args.supersedes);
      if (superseded === undefined) return refuse(`refused: there is no proposal ${args.supersedes}`);
      if (superseded.entry_id !== args.entry_id) return refuse(`refused: ${args.supersedes} is for ${superseded.entry_id}, not ${args.entry_id}`);
      if (!SUPERSEDABLE.has(superseded.status)) return refuse(`refused: ${args.supersedes} is ${superseded.status} and cannot be superseded`);
    }
    const open = latest.filter((p) => OPEN_STATUSES.has(p.status) && p.id !== superseded?.id);
    const sameEntry = open.find((p) => p.entry_id === args.entry_id);
    if (sameEntry) return refuse(`refused: ${sameEntry.id} for ${args.entry_id} is still ${sameEntry.status}; pass supersedes: "${sameEntry.id}" to revise it`);
    const sameIncident = open.find((p) => p.incident_id === args.incident_id);
    if (sameIncident) return refuse(`refused: ${sameIncident.id} is already open for incident #${args.incident_id}; one proposal per incident`);
    if (open.length >= MAX_OPEN_PROPOSALS) return refuse(`refused: ${open.length} proposals are already open (${open.map((p) => p.id).join(", ")}); at most ${MAX_OPEN_PROPOSALS}`);

    const unbound = await incidentProblem(args);
    if (unbound !== null) return refuse(`refused: ${unbound}`);

    let checked: Checked | string[];
    try {
      checked = await check(args, superseded);
    } catch (err) {
      return refuse(`could not check the proposal: ${message(err)}`);
    }
    if (Array.isArray(checked)) return refuse(`refused:\n- ${checked.join("\n- ")}`);

    const created = now();
    let record: Proposal;
    try {
      const id = superseded?.id ?? store.allocateId();
      record = {
        id,
        rev: superseded === undefined ? 1 : superseded.rev + 1,
        entry_id: args.entry_id,
        op: args.op,
        base_blob_sha: checked.baseBlob,
        content: args.new_content,
        content_sha256: sha256(args.new_content),
        diff: checked.diff,
        learned: args.learned,
        incident_id: args.incident_id,
        fingerprint: args.fingerprint,
        slack_channel: channel,
        thread_ts: args.thread_ts,
        thread_permalink: slackPermalink(options.teamUrl(), channel, args.thread_ts),
        post_ts: null,
        post_permalink: null,
        posted_at: null,
        downgrade: checked.downgrade,
        payload_gap: checked.payloadGap,
        status: "pending",
        status_reason: null,
        approval: null,
        commit_sha: null,
        created_at: created,
        updated_at: created,
        reminded_at: null,
      };
      store.put(record);
      if (superseded !== undefined) update(superseded, { status: "superseded", status_reason: `replaced by rev ${record.rev}` });
    } catch (err) {
      return refuse(`could not store the proposal, nothing was posted: ${message(err)}`);
    }

    let postTs: string;
    try {
      postTs = await poster.post({
        channel,
        thread_ts: args.thread_ts,
        text: formatProposalPost(record, describeChange(args.op, args.entry_id, checked.before, checked.after)),
      });
    } catch (err) {
      try {
        update(record, { status: "withdrawn", status_reason: `the proposal post failed: ${message(err)}` });
      } catch (storeErr) {
        log(`[kedb-loop] could not withdraw ${record.id} after its post failed: ${message(storeErr)}`);
      }
      return refuse(`${record.id} rev ${record.rev} was not posted (${message(err)}); it is withdrawn. Propose again.`);
    }
    try {
      update(record, { post_ts: postTs, post_permalink: slackPermalink(options.teamUrl(), channel, postTs, args.thread_ts), posted_at: now() });
    } catch (err) {
      return refuse(`${record.id} was posted but could not be stored (${message(err)}); an approval of it cannot be applied. Withdraw it.`);
    }
    const gap = record.payload_gap;
    log(
      `[kedb-loop] posted ${record.id} rev ${record.rev} for ${record.entry_id}${record.downgrade ? " (downgrade)" : ""}` +
        (gap ? ` WITHOUT the injection check (no payload for ${gap.fingerprint}; requested by ${gap.requested_by.name} ${gap.requested_by.user})` : "")
    );
    return {
      text:
        `posted ${record.id} rev ${record.rev} in thread ${args.thread_ts}. Code applies it when ${[...approvers.values()].join(" or ")} answers ` +
        `${record.downgrade ? `"yes downgrade ${record.id}"` : '"yes"'}; you will get type="runbook_applied" or "runbook_rejected".` +
        (gap ? ` The injection check did NOT run (no raw payload kept for ${gap.fingerprint}); ${gap.requested_by.name} asked for it, and the post says so.` : ""),
      isError: false,
    };
  }

  // -- apply --------------------------------------------------------------------------------

  async function applyProposal(id: string): Promise<ToolOutcome> {
    const p = store.get(id);
    if (p === undefined) return refuse(`no proposal ${id}`);
    if (p.status !== "approved" && p.status !== "failed") return refuse(`${id} rev ${p.rev} is ${p.status}; only an approved (or failed) proposal is applied`);
    const approval = p.approval;
    if (approval === null || !approvers.has(approval.user)) return refuse(`${id} has no approval from ${[...approvers.values()].join(" or ")}`);
    if (p.post_ts === null || compareSlackTs(approval.ts, p.post_ts) <= 0) return refuse(`${id}'s approval does not postdate its rev ${p.rev} post`);
    if (sha256(p.content) !== p.content_sha256) return refuse(`${id}'s content does not match its approved hash; refusing`);
    if (applying.has(id)) return refuse(`${id} is being applied right now`);

    applying.add(id);
    const trailer = `Proposal: ${p.id} rev ${p.rev}`;
    try {
      const outcome = await git.exclusive(async (): Promise<{ kind: "applied"; sha: string } | { kind: "stale" }> => {
        await git.sync();
        // A push whose answer was lost: the commit is already on main.
        const existing = await git.findCommitWithLine(trailer);
        if (existing !== null) return { kind: "applied", sha: existing };
        if ((await git.blobSha(entryPath(p.entry_id))) !== p.base_blob_sha) return { kind: "stale" };
        const name = approvers.get(approval.user) ?? approval.user;
        return { kind: "applied", sha: await git.commitAndPush(entryPath(p.entry_id), p.content, commitMessage(p, name)) };
      });

      if (outcome.kind === "stale") {
        update(p, { status: "stale", status_reason: "main changed since the proposal" });
        await postInThread(p, `:arrows_counterclockwise: ${p.id} not applied: \`${p.entry_id}\` changed on main since I proposed it. I will re-propose it against the new version.`);
        await notify(`${p.id} rev ${p.rev} is stale: ${p.entry_id} changed on main. Re-propose against the current entry with supersedes "${p.id}".`, {
          type: "runbook_stale",
          proposal_id: p.id,
          entry_id: p.entry_id,
          thread_ts: p.thread_ts,
        });
        return refuse(`${p.id} is stale: ${p.entry_id} changed on main; re-propose with supersedes "${p.id}"`);
      }

      update(p, { status: "applied", status_reason: null, commit_sha: outcome.sha });
      const url = options.commitUrl(outcome.sha);
      await postInThread(p, `:white_check_mark: Applied ${p.id}: ${url}`);
      await notify(`${p.id} rev ${p.rev} is applied to ${p.entry_id}: ${url}`, {
        type: "runbook_applied",
        proposal_id: p.id,
        entry_id: p.entry_id,
        commit: outcome.sha,
        thread_ts: p.thread_ts,
      });
      log(`[kedb-loop] applied ${p.id} rev ${p.rev} as ${outcome.sha}`);
      return { text: `applied ${p.id}: ${url}`, isError: false };
    } catch (err) {
      const reason = message(err);
      try {
        update(p, { status: "failed", status_reason: reason });
      } catch (storeErr) {
        log(`[kedb-loop] could not record the failure of ${p.id}: ${message(storeErr)}`);
      }
      await postInThread(p, `:x: Could not apply ${p.id}: ${escapeSlackText(reason.slice(0, 500))}. Nothing changed on main; the agent can retry with apply_runbook_update.`);
      await notify(`${p.id} rev ${p.rev} failed to apply: ${reason}. Retry with apply_runbook_update once the cause is fixed.`, {
        type: "runbook_failed",
        proposal_id: p.id,
        entry_id: p.entry_id,
        thread_ts: p.thread_ts,
      });
      return refuse(`could not apply ${p.id}: ${reason}`);
    } finally {
      applying.delete(id);
    }
  }

  // -- Slack replies ------------------------------------------------------------------------

  async function onMessage(msg: InboundMessage): Promise<MessageOutcome> {
    const meaning = classifyReply(msg, { approvers, proposals: store.latest() });
    const reply = (text: string) => poster.post({ channel: msg.channel, thread_ts: msg.threadTs ?? msg.ts, text }).catch((err: unknown) => log(`[kedb-loop] could not answer in ${msg.threadTs ?? msg.ts}: ${message(err)}`));

    switch (meaning.kind) {
      case "none":
        return { handled: false };
      case "notice":
        await reply(meaning.text);
        return { handled: true };
      case "feedback":
        if (meaning.notice !== undefined) await reply(meaning.notice);
        return { handled: false, meta: { type: "runbook_feedback", proposal_id: meaning.proposal.id } };
      case "reject": {
        const p = meaning.proposal;
        const name = approvers.get(msg.user) ?? msg.user;
        try {
          update(p, { status: "rejected", status_reason: meaning.reason === "" ? `rejected by ${name}` : `rejected by ${name}: ${meaning.reason}` });
        } catch (err) {
          await reply(`:x: Could not record the rejection of ${p.id}: ${escapeSlackText(message(err))}`);
          return { handled: true };
        }
        await reply(`:no_entry_sign: ${p.id} rejected by ${name}. Nothing changes.`);
        await notify(`${name} rejected ${p.id} rev ${p.rev}${meaning.reason ? `: ${meaning.reason}` : "."} To try again, re-propose with supersedes "${p.id}".`, {
          type: "runbook_rejected",
          proposal_id: p.id,
          entry_id: p.entry_id,
          thread_ts: p.thread_ts,
        });
        return { handled: true };
      }
      case "approve": {
        const p = meaning.proposal;
        const name = approvers.get(msg.user) ?? msg.user;
        let approved: Proposal;
        try {
          approved = update(p, {
            status: "approved",
            status_reason: null,
            approval: { user: msg.user, name, ts: msg.ts, permalink: slackPermalink(options.teamUrl(), msg.channel, msg.ts, msg.threadTs), text: msg.text },
          });
        } catch (err) {
          await reply(`:x: Could not record your approval of ${p.id}: ${escapeSlackText(message(err))}. Nothing was applied; say yes again.`);
          return { handled: true };
        }
        await reply(`:hourglass_flowing_sand: ${approved.id} approved by ${name}; applying it.`);
        // Not awaited: the Slack handler must not wait on fetch, lint and push. apply posts its
        // own outcome in the thread and never rejects.
        void applyProposal(approved.id);
        return { handled: true };
      }
    }
  }

  // -- reminders, expiry, resumed approvals ------------------------------------------------

  async function sweep(): Promise<void> {
    const at = now();
    for (const [thread, { at: requestedAt }] of requests) {
      if (at - requestedAt > REQUEST_TTL_MS) requests.delete(thread);
    }
    for (const p of store.latest()) {
      try {
        if (p.status === "approved" && !applying.has(p.id)) {
          // Approved before a restart cut its apply short. apply is idempotent.
          await applyProposal(p.id);
          continue;
        }
        if (p.posted_at === null || !(p.status === "pending" || p.status === "stale" || p.status === "failed")) continue;
        const age = at - p.posted_at;
        if (age >= EXPIRY_AFTER_MS) {
          update(p, { status: "expired", status_reason: "no answer in 7 days" });
          await postInThread(p, `:wastebasket: ${p.id} expired after 7 days; nothing changed.`);
        } else if (p.status === "pending" && p.reminded_at === null && age >= REMINDER_AFTER_MS) {
          update(p, { reminded_at: at });
          const phrase = p.downgrade ? `yes downgrade ${p.id}` : `yes ${p.id}`;
          await postInThread(p, `:hourglass: ${p.id} (rev ${p.rev}) is still waiting for an answer: *${phrase}* applies it, *no ${p.id}* drops it. It expires in 6 days.`);
        }
      } catch (err) {
        log(`[kedb-loop] sweep of ${p.id} failed: ${message(err)}`);
      }
    }
  }

  return {
    propose,

    async apply(raw) {
      const id = z.string().regex(PROPOSAL_ID).safeParse(raw);
      if (!id.success) return refuse("id must look like KB-<n>");
      return applyProposal(id.data);
    },

    list(raw) {
      const status = z.string().optional().safeParse(raw);
      if (!status.success) return refuse("status must be a string");
      const rows = store
        .latest()
        .filter((p) => status.data === undefined || p.status === status.data)
        .map((p) => ({
          id: p.id,
          rev: p.rev,
          entry_id: p.entry_id,
          op: p.op,
          status: p.status,
          status_reason: p.status_reason,
          downgrade: p.downgrade,
          incident_id: p.incident_id,
          thread_ts: p.thread_ts,
          commit: p.commit_sha,
          posted_at: p.posted_at === null ? null : new Date(p.posted_at).toISOString(),
        }));
      return { text: JSON.stringify(rows), isError: false };
    },

    async withdraw(raw) {
      const parsed = WithdrawArgs.safeParse(raw);
      if (!parsed.success) return refuse(`invalid arguments: ${parsed.error.issues[0].message}`);
      const problems = textProblems(parsed.data.reason, "reason");
      if (problems.length > 0) return refuse(`refused: ${problems.join("; ")}`);
      const p = store.get(parsed.data.id);
      if (p === undefined) return refuse(`no proposal ${parsed.data.id}`);
      if (!(p.status === "pending" || p.status === "stale" || p.status === "failed")) return refuse(`${p.id} is ${p.status} and cannot be withdrawn`);
      try {
        update(p, { status: "withdrawn", status_reason: parsed.data.reason });
      } catch (err) {
        return refuse(`could not withdraw ${p.id}: ${message(err)}`);
      }
      await postInThread(p, `:leftwards_arrow_with_hook: ${p.id} withdrawn by the agent: ${escapeSlackText(parsed.data.reason)}`);
      return { text: `withdrew ${p.id}`, isError: false };
    },

    async onMessage(msg) {
      try {
        return await onMessage(msg);
      } catch (err) {
        log(`[kedb-loop] handling a reply failed: ${message(err)}`);
        return { handled: false };
      }
    },

    noteRequest(msg) {
      const name = approvers.get(msg.user);
      if (name === undefined || msg.channel !== channel || !REQUEST_RE.test(msg.text)) return;
      const thread = msg.threadTs ?? msg.ts;
      requests.set(thread, {
        request: { user: msg.user, name, ts: msg.ts, permalink: slackPermalink(options.teamUrl(), msg.channel, msg.ts, msg.threadTs) },
        at: now(),
      });
      log(`[kedb-loop] ${name} asked for a runbook proposal in thread ${thread}`);
    },

    sweep,
  };
}
