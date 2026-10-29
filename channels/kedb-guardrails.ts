// Guardrails on a proposed KEDB entry (plan §5b, §5c, §5d), checked in code before the
// proposal is ever posted for approval.
//
// They complement sre-kedb's own lint (ci/lint.ts), which kedb-loop also runs on the
// candidate: the lint checks one entry against the schema and the repository; these check a
// change against what it replaces, against what the agent is allowed to automate, and against
// the alert that prompted it. Every check fails closed: when it cannot decide, the proposal is
// refused with the reason.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { fingerprintDir } from "./alert-payload-store.js";
import { ACTION_LADDER, EntryFrontMatter, parseFrontMatter, regexProblem } from "./kedb-index.js";
import { withTimeout } from "./with-timeout.js";

type Action = (typeof ACTION_LADDER)[number];

function rank(action: Action): number {
  return ACTION_LADDER.indexOf(action);
}

function lowest(actions: Action[]): Action | null {
  if (actions.length === 0) return null;
  return actions.reduce((a, b) => (rank(b) < rank(a) ? b : a));
}

// -- Parsing a candidate --------------------------------------------------------------------

export interface CandidateEntry {
  fm: EntryFrontMatter;
  body: string;
}

/** Parses and validates a whole entry file. Throws with the reason. */
export function parseCandidate(content: string): CandidateEntry {
  const parsed = EntryFrontMatter.safeParse(parseFrontMatter(content));
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const end = content.indexOf("\n---\n", 3);
  return { fm: parsed.data, body: content.slice(end + 5) };
}

// -- Whole-text rules (5b, 5d) ---------------------------------------------------------------

/**
 * claude-sre CLAUDE.md's FORBIDDEN list, as sre-kedb ci/lint.ts FORBIDDEN_COMMANDS has it;
 * keep the two equal. No entry may contain one anywhere, not even as an example.
 */
export const FORBIDDEN_COMMANDS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "kubectl delete application/namespace/pvc/secret", pattern: /kubectl\s+(?:[^\n`]*\s)?delete\s+(?:applications?|apps?|namespaces?|ns|pvc|persistentvolumeclaims?|secrets?)\b/i },
  { name: "helm uninstall", pattern: /helm\s+(?:uninstall|delete)\b/i },
  { name: "scale to zero replicas", pattern: /\bscale\b[^\n]*--replicas[= ]0\b/i },
  { name: "git push / git commit", pattern: /\bgit\s+(?:push\b|commit\s+-)/i },
  { name: "SQL DROP/TRUNCATE/DELETE", pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+(?:TABLE\s+)?[a-z_]|DELETE\s+FROM)\b/i },
  { name: "kubectl apply/create", pattern: /kubectl\s+(?:[^\n`]*\s)?(?:apply|create)\s+-/i },
  { name: "destructive kubectl exec", pattern: /kubectl\s+(?:[^\n`]*\s)?exec\b[^\n]*\s(?:rm|kill|pkill)\s/i },
];

/** Text that pings people or reads differently than it is (sre-kedb ci/lint.ts HIDDEN_TEXT). */
export const HIDDEN_TEXT: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "a Slack mention (<@ or <!)", pattern: /<[@!]/ },
  { name: "an HTML comment", pattern: /<!--/ },
  { name: "a zero-width or bidirectional control character", pattern: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/ },
];

/** Markers that make GitLab skip the pipeline, and with it verify-approvals (plan §5e). */
const SKIP_CI = /\[(?:skip[ -]ci|ci[ -]skip|no[ -]ci|skip[ -]pipeline|pipeline[ -]skip)\]|skip-checks\s*:/i;

export function textProblems(text: string, what: string): string[] {
  const problems: string[] = [];
  for (const { name, pattern } of FORBIDDEN_COMMANDS) {
    const hit = pattern.exec(text);
    if (hit) problems.push(`${what} contains a FORBIDDEN command (${name}): '${hit[0]}'`);
  }
  for (const { name, pattern } of HIDDEN_TEXT) {
    if (pattern.test(text)) problems.push(`${what} contains ${name}`);
  }
  if (SKIP_CI.test(text)) problems.push(`${what} contains a CI-skip marker`);
  return problems;
}

/** The agent's "what I learned": posted to Slack and written into the commit message. */
export function learnedProblems(learned: string): string[] {
  const problems = textProblems(learned, "learned");
  if (learned.trim().length === 0) problems.push("learned is empty");
  if (learned.length > 600) problems.push("learned is longer than 600 characters (1-3 sentences)");
  if (/[\r\n]/.test(learned)) problems.push("learned must be one paragraph, without line breaks");
  return problems;
}

// -- Machine fields (5b) -------------------------------------------------------------------

/** A shell command where only a matcher belongs. Matchers are never run, but they are read. */
const COMMAND_LIKE = /[`\n]|\$\(|&&|^\s*(?:kubectl|helm|sudo|bash\s+-c|sh\s+-c|curl|wget|rm|git|ssh|scp|psql)\s/i;

function machineStrings(fm: EntryFrontMatter): Array<{ where: string; value: string }> {
  const found: Array<{ where: string; value: string }> = [];
  for (const value of fm.match.alertname ?? []) found.push({ where: "match.alertname", value });
  for (const [label, value] of Object.entries(fm.match.labels ?? {})) found.push({ where: `match.labels.${label}`, value });
  for (const value of fm.match.text ?? []) found.push({ where: "match.text", value });
  for (const cause of fm.benign_causes ?? []) {
    for (const [field, value] of Object.entries(cause.signature)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (typeof item === "string") found.push({ where: `benign_causes.${cause.id}.signature.${field}`, value: item });
      }
    }
  }
  return found;
}

export function machineFieldProblems(fm: EntryFrontMatter): string[] {
  const problems: string[] = [];
  for (const { where, value } of machineStrings(fm)) {
    if (COMMAND_LIKE.test(value)) problems.push(`${where} holds a command, not a matcher: ${JSON.stringify(value.slice(0, 80))}`);
    const problem = regexProblem(value);
    if (problem !== null && where !== "match.text") problems.push(`${where}: ${problem}`);
  }
  return problems;
}

// -- auto_fix against sentinel's allowlist (5b) -------------------------------------------

const AutoFix = z.object({ sentinel_action: z.string().regex(/^[a-z0-9_]+$/), target: z.string().min(1).max(200) }).strict();

/** Sentinel action id → the target ids (`<context>/<namespace>/<name>`) it may touch. */
export type SentinelAllowlist = Map<string, Set<string>>;

const ARGOCD_NAMESPACE = "argocd";

const ActionsYaml = z.object({
  targets: z.record(z.array(z.object({ context: z.string(), namespace: z.string().optional(), name: z.string() }).passthrough())),
  actions: z.array(z.object({ id: z.string(), target: z.string() }).passthrough()),
});

/**
 * Reads sentinel's catalog/actions.yaml from a read-only clone. A target id is
 * `<context>/<namespace>/<name>`, sentinel's Target.id; ArgoCD applications sit in `argocd`.
 * @throws when the clone or the file is missing or does not parse: the caller fails closed.
 */
export async function loadSentinelAllowlist(sentinelDir: string, timeoutMs: number): Promise<SentinelAllowlist> {
  const path = join(sentinelDir, "catalog", "actions.yaml");
  const text = await withTimeout(readFile(path, "utf8"), timeoutMs, `reading ${path}`);
  const parsed = ActionsYaml.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`${path} does not have the expected shape: ${parsed.error.issues[0].message}`);
  const allowlist: SentinelAllowlist = new Map();
  for (const action of parsed.data.actions) {
    const targets = parsed.data.targets[action.target];
    if (targets === undefined) throw new Error(`${path}: action ${action.id} names unknown target kind ${action.target}`);
    allowlist.set(action.id, new Set(targets.map((t) => `${t.context}/${t.namespace ?? ARGOCD_NAMESPACE}/${t.name}`)));
  }
  return allowlist;
}

/**
 * `allowlist` is what loadSentinelAllowlist returned, or the error it threw: needed only when
 * the entry has an auto_fix, and then its absence refuses the proposal.
 */
export function autoFixProblems(fm: EntryFrontMatter, allowlist: SentinelAllowlist | Error): string[] {
  const raw = (fm as Record<string, unknown>).auto_fix;
  if (raw === undefined || raw === null) return [];
  if (fm.security) return ["a security entry may never have an auto_fix"];
  const parsed = AutoFix.safeParse(raw);
  if (!parsed.success) return [`auto_fix must be null or { sentinel_action, target }: ${parsed.error.issues[0].message}`];
  if (allowlist instanceof Error) return [`auto_fix cannot be checked against sentinel's allowlist: ${allowlist.message}`];
  const targets = allowlist.get(parsed.data.sentinel_action);
  if (targets === undefined) return [`auto_fix.sentinel_action '${parsed.data.sentinel_action}' is not in sentinel catalog/actions.yaml`];
  if (!targets.has(parsed.data.target)) {
    return [`auto_fix.target '${parsed.data.target}' is not a target of ${parsed.data.sentinel_action} (expected <context>/<namespace>/<name>)`];
  }
  return [];
}

// -- Security floors (5c) ------------------------------------------------------------------

/** A corroboration check that only re-reads the alert is no corroboration: the alert is untrusted. */
const READS_THE_ALERT = /\b(?:alert|payload|output[_ ]fields?|labels?|annotations?)\b/i;

export function securityProblems(fm: EntryFrontMatter): string[] {
  if (!fm.security) return [];
  const problems: string[] = [];
  if (fm.default !== undefined && rank(fm.default.action) < rank("fyi")) {
    problems.push(`security entry: default.action '${fm.default.action}' is below the fyi floor`);
  }
  for (const cause of fm.benign_causes ?? []) {
    for (const field of ["action_if_verified", "action_if_signature_only"] as const) {
      if (rank(cause[field]) < rank("fyi")) problems.push(`security entry: ${cause.id}.${field} '${cause[field]}' is below the fyi floor`);
    }
    const independent = cause.corroboration.filter((step) => {
      const check = (step as Record<string, unknown>).check;
      return typeof check === "string" && !READS_THE_ALERT.test(check);
    });
    if (independent.length === 0) {
      problems.push(`security entry: benign cause ${cause.id} needs at least one corroboration check that does not read the alert itself`);
    }
  }
  return problems;
}

// -- Severity downgrades (5c) --------------------------------------------------------------

export interface Downgrade {
  /** The lowest action the alerts could get before, and after; null when no entry predicted any. */
  from: Action | null;
  to: Action | null;
  /** Why it is a downgrade, one reason per item. */
  scope: string[];
}

interface Prediction {
  default: { verdict: string; action: Action } | undefined;
  causes: Map<string, NonNullable<EntryFrontMatter["benign_causes"]>[number]>;
  match: EntryFrontMatter["match"] | undefined;
  security: boolean;
}

/** What an entry predicts for its alerts; a retired or draft entry leaves them to the family. */
function prediction(fm: EntryFrontMatter | null, family: EntryFrontMatter | null): Prediction {
  if (fm !== null && fm.status === "active") {
    return { default: fm.default, causes: new Map((fm.benign_causes ?? []).map((c) => [c.id, c])), match: fm.match, security: fm.security };
  }
  return { default: family?.default, causes: new Map(), match: undefined, security: family?.security ?? false };
}

function reachable(p: Prediction): Action[] {
  const actions: Action[] = p.default ? [p.default.action] : [];
  for (const cause of p.causes.values()) actions.push(cause.action_if_verified, cause.action_if_signature_only);
  return actions;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether `after` lowers the severity its alerts get compared with `before` (null for a new
 * entry). `family` is the family entry, which predicts for the alerts when the entry does not
 * exist or is not active. Detected structurally (plan §5c): a lower action anywhere, a new
 * benign cause, a widened or changed signature, a removed or changed corroboration step, a
 * verdict moving away from real, a dropped security flag, or a changed match on an entry that
 * predicts below its family.
 */
export function detectDowngrade(before: EntryFrontMatter | null, after: EntryFrontMatter, family: EntryFrontMatter | null): Downgrade | null {
  const was = prediction(before, family);
  const now = prediction(after, family);
  const scope: string[] = [];

  if (was.default && now.default && rank(now.default.action) < rank(was.default.action)) {
    scope.push(`default action ${was.default.action} → ${now.default.action}`);
  }
  if (was.default && !now.default) scope.push("the default prediction is removed");
  if (was.default && now.default && was.default.verdict !== now.default.verdict && now.default.verdict !== "real") {
    scope.push(`default verdict ${was.default.verdict} → ${now.default.verdict}`);
  }
  if (was.security && !now.security) scope.push("the security flag is removed");

  for (const [id, cause] of now.causes) {
    const old = was.causes.get(id);
    if (old === undefined) {
      scope.push(`new benign cause ${id}`);
      continue;
    }
    for (const field of ["action_if_verified", "action_if_signature_only"] as const) {
      if (rank(cause[field]) < rank(old[field])) scope.push(`${id}.${field} ${old[field]} → ${cause[field]}`);
    }
    if (cause.verdict_if_verified !== old.verdict_if_verified) scope.push(`${id}.verdict_if_verified ${old.verdict_if_verified} → ${cause.verdict_if_verified}`);
    for (const [field, value] of Object.entries(old.signature)) {
      if (!Object.hasOwn(cause.signature, field)) scope.push(`${id}.signature drops ${field} (wider)`);
      else if (!same(cause.signature[field], value)) scope.push(`${id}.signature.${field} changed (may be wider)`);
    }
    const steps = new Map(cause.corroboration.map((step) => [step.id, step]));
    for (const step of old.corroboration) {
      const kept = steps.get(step.id);
      if (kept === undefined) scope.push(`${id} drops corroboration step ${step.id}`);
      else if (!same(kept, step)) scope.push(`${id} changes corroboration step ${step.id}`);
    }
  }

  // A wider match hands more alerts to this entry's prediction; that matters only when the
  // entry predicts below its family.
  const familyAction = family?.default?.action;
  const nowLowest = lowest(reachable(now));
  const belowFamily = nowLowest !== null && (familyAction === undefined || rank(nowLowest) < rank(familyAction));
  if (before !== null && was.match !== undefined && now.match !== undefined && !same(was.match, now.match) && belowFamily) {
    scope.push("match changed on an entry that predicts below its family (may match more alerts)");
  }

  if (scope.length === 0) return null;
  return { from: lowest(reachable(was)), to: nowLowest, scope };
}

// -- Injection (5d) -------------------------------------------------------------------------

export interface AddedLine {
  /** 1-based line number in the new file. */
  line: number;
  text: string;
}

/** The lines a unified diff adds, with their line numbers in the new file. */
export function addedLines(diff: string): AddedLine[] {
  const added: AddedLine[] = [];
  let next = 0;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) added.push({ line: next++, text: raw.slice(1) });
    else if (raw.startsWith(" ")) next++;
  }
  return added;
}

/** 1-based line numbers of `content` inside ```evidence (or ~~~evidence) fences, fences included. */
export function evidenceLines(content: string): Set<number> {
  const inside = new Set<number>();
  let fence: string | null = null;
  content.split("\n").forEach((text, index) => {
    const line = index + 1;
    if (fence === null) {
      const open = /^\s*(`{3,}|~{3,})\s*evidence\s*$/.exec(text);
      if (open) {
        fence = open[1];
        inside.add(line);
      }
      return;
    }
    inside.add(line);
    if (text.trim() === fence) fence = null;
  });
  return inside;
}

/** Where a URL in an added line may point. */
export interface UrlPolicy {
  /** The SigNoz host (from SIGNOZ_URL); undefined allows none. */
  signozHost: string | undefined;
}

const URL = /https?:\/\/[^\s<>()[\]"'`|]+/gi;

export function urlAllowed(raw: string, policy: UrlPolicy): boolean {
  let url: URL;
  try {
    url = new globalThis.URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  if (host === "gitlab.com") return url.pathname.startsWith("/alias3/");
  if (host === "alien.club" || host.endsWith(".alien.club")) return true;
  if (/^[a-z0-9-]+\.slack\.com$/.test(host)) return url.pathname.startsWith("/archives/");
  return policy.signozHost !== undefined && host === policy.signozHost.toLowerCase();
}

/** Characters of alert text a proposal may not copy verbatim (outside evidence fences). */
export const VERBATIM_LIMIT = 40;

function squash(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Plan §5d: text added by the proposal may not copy VERBATIM_LIMIT+ characters of the
 * incident's raw payload outside an evidence fence, and may link only to allowed hosts.
 */
export function injectionProblems(added: AddedLine[], evidence: Set<number>, payloadStrings: string[], policy: UrlPolicy): string[] {
  const problems: string[] = [];
  const prose = added.filter((a) => !evidence.has(a.line));

  for (const { line, text } of added) {
    for (const match of text.matchAll(URL)) {
      if (!urlAllowed(match[0], policy)) problems.push(`line ${line} links outside gitlab.com/alias3, *.alien.club, Slack archives and SigNoz: ${match[0].slice(0, 120)}`);
    }
  }

  const windows = new Set<string>();
  const proseText = squash(prose.map((a) => a.text).join("\n"));
  for (let i = 0; i + VERBATIM_LIMIT <= proseText.length; i++) windows.add(proseText.slice(i, i + VERBATIM_LIMIT));
  if (windows.size > 0) {
    for (const value of payloadStrings) {
      const flat = squash(value);
      for (let i = 0; i + VERBATIM_LIMIT <= flat.length; i++) {
        const window = flat.slice(i, i + VERBATIM_LIMIT);
        if (windows.has(window)) {
          problems.push(
            `the change copies ${VERBATIM_LIMIT}+ characters of the alert payload verbatim outside an \`\`\`evidence fence: ${JSON.stringify(window)}`
          );
          return problems;
        }
      }
    }
  }
  return problems;
}

function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      collectStrings(v, into);
    }
  }
}

/**
 * No raw payload is kept for the fingerprint: expired after 7 days, or older than the store
 * itself (0.8.0). Distinct from a failure to read one, which is always a refusal: kedb-loop
 * lets an approver's explicit request through this one case, and only this one.
 */
export class NoRetainedPayloadError extends Error {
  constructor(readonly fingerprint: string) {
    super(`no raw payload is kept for fingerprint ${fingerprint} (kept 7 days), so the injection check cannot run`);
    this.name = "NoRetainedPayloadError";
  }
}

/**
 * Every string in the payloads signoz-webhook kept for `fingerprint` (alert-payload-store.ts).
 * @throws NoRetainedPayloadError when none is kept: the check cannot run (fail closed).
 * @throws on any other read failure.
 */
export async function retainedPayloadStrings(payloadDir: string, fingerprint: string, timeoutMs: number): Promise<string[]> {
  const dir = join(payloadDir, fingerprintDir(fingerprint));
  const read = async (): Promise<string[]> => {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") names = [];
      else throw err;
    }
    if (names.length === 0) {
      throw new NoRetainedPayloadError(fingerprint);
    }
    const strings: string[] = [];
    for (const name of names) {
      const record: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      collectStrings(typeof record === "object" && record !== null ? (record as { alert?: unknown }).alert : undefined, strings);
    }
    return strings;
  };
  return withTimeout(read(), timeoutMs, "reading the retained alert payloads");
}
