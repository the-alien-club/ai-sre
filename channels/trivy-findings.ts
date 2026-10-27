// Trivy findings bookkeeping. Vulnerability reports become one daily digest of what is new or
// worse, exposed secrets are forwarded once per image. On disk: the agent restarts nightly.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CveFinding {
  id: string;
  severity: string;
  resource: string;
  installedVersion: string;
  fixedVersion: string;
}

export interface ImageFinding {
  image: string; // repository:tag, as shown to the team
  ownImage: boolean;
  namespaces: string[];
  workloads: string[];
  criticalCount: number; // fixable only
  highCount: number; // fixable only
  topCves: CveFinding[];
  firstSeenAt: number;
  lastSeenAt: number;
  reportedCriticalCount: number | null; // as of the last digest, null until first reported
}

export interface TrivyState {
  images: Record<string, ImageFinding>; // keyed by image + digest, so a rebuild is a new image
  secretsSeen: Record<string, number>; // secret fingerprint -> first forwarded at
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

export interface Digest {
  content: string;
  meta: Record<string, string>;
  keys: string[];
}

const ACTIONABLE_SEVERITIES = ["CRITICAL", "HIGH"];
const OWN_REPOSITORY = /(^|\/)ns-data-streaming\//;
const TOP_CVES_KEPT = 5;
const TOP_CVES_SHOWN = 3;
const IMAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const SECRET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Package metadata quoting example tokens, e.g. PyJWT's README in its dist-info
const FALSE_POSITIVE_SECRET_TARGETS = [/\.dist-info\/METADATA$/];

/** An empty state, for a first run or an unreadable file. */
export function emptyState(): TrivyState {
  return { images: {}, secretsSeen: {}, lastDigestAt: 0 };
}

/** The image as shown to the team, `repository:tag`. */
export function displayImage(artifact: TrivyArtifact): string {
  return `${artifact.repository}:${artifact.tag ?? "latest"}`;
}

/** The bookkeeping key, digest included so a rebuild under the same tag counts as new. */
export function imageKey(artifact: TrivyArtifact): string {
  const shown = displayImage(artifact);
  return artifact.digest ? `${shown}@${artifact.digest}` : shown;
}

/** Whether we build the image ourselves, so the fix is ours to ship. */
export function isOwnImage(repository: string): boolean {
  return OWN_REPOSITORY.test(repository);
}

/**
 * Records a VulnerabilityReport's fixable HIGH/CRITICAL findings, merged per image across workloads.
 * @returns false when nothing is actionable, so nothing was recorded.
 */
export function recordVulnerabilityReport(state: TrivyState, input: VulnerabilityInput, now: number): boolean {
  const unique = new Map<string, CveFinding>();

  for (const v of input.vulnerabilities) {
    if (!ACTIONABLE_SEVERITIES.includes(v.severity) || !v.fixedVersion) continue;

    unique.set(`${v.vulnerabilityID}|${v.resource}`, {
      id: v.vulnerabilityID,
      severity: v.severity,
      resource: v.resource,
      installedVersion: v.installedVersion,
      fixedVersion: v.fixedVersion,
    });
  }

  if (unique.size === 0) return false;

  const cves = [...unique.values()].sort(
    (a, b) => ACTIONABLE_SEVERITIES.indexOf(a.severity) - ACTIONABLE_SEVERITIES.indexOf(b.severity)
  );
  const key = imageKey(input.artifact);
  const previous = state.images[key];

  state.images[key] = {
    image: displayImage(input.artifact),
    ownImage: isOwnImage(input.artifact.repository),
    namespaces: mergeSorted(previous?.namespaces, input.namespace),
    workloads: mergeSorted(previous?.workloads, input.workload),
    criticalCount: cves.filter((c) => c.severity === "CRITICAL").length,
    highCount: cves.filter((c) => c.severity === "HIGH").length,
    topCves: cves.slice(0, TOP_CVES_KEPT),
    firstSeenAt: previous?.firstSeenAt ?? now,
    lastSeenAt: now,
    reportedCriticalCount: previous?.reportedCriticalCount ?? null,
  };

  return true;
}

/** Whether today's digest slot (`hourUtc`) has passed without a digest being sent. */
export function isDigestDue(state: TrivyState, now: number, hourUtc: number): boolean {
  const day = new Date(now);
  const slot = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hourUtc);

  return now >= slot && state.lastDigestAt < slot;
}

/**
 * Builds the digest of images never reported or with more critical CVEs than last time.
 * @returns null when there is nothing new, so no message is sent.
 */
export function buildDigest(state: TrivyState, now: number): Digest | null {
  const due = Object.entries(state.images).filter(
    ([, f]) => f.reportedCriticalCount === null || f.criticalCount > f.reportedCriticalCount
  );

  if (due.length === 0) return null;

  const bySeverity = (a: ImageFinding, b: ImageFinding) => b.criticalCount - a.criticalCount || b.highCount - a.highCount;
  const own = due.map(([, f]) => f).filter((f) => f.ownImage).sort(bySeverity);
  const thirdParty = due.map(([, f]) => f).filter((f) => !f.ownImage).sort(bySeverity);
  const lines = [
    `Daily Trivy digest: ${due.length} image(s) new or worse since the last digest (fixable HIGH/CRITICAL only).`,
  ];

  if (own.length > 0) {
    lines.push("", `Our images (ns-data-streaming), ${own.length}:`);

    for (const f of own) {
      lines.push(`- ${f.image} [${f.namespaces.join(", ")}] ${f.workloads.join(", ")}: ${counts(f)}`);

      for (const c of f.topCves.slice(0, TOP_CVES_SHOWN)) {
        lines.push(`    ${c.severity} ${c.id} in ${c.resource}@${c.installedVersion} → ${c.fixedVersion}`);
      }
    }
  }

  if (thirdParty.length > 0) {
    lines.push("", `Third-party images, ${thirdParty.length} (upstream upgrades):`);

    const byNamespace = new Map<string, ImageFinding[]>();

    for (const f of thirdParty) {
      const namespace = f.namespaces[0] ?? "unknown";
      byNamespace.set(namespace, [...(byNamespace.get(namespace) ?? []), f]);
    }

    for (const [namespace, findings] of [...byNamespace].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${namespace}: ${findings.map((f) => `${shortName(f.image)} (${f.criticalCount}C/${f.highCount}H)`).join(", ")}`);
    }
  }

  return {
    content: lines.join("\n"),
    meta: {
      kind: "vulnerability-digest",
      severity: "info",
      image_count: String(due.length),
      own_image_count: String(own.length),
      third_party_image_count: String(thirdParty.length),
      fingerprint: `trivy-digest-${new Date(now).toISOString().slice(0, 10)}`,
    },
    keys: due.map(([key]) => key),
  };
}

/** Marks a sent digest's images as reported and drops images no longer scanned. */
export function markDigestSent(state: TrivyState, keys: string[], now: number): void {
  for (const key of keys) {
    const finding = state.images[key];
    if (finding) finding.reportedCriticalCount = finding.criticalCount;
  }

  for (const [key, finding] of Object.entries(state.images)) {
    if (finding.lastSeenAt < now - IMAGE_MAX_AGE_MS) delete state.images[key];
  }

  state.lastDigestAt = now;
}

/** The secrets worth a human, without known false positives. */
export function actionableSecrets<T extends { target: string }>(secrets: T[]): T[] {
  return secrets.filter((s) => !FALSE_POSITIVE_SECRET_TARGETS.some((pattern) => pattern.test(s.target)));
}

/**
 * Remembers an exposed-secret finding, so a rescan of the same image does not alert again.
 * @returns true the first time a finding is seen (within 30 days).
 */
export function isNewSecretFinding(
  state: TrivyState,
  artifact: TrivyArtifact,
  secrets: Array<{ ruleID: string; target: string }>,
  now: number
): boolean {
  for (const [fingerprint, seenAt] of Object.entries(state.secretsSeen)) {
    if (seenAt < now - SECRET_MAX_AGE_MS) delete state.secretsSeen[fingerprint];
  }

  const findings = secrets.map((s) => `${s.ruleID}@${s.target}`).sort();
  const fingerprint = `${imageKey(artifact)}|${findings.join(",")}`;

  if (fingerprint in state.secretsSeen) return false;

  state.secretsSeen[fingerprint] = now;
  return true;
}

export interface TrivyStore {
  load(): TrivyState;
  save(state: TrivyState): void;
}

/** A JSON file store, written atomically (temp + rename) since pm2 can kill the process mid-write. */
export function createTrivyStore(path: string): TrivyStore {
  const tempPath = `${path}.tmp`;

  return {
    load() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`[trivy-findings] could not read ${path}, starting empty:`, errorMessage(err));
        }
        return emptyState();
      }

      try {
        const parsed = JSON.parse(raw) as Partial<TrivyState>;
        const valid =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.images === "object" &&
          typeof parsed.secretsSeen === "object" &&
          typeof parsed.lastDigestAt === "number";

        if (valid) return parsed as TrivyState;

        console.error(`[trivy-findings] ${path} has an unexpected shape, starting empty`);
      } catch (err) {
        console.error(`[trivy-findings] ${path} is not valid JSON, starting empty:`, errorMessage(err));
      }

      return emptyState();
    },

    save(state) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
        renameSync(tempPath, path);
      } catch (err) {
        console.error(`[trivy-findings] failed to persist ${path}:`, errorMessage(err));
        try {
          unlinkSync(tempPath);
        } catch {
          // Nothing to clean up
        }
      }
    },
  };
}

function mergeSorted(existing: string[] | undefined, value: string): string[] {
  return [...new Set([...(existing ?? []), value])].sort();
}

function counts(f: ImageFinding): string {
  return `${f.criticalCount} critical, ${f.highCount} high`;
}

function shortName(image: string): string {
  return image.slice(image.lastIndexOf("/") + 1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
