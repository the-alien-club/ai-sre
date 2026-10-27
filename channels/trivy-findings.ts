// Trivy findings bookkeeping.
//
// A CVE backlog is not a page. On 2026-10-26/27 every scanned image became its own critical
// escalation (263 incidents in 14 hours, 16 Slack threads nagged 8-12 times with mentions),
// and the operator rescans every image daily. So VulnerabilityReports are only recorded
// here; trivy-webhook.ts turns them into one daily digest and one Jira ticket per image.
// Exposed secrets are remembered so that each is escalated exactly once.
//
// Everything here is pure state manipulation, plus the file store at the bottom. On disk
// because the VM restarts the agent nightly (`0 3 * * * pm2 restart sre-agent`), and losing
// this state would re-announce every image as new and re-page every known secret.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

/** A fixable HIGH/CRITICAL CVE: the ones worth a ticket line. */
export interface CveFinding {
  id: string;
  severity: Severity;
  resource: string;
  installedVersion: string;
  fixedVersion: string;
}

export interface ImageFinding {
  repository: string; // without tag: one Jira ticket per repository
  tag: string;
  digest: string | null;
  ownImage: boolean;
  namespaces: string[];
  workloads: string[];
  counts: SeverityCounts; // every unique CVE, fixable or not
  actionable: CveFinding[]; // fixable HIGH/CRITICAL, worst first
  firstSeenAt: number;
  lastSeenAt: number;
  digestedCveKeys: string[] | null; // actionable keys shown in the last digest; null = never shown
}

export interface JiraTicket {
  issueKey: string;
  cveKeys: string[];
}

export interface SecretSighting {
  reportedAt: number; // when the one escalation went out
  lastSeenAt: number; // last rescan that still found it
}

export interface TrivyState {
  version: typeof STATE_VERSION;
  images: Record<string, ImageFinding>; // keyed by repository:tag
  jiraTickets: Record<string, JiraTicket>; // repository -> its ticket and the CVEs it lists
  secretsSeen: Record<string, SecretSighting>; // secret fingerprint -> sighting
  lastDigestAt: number;
}

export interface TrivyArtifact {
  repository: string;
  tag?: string;
  digest?: string;
}

export interface VulnerabilityInput {
  artifact: TrivyArtifact;
  namespace: string;
  workload: string;
  vulnerabilities: Array<{
    vulnerabilityID: string;
    resource: string;
    installedVersion: string;
    fixedVersion?: string;
    severity: string;
  }>;
}

/** An image in the digest, with what changed since the previous one. */
export interface ImageChange {
  key: string;
  finding: ImageFinding;
  isNewImage: boolean;
  newCves: CveFinding[];
}

/** A repository whose Jira ticket has CVEs it does not list yet. */
export interface TicketUpdate {
  repository: string;
  images: ImageFinding[];
  cves: CveFinding[]; // every actionable CVE across its tags
  newCves: CveFinding[]; // the ones not on the ticket yet
}

const STATE_VERSION = 2;
const ACTIONABLE_SEVERITIES: readonly Severity[] = ["CRITICAL", "HIGH"];
const OWN_REPOSITORY = /(^|\/)ns-data-streaming\//;
// The operator rescans daily; an image missing from three rescans is no longer deployed
const IMAGE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// A secret still found by a rescan stays known; one gone for 30 days is forgotten
const SECRET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Package metadata quoting example tokens, e.g. PyJWT's README in its dist-info
const FALSE_POSITIVE_SECRET_TARGETS = [/\.dist-info\/METADATA$/];

/** An empty state, for a first run. */
export function emptyState(): TrivyState {
  return { version: STATE_VERSION, images: {}, jiraTickets: {}, secretsSeen: {}, lastDigestAt: 0 };
}

export function emptyCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
}

/** The image as shown to the team and keyed in state, `repository:tag`. */
export function displayImage(artifact: TrivyArtifact): string {
  return `${artifact.repository}:${artifact.tag ?? "latest"}`;
}

/** Whether we build the image ourselves, so the fix is ours to ship. */
export function isOwnImage(repository: string): boolean {
  return OWN_REPOSITORY.test(repository);
}

/** A CVE's identity within an image, independent of tag: the same CVE in one package. */
export function cveKey(cve: Pick<CveFinding, "id" | "resource">): string {
  return `${cve.id}|${cve.resource}`;
}

function toSeverity(raw: string): Severity {
  const upper = raw.toUpperCase();
  return (SEVERITIES as readonly string[]).includes(upper) ? (upper as Severity) : "UNKNOWN";
}

function bySeverity(a: CveFinding, b: CveFinding): number {
  return SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id);
}

/**
 * Records a VulnerabilityReport, merged per image across the workloads that run it.
 * @returns "clean" when the image has no CVE at all, which also forgets it: it was fixed.
 */
export function recordVulnerabilityReport(
  state: TrivyState,
  input: VulnerabilityInput,
  now: number
): "recorded" | "clean" {
  const key = displayImage(input.artifact);
  const unique = new Map<string, Omit<CveFinding, "fixedVersion"> & { fixedVersion?: string }>();

  for (const v of input.vulnerabilities) {
    const cve = {
      id: v.vulnerabilityID,
      severity: toSeverity(v.severity),
      resource: v.resource,
      installedVersion: v.installedVersion,
      fixedVersion: v.fixedVersion,
    };
    unique.set(cveKey(cve), cve);
  }

  if (unique.size === 0) {
    delete state.images[key];
    return "clean";
  }

  const counts = emptyCounts();
  const actionable: CveFinding[] = [];

  for (const cve of unique.values()) {
    counts[cve.severity]++;
    const { fixedVersion } = cve;
    if (!ACTIONABLE_SEVERITIES.includes(cve.severity) || !fixedVersion) continue;

    actionable.push({ ...cve, fixedVersion });
  }

  const previous = state.images[key];
  const digest = input.artifact.digest ?? null;
  // A rebuild under the same tag runs in fresh workloads: do not carry the old ones over
  const sameBuild = previous !== undefined && previous.digest === digest;

  state.images[key] = {
    repository: input.artifact.repository,
    tag: input.artifact.tag ?? "latest",
    digest,
    ownImage: isOwnImage(input.artifact.repository),
    namespaces: mergeSorted(sameBuild ? previous.namespaces : [], input.namespace),
    workloads: mergeSorted(sameBuild ? previous.workloads : [], input.workload),
    counts,
    actionable: actionable.sort(bySeverity),
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    // Kept across a rebuild: "new" means new since the team last saw this tag
    digestedCveKeys: previous?.digestedCveKeys ?? null,
  };

  return "recorded";
}

/** Whether today's digest slot (`hourUtc`) has passed without a digest being sent. */
export function isDigestDue(state: TrivyState, now: number, hourUtc: number): boolean {
  const day = new Date(now);
  const slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc);

  return now >= slot && state.lastDigestAt < slot;
}

/** Every tracked image with what is new since the previous digest, worst first. */
export function imagesForDigest(state: TrivyState): ImageChange[] {
  return Object.entries(state.images)
    .map(([key, finding]) => {
      const shown = new Set(finding.digestedCveKeys ?? []);
      return {
        key,
        finding,
        isNewImage: finding.digestedCveKeys === null,
        newCves: finding.digestedCveKeys === null ? [] : finding.actionable.filter((c) => !shown.has(cveKey(c))),
      };
    })
    .sort(
      (a, b) =>
        b.finding.counts.CRITICAL - a.finding.counts.CRITICAL ||
        b.finding.counts.HIGH - a.finding.counts.HIGH ||
        a.key.localeCompare(b.key)
    );
}

/** What a digest showed, captured when it is built: reports landing while it posts are not in it. */
export function digestSnapshot(images: ImageChange[]): Record<string, string[]> {
  return Object.fromEntries(images.map(({ key, finding }) => [key, finding.actionable.map(cveKey)]));
}

/** Marks a posted digest's images as shown, and drops images and tickets no longer scanned. */
export function markDigestSent(state: TrivyState, shown: Record<string, string[]>, now: number): void {
  for (const [key, keys] of Object.entries(shown)) {
    const finding = state.images[key];
    if (finding) finding.digestedCveKeys = keys;
  }

  for (const [key, finding] of Object.entries(state.images)) {
    if (finding.lastSeenAt < now - IMAGE_MAX_AGE_MS) delete state.images[key];
  }

  const scanned = new Set(Object.values(state.images).map((f) => f.repository));
  for (const repository of Object.keys(state.jiraTickets)) {
    if (!scanned.has(repository)) delete state.jiraTickets[repository];
  }

  state.lastDigestAt = now;
}

/** Repositories with fixable HIGH/CRITICAL CVEs that their Jira ticket does not list yet. */
export function ticketUpdates(state: TrivyState): TicketUpdate[] {
  const byRepository = new Map<string, ImageFinding[]>();

  for (const finding of Object.values(state.images)) {
    if (finding.actionable.length === 0) continue;
    byRepository.set(finding.repository, [...(byRepository.get(finding.repository) ?? []), finding]);
  }

  const updates: TicketUpdate[] = [];

  for (const [repository, images] of [...byRepository].sort(([a], [b]) => a.localeCompare(b))) {
    const cves = new Map<string, CveFinding>();
    for (const image of images) {
      for (const cve of image.actionable) cves.set(cveKey(cve), cve);
    }

    const synced = new Set(state.jiraTickets[repository]?.cveKeys ?? []);
    const all = [...cves.values()].sort(bySeverity);
    const newCves = all.filter((c) => !synced.has(cveKey(c)));

    if (newCves.length > 0) {
      updates.push({ repository, images: images.sort((a, b) => a.tag.localeCompare(b.tag)), cves: all, newCves });
    }
  }

  return updates;
}

/** Records that a repository's ticket now lists these CVEs. */
export function markTicketSynced(state: TrivyState, update: TicketUpdate, issueKey: string): void {
  state.jiraTickets[update.repository] = { issueKey, cveKeys: update.cves.map(cveKey) };
}

/** The secrets worth a human, without known false positives. */
export function actionableSecrets<T extends { target: string }>(secrets: T[]): T[] {
  return secrets.filter((s) => !FALSE_POSITIVE_SECRET_TARGETS.some((pattern) => pattern.test(s.target)));
}

/** One fingerprint per image build and set of findings: a rebuild that still leaks is new. */
export function secretFingerprint(artifact: TrivyArtifact, secrets: Array<{ ruleID: string; target: string }>): string {
  const build = artifact.digest ? `${displayImage(artifact)}@${artifact.digest}` : displayImage(artifact);
  const findings = secrets.map((s) => `${s.ruleID}@${s.target}`).sort();
  return `${build}|${findings.join(",")}`;
}

/**
 * Whether this secret finding was already escalated. A known one has its sighting refreshed,
 * so a leak that every rescan still finds is never forgotten, and never re-paged.
 */
export function isSecretReported(state: TrivyState, fingerprint: string, now: number): boolean {
  for (const [fp, sighting] of Object.entries(state.secretsSeen)) {
    if (sighting.lastSeenAt < now - SECRET_MAX_AGE_MS) delete state.secretsSeen[fp];
  }

  const sighting = state.secretsSeen[fingerprint];
  if (!sighting) return false;

  sighting.lastSeenAt = now;
  return true;
}

/** Records the one escalation of a secret finding. Call only once it has been posted. */
export function markSecretReported(state: TrivyState, fingerprint: string, now: number): void {
  state.secretsSeen[fingerprint] = { reportedAt: now, lastSeenAt: now };
}

// -- File store ---------------------------------------------------------------

export interface TrivyStore {
  /** @throws when the file exists but cannot be read (permissions): a deploy error. */
  load(): TrivyState;
  /** @throws when the state cannot be written. Callers decide what that failure means. */
  save(state: TrivyState): void;
}

export interface TrivyStoreOptions {
  path: string;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * A JSON file store, written atomically (temp + rename) since pm2 can kill the process
 * mid-write. A corrupt or outdated file is moved aside, never overwritten, and loudly logged:
 * refusing to start would take the exposed-secret path down over bookkeeping.
 */
export function createTrivyStore(options: TrivyStoreOptions): TrivyStore {
  const { path, now = Date.now, log = (m) => console.error(m) } = options;
  const tempPath = `${path}.tmp`;

  function quarantine(reason: string): TrivyState {
    const aside = `${path}.corrupt-${now()}`;
    renameSync(path, aside);
    log(`[trivy-findings] ${path} ${reason}; moved to ${aside}, starting empty`);
    return emptyState();
  }

  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
        throw new Error(`[trivy-findings] cannot read ${path}: ${errorMessage(err)}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return quarantine(`is not valid JSON (${errorMessage(err)})`);
      }

      const migrated = migrateVersion1(parsed);
      if (migrated) {
        log(`[trivy-findings] migrated ${path} from version 1: kept the digest date and ${Object.keys(migrated.secretsSeen).length} known secret(s)`);
        return migrated;
      }

      if (!isState(parsed)) return quarantine(`is not a version ${STATE_VERSION} Trivy state`);

      const images: Record<string, ImageFinding> = {};
      let dropped = 0;
      for (const [key, finding] of Object.entries(parsed.images)) {
        if (isImageFinding(finding)) images[key] = finding;
        else dropped++;
      }
      if (dropped > 0) log(`[trivy-findings] dropped ${dropped} malformed image(s) from ${path}`);

      return { ...parsed, images };
    },

    save(state) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tempPath, JSON.stringify(state), "utf8");
        renameSync(tempPath, path);
      } catch (err) {
        removeTemp(tempPath);
        throw new Error(`[trivy-findings] failed to persist ${path}: ${errorMessage(err)}`);
      }
    },
  };
}

/**
 * Version 1 (0.3.2) kept `secretsSeen` as fingerprint -> first-reported time, with the same
 * fingerprint format as secretFingerprint(), and its images in a shape without severity
 * counts. Its known secrets and digest date are carried over, so deploying over it neither
 * re-pages a secret nor sends a second digest the same day. Its images are rebuilt from the
 * next rescans.
 */
function migrateVersion1(value: unknown): TrivyState | null {
  if (!isRecord(value) || "version" in value || !isRecord(value.secretsSeen) || typeof value.lastDigestAt !== "number") {
    return null;
  }

  const secretsSeen: Record<string, SecretSighting> = {};
  for (const [fingerprint, seenAt] of Object.entries(value.secretsSeen)) {
    if (typeof seenAt !== "number") return null;
    secretsSeen[fingerprint] = { reportedAt: seenAt, lastSeenAt: seenAt };
  }

  return { ...emptyState(), secretsSeen, lastDigestAt: value.lastDigestAt };
}

function removeTemp(tempPath: string): void {
  try {
    unlinkSync(tempPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[trivy-findings] could not remove ${tempPath}: ${errorMessage(err)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isState(value: unknown): value is TrivyState {
  return (
    isRecord(value) &&
    value.version === STATE_VERSION &&
    isRecord(value.images) &&
    isRecord(value.jiraTickets) &&
    Object.values(value.jiraTickets).every(
      (t) => isRecord(t) && typeof t.issueKey === "string" && isStringArray(t.cveKeys)
    ) &&
    isRecord(value.secretsSeen) &&
    Object.values(value.secretsSeen).every(
      (s) => isRecord(s) && typeof s.reportedAt === "number" && typeof s.lastSeenAt === "number"
    ) &&
    typeof value.lastDigestAt === "number"
  );
}

function isImageFinding(value: unknown): value is ImageFinding {
  return (
    isRecord(value) &&
    typeof value.repository === "string" &&
    typeof value.tag === "string" &&
    (value.digest === null || typeof value.digest === "string") &&
    typeof value.ownImage === "boolean" &&
    isStringArray(value.namespaces) &&
    isStringArray(value.workloads) &&
    isRecord(value.counts) &&
    SEVERITIES.every((s) => typeof (value.counts as Record<string, unknown>)[s] === "number") &&
    Array.isArray(value.actionable) &&
    value.actionable.every(
      (c) =>
        isRecord(c) &&
        typeof c.id === "string" &&
        typeof c.resource === "string" &&
        typeof c.installedVersion === "string" &&
        typeof c.fixedVersion === "string" &&
        (SEVERITIES as readonly unknown[]).includes(c.severity)
    ) &&
    typeof value.firstSeenAt === "number" &&
    typeof value.lastSeenAt === "number" &&
    (value.digestedCveKeys === null || isStringArray(value.digestedCveKeys))
  );
}

function mergeSorted(existing: string[], value: string): string[] {
  return [...new Set([...existing, value])].sort();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
