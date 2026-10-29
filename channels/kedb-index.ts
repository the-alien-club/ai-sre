// KEDB index: matches each alert to its Known Error Database entry, deterministically, in the
// channel and not in the LLM.
//
// The entries live in the sre-kedb repository, cloned on the VM at SRE_KEDB_DIR (default
// /home/sre-agent/kedb). Each entries/<family>/<name>.md file has YAML front matter that this
// module acts on and a Markdown body the investigating sub-agent reads. sre-kedb's CI validates
// every entry against schema/entry.schema.json; this module validates again (zod) the fields
// it consumes, so an entry CI never saw cannot steer it.
//
// Match order for one alert (plan §3):
//   1. the entry named by labels.kedb_id or annotations.runbook_id, when it is a valid id of an
//      active entry. Alert data only ever selects a key of the index, never a file path;
//   2. the active signature entries whose match fully holds: most conditions first, at most 2;
//   3. the active family entry whose match holds;
//   4. none.
//
// Fail open: a missing checkout, an unreadable HEAD, a slow disk or a broken entry never
// blocks or delays an alert beyond the lookup bound. The alert goes out with kedb_match=none
// and the agent falls back to playbooks/.
//
// The index is reloaded when the checkout's HEAD sha changes (two small file reads per alert),
// and every match carries that sha as kedb_rev, so an outcome is attributable to the exact
// revision of the entry that predicted it.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { withTimeout } from "./with-timeout.js";

export const DEFAULT_KEDB_DIR = "/home/sre-agent/kedb";

/** Entries larger than this are skipped. sre-kedb ci/lint.ts MAX_ENTRY_BYTES; keep them equal. */
export const KEDB_MAX_ENTRY_BYTES = 64 * 1024;
/** More entries than this and the rest are skipped: a bound on the work one reload can do. */
export const KEDB_MAX_ENTRIES = 1000;
/** The KEDB block appended to an alert is at most this many bytes. */
export const KEDB_BLOCK_MAX_BYTES = 2048;
/** Signature entries reported per alert. */
export const KEDB_MAX_SIGNATURE_MATCHES = 2;

/** The action ladder, lowest first (sre-kedb schema). */
export const ACTION_LADDER = ["ignore", "log", "fyi", "ticket", "escalate", "page"] as const;

/** An entry id: the path under entries/ without .md (sre-kedb schema). */
export const ENTRY_ID = /^[a-z0-9][a-z0-9-]*\/(_family|[a-z0-9][a-z0-9-]*)$/;
const MAX_REGEX_CHARS = 200;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

// -- Entry schema (the fields this module consumes) ------------------------------------------

const Pattern = z.string().min(1).max(MAX_REGEX_CHARS);
const Action = z.enum(ACTION_LADDER);
const Verdict = z.enum(["real", "noise", "false_positive", "known_issue", "flapping"]);
const SignatureValue = z.union([Pattern, z.number(), z.array(z.union([z.string().min(1).max(MAX_REGEX_CHARS), z.number()])).min(1).max(10)]);

export const EntryFrontMatter = z
  .object({
    id: z.string().regex(ENTRY_ID),
    kind: z.enum(["family", "signature"]),
    family: z.string().regex(ENTRY_ID).optional(),
    status: z.enum(["draft", "active", "retired"]),
    security: z.boolean(),
    match: z
      .object({
        alertname: z.array(Pattern).min(1).max(20).optional(),
        labels: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]*$/), Pattern).optional(),
        text: z.array(z.string().min(3).max(200)).min(1).max(10).optional(),
      })
      .strict(),
    default: z.object({ verdict: Verdict, action: Action }).strict().optional(),
    benign_causes: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            signature: z.record(z.string(), SignatureValue),
            corroboration: z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), runner: z.enum(["agent", "operator"]) }).passthrough()).min(1),
            verdict_if_verified: z.enum(["noise", "false_positive", "known_issue"]),
            action_if_verified: Action,
            action_if_signature_only: Action,
          })
          .passthrough()
      )
      .max(10)
      .optional(),
    false_trails: z.array(z.string().min(1).max(400)).max(20).optional(),
  })
  // Fields the index does not act on (evidence, related_changes, ...) are sre-kedb CI's to check.
  .passthrough();

export type EntryFrontMatter = z.infer<typeof EntryFrontMatter>;

/** A value test: exact string, number, /regex/, or any of a list of those. */
type Matcher = (value: string) => boolean;

export interface BenignCause {
  id: string;
  /** Signature field → matcher, in entry order. */
  signature: Array<{ field: string; test: Matcher }>;
  corroboration: Array<{ id: string; runner: "agent" | "operator" }>;
}

export interface KedbEntry {
  id: string;
  kind: "family" | "signature";
  family: string | undefined;
  security: boolean;
  /** Absolute path of the entry file, for the sub-agent to read. */
  path: string;
  /** Conditions of match; all must hold. Empty means the entry never matches an alert. */
  conditions: Array<(alert: KedbAlert) => boolean>;
  default: { verdict: z.infer<typeof Verdict>; action: z.infer<typeof Action> } | undefined;
  benignCauses: BenignCause[];
  falseTrails: string[];
}

export interface KedbIndex {
  rev: string;
  /** Active entries by id. */
  entries: Map<string, KedbEntry>;
  /** Entries left out: invalid, oversized, not active, or beyond KEDB_MAX_ENTRIES. */
  skipped: number;
}

/** What the index needs from an Alertmanager alert. */
export interface KedbAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface SignatureHint {
  causeId: string;
  matched: number;
  total: number;
  /** Signature fields the alert does not carry at all (read them from the source log). */
  absent: string[];
}

export type KedbMatch =
  | { kind: "exact"; rev: string; entry: KedbEntry; also: KedbEntry[]; hints: SignatureHint[] }
  | { kind: "family"; rev: string; entry: KedbEntry }
  | { kind: "none"; rev: string }
  | { kind: "unavailable"; reason: string };

export class KedbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KedbUnavailableError";
  }
}

// -- Patterns -------------------------------------------------------------------------------

function isRegexLiteral(value: string): boolean {
  return value.length >= 2 && value.startsWith("/") && value.endsWith("/");
}

/**
 * Why a "/x/" pattern is not an acceptable regex (empty, nested quantifiers, a backreference,
 * or it does not compile), or null when it is, or when the pattern is an exact string.
 */
export function regexProblem(pattern: string): string | null {
  if (!isRegexLiteral(pattern)) return null;
  const source = pattern.slice(1, -1);
  if (source.length === 0 || NESTED_QUANTIFIER.test(source) || /\\[1-9]/.test(source)) {
    return `regex ${pattern} is empty, nests quantifiers or uses a backreference`;
  }
  try {
    new RegExp(source);
  } catch (err) {
    return `regex ${pattern} does not compile: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

/** Compiles "/x/" to a regex test and anything else to an equality test. Throws on a bad regex. */
function compilePattern(pattern: string): Matcher {
  if (!isRegexLiteral(pattern)) return (value) => value === pattern;
  const problem = regexProblem(pattern);
  if (problem !== null) throw new Error(problem);
  const regex = new RegExp(pattern.slice(1, -1));
  return (value) => regex.test(value);
}

function compileSignatureValue(value: z.infer<typeof SignatureValue>): Matcher {
  const items = Array.isArray(value) ? value : [value];
  const tests = items.map((item) => (typeof item === "number" ? (v: string) => v === String(item) : compilePattern(item)));
  return (v) => tests.some((t) => t(v));
}

function alertText(alert: KedbAlert): string {
  return `${alert.annotations.summary ?? ""}\n${alert.annotations.description ?? ""}`;
}

function compileEntry(fm: EntryFrontMatter, path: string): KedbEntry {
  const conditions: KedbEntry["conditions"] = [];
  if (fm.match.alertname) {
    const tests = fm.match.alertname.map(compilePattern);
    conditions.push((alert) => alert.labels.alertname !== undefined && tests.some((t) => t(alert.labels.alertname)));
  }
  for (const [label, pattern] of Object.entries(fm.match.labels ?? {})) {
    const t = compilePattern(pattern);
    conditions.push((alert) => Object.hasOwn(alert.labels, label) && t(alert.labels[label]));
  }
  for (const literal of fm.match.text ?? []) {
    conditions.push((alert) => alertText(alert).includes(literal));
  }

  return {
    id: fm.id,
    kind: fm.kind,
    family: fm.family,
    security: fm.security,
    path,
    conditions,
    default: fm.default,
    benignCauses: (fm.benign_causes ?? []).map((cause) => ({
      id: cause.id,
      signature: Object.entries(cause.signature).map(([field, value]) => ({ field, test: compileSignatureValue(value) })),
      corroboration: cause.corroboration.map((step) => ({ id: step.id, runner: step.runner })),
    })),
    falseTrails: fm.false_trails ?? [],
  };
}

// -- Loading --------------------------------------------------------------------------------

/** Splits "---\n<yaml>\n---\n<body>" and parses the YAML. Throws with a reason. */
export function parseFrontMatter(text: string): unknown {
  if (!text.startsWith("---\n")) throw new Error("no front matter");
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) throw new Error("front matter not closed");
  const doc = parseDocument(text.slice(4, end + 1), { uniqueKeys: true, strict: true, prettyErrors: false });
  if (doc.errors.length > 0) throw new Error(`invalid YAML: ${doc.errors[0].message}`);
  return doc.toJS();
}

/**
 * The sha HEAD points at, from the files git keeps under .git: a detached sha, a loose ref, or
 * a line of packed-refs. Throws KedbUnavailableError when the directory is not a checkout.
 */
export async function readGitRev(dir: string): Promise<string> {
  const gitDir = join(dir, ".git");
  let head: string;
  try {
    head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
  } catch (err) {
    throw new KedbUnavailableError(`${dir} is not a git checkout (${(err as NodeJS.ErrnoException).code ?? "unreadable .git/HEAD"})`);
  }
  if (/^[0-9a-f]{40}$/.test(head)) return head;

  const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
  if (ref === undefined || ref.includes("..")) throw new KedbUnavailableError(`unexpected .git/HEAD in ${dir}`);

  try {
    const sha = (await readFile(join(gitDir, ref), "utf8")).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new KedbUnavailableError(`cannot read ${ref} in ${dir}`);
  }

  let packed: string;
  try {
    packed = await readFile(join(gitDir, "packed-refs"), "utf8");
  } catch {
    throw new KedbUnavailableError(`${ref} not found in ${dir}`);
  }
  for (const line of packed.split("\n")) {
    const [sha, name] = line.split(" ");
    if (name === ref && /^[0-9a-f]{40}$/.test(sha)) return sha;
  }
  throw new KedbUnavailableError(`${ref} not found in ${dir}`);
}

/**
 * Loads every active entry under <dir>/entries. Invalid entries are skipped and reported to
 * `log`, never fatal: one bad file must not cost the alert stream the other entries. A missing
 * entries/ directory is KedbUnavailableError.
 */
export async function loadKedbIndex(dir: string, rev: string, log: (line: string) => void): Promise<KedbIndex> {
  const entriesDir = join(dir, "entries");
  let families: string[];
  try {
    families = (await readdir(entriesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    throw new KedbUnavailableError(`cannot read ${entriesDir} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }

  const entries = new Map<string, KedbEntry>();
  let skipped = 0;
  let seen = 0;
  const skip = (file: string, reason: string) => {
    skipped++;
    log(`[kedb] skipped ${file}: ${reason}`);
  };

  for (const family of families) {
    let names: string[];
    try {
      names = (await readdir(join(entriesDir, family), { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => d.name).sort();
    } catch (err) {
      skip(`entries/${family}/`, `cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      continue;
    }
    for (const name of names) {
      const file = `entries/${family}/${name}`;
      const path = join(entriesDir, family, name);
      if (++seen > KEDB_MAX_ENTRIES) {
        skip(file, `more than ${KEDB_MAX_ENTRIES} entries`);
        continue;
      }
      let fm: EntryFrontMatter;
      try {
        if ((await stat(path)).size > KEDB_MAX_ENTRY_BYTES) {
          skip(file, `larger than ${KEDB_MAX_ENTRY_BYTES} bytes`);
          continue;
        }
        const parsed = EntryFrontMatter.safeParse(parseFrontMatter(await readFile(path, "utf8")));
        if (!parsed.success) {
          skip(file, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
          continue;
        }
        fm = parsed.data;
      } catch (err) {
        skip(file, err instanceof Error ? err.message : String(err));
        continue;
      }

      const expectedId = `${family}/${name.slice(0, -3)}`;
      if (fm.id !== expectedId) {
        skip(file, `id '${fm.id}' is not its path '${expectedId}'`);
        continue;
      }
      if ((fm.kind === "family") !== expectedId.endsWith("/_family")) {
        skip(file, "kind does not match the file name");
        continue;
      }
      if (fm.status !== "active") {
        skipped++;
        continue;
      }

      try {
        entries.set(fm.id, compileEntry(fm, path));
      } catch (err) {
        skip(file, err instanceof Error ? err.message : String(err));
      }
    }
  }

  return { rev, entries, skipped };
}

// -- Matching -------------------------------------------------------------------------------

function holds(entry: KedbEntry, alert: KedbAlert): boolean {
  return entry.conditions.length > 0 && entry.conditions.every((condition) => condition(alert));
}

function hintsFor(entry: KedbEntry, alert: KedbAlert): SignatureHint[] {
  return entry.benignCauses.map((cause) => {
    const absent = cause.signature.filter(({ field }) => !Object.hasOwn(alert.labels, field)).map(({ field }) => field);
    const matched = cause.signature.filter(({ field, test }) => Object.hasOwn(alert.labels, field) && test(alert.labels[field])).length;
    return { causeId: cause.id, matched, total: cause.signature.length, absent };
  });
}

function byId(a: KedbEntry, b: KedbEntry): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The entry an alert names itself (kedb_id label, runbook_id annotation), if it is a real one. */
function namedEntry(index: KedbIndex, alert: KedbAlert): KedbEntry | undefined {
  for (const named of [alert.labels.kedb_id, alert.annotations.runbook_id]) {
    if (named !== undefined && ENTRY_ID.test(named)) {
      const entry = index.entries.get(named);
      if (entry) return entry;
    }
  }
  return undefined;
}

export function matchAlert(index: KedbIndex, alert: KedbAlert): KedbMatch {
  const rev = index.rev;
  const named = namedEntry(index, alert);
  if (named?.kind === "signature") return { kind: "exact", rev, entry: named, also: [], hints: hintsFor(named, alert) };
  if (named?.kind === "family") return { kind: "family", rev, entry: named };

  const entries = [...index.entries.values()];
  const signatures = entries
    .filter((entry) => entry.kind === "signature" && holds(entry, alert))
    .sort((a, b) => b.conditions.length - a.conditions.length || byId(a, b))
    .slice(0, KEDB_MAX_SIGNATURE_MATCHES);
  if (signatures.length > 0) {
    const [entry, ...also] = signatures;
    return { kind: "exact", rev, entry, also, hints: hintsFor(entry, alert) };
  }

  const family = entries.filter((entry) => entry.kind === "family" && holds(entry, alert)).sort((a, b) => b.conditions.length - a.conditions.length || byId(a, b))[0];
  if (family) return { kind: "family", rev, entry: family };

  return { kind: "none", rev };
}

// -- What the session sees ------------------------------------------------------------------

const SHORT_REV = 7;

/** Channel meta for the match (underscored keys only: Claude Code drops hyphenated ones). */
export function kedbMeta(match: KedbMatch): Record<string, string> {
  if (match.kind === "unavailable") return { kedb_match: "none" };
  const meta: Record<string, string> = { kedb_match: match.kind, kedb_rev: match.rev.slice(0, SHORT_REV) };
  if (match.kind === "none") return meta;

  meta.kedb_id = match.entry.id;
  if (match.entry.default) {
    meta.kedb_predicted_verdict = match.entry.default.verdict;
    meta.kedb_predicted_action = match.entry.default.action;
  }
  if (match.kind === "exact") {
    const full = match.hints.filter((hint) => hint.total > 0 && hint.matched === hint.total).map((hint) => hint.causeId);
    if (full.length > 0) meta.kedb_hint = full.join(",");
  }
  return meta;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The block appended after the alert payload: what the entry predicts and where to read it.
 * At most KEDB_BLOCK_MAX_BYTES; optional lines are dropped, lowest priority first, to fit.
 */
export function formatKedbBlock(match: KedbMatch): string {
  if (match.kind === "unavailable") {
    return `--- KEDB unavailable (${clip(match.reason, 200)}); use playbooks/ and the CLAUDE.md mapping ---`;
  }
  const rev = match.rev.slice(0, SHORT_REV);
  if (match.kind === "none") {
    return `--- KEDB (rev ${rev}): no entry matches this alert; use playbooks/ and the CLAUDE.md mapping ---`;
  }

  const entry = match.entry;
  const header = `--- KEDB (trusted, Leo-approved, rev ${rev}) ---`;
  const footer = "--- end KEDB ---";
  const required = [
    match.kind === "exact" ? `Entry: ${entry.id} (signature in ${entry.family ?? "?"})` : `Entry: ${entry.id} (family; no signature entry matched)`,
    `Full entry: ${entry.path}`,
  ];
  const optional: string[] = [];

  if (entry.default) optional.push(`Default: ${entry.default.verdict} → ${entry.default.action}.${entry.security ? " Security entry: never below fyi, never auto-fixed." : ""}`);
  if (match.kind === "exact") {
    for (const hint of match.hints) {
      const absent = hint.absent.length > 0 ? `; not in the alert, read from the source log: ${hint.absent.join(", ")}` : "";
      optional.push(`Signature hint: ${hint.causeId} (${hint.matched}/${hint.total} fields match the alert${absent}). A hint, never proof.`);
    }
    for (const cause of entry.benignCauses) {
      optional.push(`Verify before downgrading (${cause.id}): ${cause.corroboration.map((step) => `${step.id} (${step.runner}-run)`).join(", ")}.`);
    }
    if (entry.family) optional.push(`Family entry: ${entry.path.replace(/[^/]+\.md$/, "_family.md")}`);
    for (const other of match.also) optional.push(`Also matched: ${other.id} (${other.path})`);
    for (const trail of entry.falseTrails) optional.push(`False trail: ${clip(trail, 240)}`);
  }

  const lines = [header, required[0]];
  let size = bytes([header, ...required, footer].join("\n")) + 1;
  const kept: string[] = [];
  for (const line of optional) {
    if (size + bytes(line) + 1 > KEDB_BLOCK_MAX_BYTES) continue;
    kept.push(line);
    size += bytes(line) + 1;
  }
  return [...lines, ...kept, required[1], footer].join("\n");
}

// -- The lookup the channel calls -----------------------------------------------------------

export interface KedbLookupOptions {
  dir: string;
  /** Bound on one lookup, reload included (CLAUDE_ERROR_PATTERNS.md §14). */
  timeoutMs: number;
  log?: (line: string) => void;
  /** Injectable for tests. */
  readRev?: (dir: string) => Promise<string>;
  load?: (dir: string, rev: string, log: (line: string) => void) => Promise<KedbIndex>;
}

export interface KedbLookup {
  /** Never rejects: every failure is an "unavailable" match, so an alert is never held back. */
  lookup(alert: KedbAlert): Promise<KedbMatch>;
}

export function createKedbLookup(options: KedbLookupOptions): KedbLookup {
  const { dir, timeoutMs, log = (line) => console.error(line), readRev = readGitRev, load = loadKedbIndex } = options;
  let current: KedbIndex | undefined;
  let loading: { rev: string; promise: Promise<KedbIndex> } | undefined;
  let lastState = "";

  // Logs state changes only, so a missing checkout is one line, not one per alert.
  const report = (state: string, line: string) => {
    if (state === lastState) return;
    lastState = state;
    log(line);
  };

  async function indexAt(rev: string): Promise<KedbIndex> {
    if (current?.rev === rev) return current;
    if (loading?.rev === rev) return loading.promise;

    const promise = load(dir, rev, log).then((index) => {
      current = index;
      report(`loaded:${rev}`, `[kedb] loaded ${index.entries.size} active entries at ${rev.slice(0, SHORT_REV)} from ${dir} (${index.skipped} skipped)`);
      return index;
    });
    const settled = () => {
      if (loading?.promise === promise) loading = undefined;
    };
    promise.then(settled, settled);
    loading = { rev, promise };
    return promise;
  }

  return {
    async lookup(alert) {
      try {
        const index = await withTimeout(readRev(dir).then(indexAt), timeoutMs, "KEDB lookup");
        return matchAlert(index, alert);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        report(`unavailable:${reason}`, `[kedb] unavailable, alerts go out without a KEDB match: ${reason}`);
        return { kind: "unavailable", reason };
      }
    },
  };
}
