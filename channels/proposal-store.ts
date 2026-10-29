// Runbook proposal persistence for the KEDB learning loop (plan §4, "State").
//
// A proposal is the agent asking Leo, in Slack, to change one KEDB entry. Unlike a pending
// permission request, it is persisted on purpose: an approval does not need the session that
// asked, because code applies it (kedb-loop.ts). A "yes" that arrives while the session or
// this process restarts must still find its proposal.
//
// Written like escalation-store.ts: atomically (temp file + rename), because pm2 can kill the
// process mid-write. Unlike it, a file that does not validate is an error, never an empty
// start: an empty start would reset the KB-<n> counter, and a "yes KB-3" written for the old
// KB-3 could then approve a new, unrelated KB-3. The caller disables the loop instead.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ACTION_LADDER, ENTRY_ID } from "./kedb-index.js";

export const PROPOSAL_STATUSES = [
  "pending", // posted, waiting for an approver
  "approved", // an approver said yes; kedb-loop is applying it
  "applied", // committed and pushed to sre-kedb
  "rejected", // an approver said no
  "expired", // nobody answered in 7 days
  "superseded", // a newer revision of the same proposal replaced it
  "stale", // main changed under it before it could be applied
  "failed", // applying failed; apply_runbook_update retries it
  "withdrawn", // the agent withdrew it, or its Slack post failed
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Statuses that still hold a slot: at most MAX_OPEN_PROPOSALS of these at once. */
export const OPEN_STATUSES: ReadonlySet<ProposalStatus> = new Set(["pending", "approved", "failed", "stale"]);

export const PROPOSAL_ID = /^KB-[1-9][0-9]{0,5}$/;
export const SLACK_TS = /^[0-9]{9,11}\.[0-9]{6}$/;
/**
 * A fingerprint that may be written into a commit trailer and a Slack post as is: no spaces,
 * no newlines, nothing to escape. alert-payload-store.ts names directories by the same rule.
 */
export const GAP_FINGERPRINT = /^[A-Za-z0-9_-]{1,128}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Terminal records older than this are dropped on load; the KB counter is never reset. */
export const PROPOSAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const Action = z.enum(ACTION_LADDER);

const Proposal = z
  .object({
    id: z.string().regex(PROPOSAL_ID),
    rev: z.number().int().min(1).max(99),
    entry_id: z.string().regex(ENTRY_ID),
    op: z.enum(["create", "update", "retire"]),
    /** Blob sha of the entry on main when proposed; null for a create. */
    base_blob_sha: z.string().regex(SHA1).nullable(),
    content: z.string().min(1),
    content_sha256: z.string().regex(SHA256),
    diff: z.string(),
    learned: z.string().min(1),
    incident_id: z.string().regex(/^[0-9]{1,9}$/),
    fingerprint: z.string().min(1).max(256),
    slack_channel: z.string().regex(/^[CDG][A-Z0-9]{2,}$/),
    thread_ts: z.string().regex(SLACK_TS),
    thread_permalink: z.string().url(),
    /** The ts and permalink of this revision's proposal message; null until it is posted. */
    post_ts: z.string().regex(SLACK_TS).nullable(),
    post_permalink: z.string().url().nullable(),
    posted_at: z.number().int().nullable(),
    downgrade: z
      .object({ from: Action.nullable(), to: Action.nullable(), scope: z.array(z.string()).min(1) })
      .strict()
      .nullable(),
    status: z.enum(PROPOSAL_STATUSES),
    status_reason: z.string().nullable(),
    approval: z
      .object({ user: z.string(), name: z.string(), ts: z.string().regex(SLACK_TS), permalink: z.string().url(), text: z.string() })
      .strict()
      .nullable(),
    /**
     * Set when the injection check (plan §5d) could not run because no raw payload was kept
     * for the fingerprint, and the proposal went ahead only because an approver asked for it in
     * its thread (kedb-loop.ts). Null when the check ran. Defaults to null for records written
     * before 0.9.1, which all ran it.
     */
    payload_gap: z
      .object({
        fingerprint: z.string().regex(GAP_FINGERPRINT),
        requested_by: z
          .object({ user: z.string(), name: z.string(), ts: z.string().regex(SLACK_TS), permalink: z.string().url() })
          .strict(),
      })
      .strict()
      .nullable()
      .default(null),
    commit_sha: z.string().regex(SHA1).nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    reminded_at: z.number().int().nullable(),
  })
  .strict();
export type Proposal = z.infer<typeof Proposal>;

const StoreFile = z
  .object({
    version: z.literal(1),
    /** The number the next new proposal gets (KB-<next_number>). Never decreases. */
    next_number: z.number().int().min(1),
    proposals: z.array(Proposal),
  })
  .strict();

export class ProposalStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

export interface ProposalStore {
  /** The newest revision of a proposal. */
  get(id: string): Proposal | undefined;
  /** The newest revision of every proposal, oldest proposal first. */
  latest(): Proposal[];
  /** Reserves the next KB-<n> id and persists the counter. */
  allocateId(): string;
  /** Inserts or replaces the record (id, rev) and persists. @throws ProposalStoreError */
  put(proposal: Proposal): void;
}

export interface ProposalStoreOptions {
  path: string;
  now?: () => number;
  log?: (line: string) => void;
}

const TERMINAL: ReadonlySet<ProposalStatus> = new Set(["applied", "rejected", "expired", "superseded", "withdrawn"]);

function key(id: string, rev: number): string {
  return `${id}#${rev}`;
}

function numberOf(id: string): number {
  return Number(id.slice(3));
}

/**
 * Loads the store at `path` (a missing file is an empty store).
 * @throws ProposalStoreError when the file exists but cannot be read or does not validate.
 */
export function createProposalStore(options: ProposalStoreOptions): ProposalStore {
  const { path, now = Date.now, log = (line) => console.error(line) } = options;
  const tempPath = `${path}.tmp`;
  const records = new Map<string, Proposal>();
  let nextNumber = 1;

  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProposalStoreError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (raw !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new ProposalStoreError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = StoreFile.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ProposalStoreError(`${path} does not validate: ${issue.path.join(".")}: ${issue.message}`);
    }
    nextNumber = parsed.data.next_number;
    const cutoff = now() - PROPOSAL_RETENTION_MS;
    let dropped = 0;
    for (const proposal of parsed.data.proposals) {
      if (numberOf(proposal.id) >= nextNumber) {
        throw new ProposalStoreError(`${path}: ${proposal.id} is not below next_number ${nextNumber}`);
      }
      if (records.has(key(proposal.id, proposal.rev))) {
        throw new ProposalStoreError(`${path}: ${proposal.id} rev ${proposal.rev} appears twice`);
      }
      if (TERMINAL.has(proposal.status) && proposal.updated_at < cutoff) {
        dropped++;
        continue;
      }
      records.set(key(proposal.id, proposal.rev), proposal);
    }
    if (dropped > 0) log(`[proposal-store] dropped ${dropped} closed proposal revision(s) older than 90 days`);
  }

  function persist(): void {
    const file: z.infer<typeof StoreFile> = { version: 1, next_number: nextNumber, proposals: [...records.values()] };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tempPath, path);
    } catch (err) {
      rmSync(tempPath, { force: true });
      throw new ProposalStoreError(`cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function newestRevisions(): Map<string, Proposal> {
    const newest = new Map<string, Proposal>();
    for (const proposal of records.values()) {
      const seen = newest.get(proposal.id);
      if (seen === undefined || seen.rev < proposal.rev) newest.set(proposal.id, proposal);
    }
    return newest;
  }

  return {
    get(id) {
      return newestRevisions().get(id);
    },

    latest() {
      return [...newestRevisions().values()].sort((a, b) => numberOf(a.id) - numberOf(b.id));
    },

    allocateId() {
      const id = `KB-${nextNumber}`;
      nextNumber++;
      try {
        persist();
      } catch (err) {
        nextNumber--;
        throw err;
      }
      return id;
    },

    put(proposal) {
      const checked = Proposal.safeParse(proposal);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        throw new ProposalStoreError(`refusing to store an invalid proposal: ${issue.path.join(".")}: ${issue.message}`);
      }
      if (numberOf(proposal.id) >= nextNumber) throw new ProposalStoreError(`${proposal.id} was never allocated`);
      const k = key(proposal.id, proposal.rev);
      const previous = records.get(k);
      records.set(k, checked.data);
      try {
        persist();
      } catch (err) {
        if (previous === undefined) records.delete(k);
        else records.set(k, previous);
        throw err;
      }
    },
  };
}
