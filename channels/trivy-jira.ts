// One Jira ticket per image repository for its fixable HIGH/CRITICAL CVEs.
//
// Find-or-create, deduplicated on the repository (the image name without its tag): each
// ticket carries the `trivy` label and a label derived from the repository, and an open
// ticket with that label is updated with a comment instead of a new one being filed. A
// ticket someone closed is left closed; if the CVEs come back, a new ticket is opened.

import { createHash } from "node:crypto";
import { adfDocument, type JiraClient } from "./jira-client.js";
import { markTicketSynced, type CveFinding, type ImageFinding, type TicketUpdate, type TrivyState } from "./trivy-findings.js";

export const TRIVY_JIRA_PROJECT = "SDS";
export const TRIVY_JIRA_ISSUE_TYPE = "Task";
export const TRIVY_JIRA_LABEL = "trivy";

const CVES_LISTED = 50;

export type TicketResult =
  | { repository: string; issueKey: string; action: "created" | "commented" }
  | { repository: string; error: string };

/**
 * The per-repository dedupe label. A hash, because repository names hold characters JQL and
 * labels handle badly, and an equality match on a label is exact where a summary search is not.
 */
export function imageLabel(repository: string): string {
  return `trivy-image-${createHash("sha256").update(repository).digest("hex").slice(0, 16)}`;
}

export function ticketSummary(repository: string): string {
  return `Trivy: fixable HIGH/CRITICAL CVEs in ${repository}`;
}

/** Comments on the repository's open ticket, or creates it. */
export async function syncTicket(jira: JiraClient, update: TicketUpdate): Promise<{ issueKey: string; action: "created" | "commented" }> {
  const label = imageLabel(update.repository);
  const [open] = await jira.search(
    `project = ${TRIVY_JIRA_PROJECT} AND labels = "${label}" AND statusCategory != Done ORDER BY created ASC`,
    1
  );

  if (open) {
    await jira.addComment(
      open.key,
      adfDocument([
        { paragraph: `${update.newCves.length} new fixable HIGH/CRITICAL CVE(s) found by Trivy:` },
        { bullets: listCves(update.newCves) },
        { paragraph: "Currently scanned tags:" },
        { bullets: update.images.map(describeImage) },
      ])
    );
    return { issueKey: open.key, action: "commented" };
  }

  const issueKey = await jira.createIssue({
    project: TRIVY_JIRA_PROJECT,
    issueType: TRIVY_JIRA_ISSUE_TYPE,
    summary: ticketSummary(update.repository),
    labels: [TRIVY_JIRA_LABEL, label],
    description: adfDocument([
      {
        paragraph:
          `Trivy Operator reports ${update.cves.length} fixable HIGH/CRITICAL CVE(s) in ${update.repository}. ` +
          "Filed by the SRE agent: one ticket per image repository, and new CVEs are added as comments. " +
          "Close it once the image ships without them; a new ticket is opened if they come back.",
      },
      { paragraph: "Scanned tags:" },
      { bullets: update.images.map(describeImage) },
      { paragraph: "Fixable CVEs:" },
      { bullets: listCves(update.cves) },
    ]),
  });
  return { issueKey, action: "created" };
}

export interface SyncOptions {
  /** Wall-clock ceiling for the whole sync: no update starts after it. */
  deadline: number;
  now?: () => number;
}

/**
 * Brings every ticket up to date, one repository at a time, within a time budget. A failure
 * on one repository is reported in the result and leaves it unsynced, so the next digest
 * retries it; it never stops the others. Updates the budget leaves no time for are reported
 * the same way.
 */
export async function syncTickets(
  state: TrivyState,
  jira: JiraClient,
  updates: TicketUpdate[],
  options: SyncOptions
): Promise<TicketResult[]> {
  const { deadline, now = Date.now } = options;
  const results: TicketResult[] = [];

  for (const update of updates) {
    if (now() >= deadline) {
      results.push({ repository: update.repository, error: "not attempted: the Jira time budget for this digest ran out" });
      continue;
    }

    try {
      const { issueKey, action } = await syncTicket(jira, update);
      markTicketSynced(state, update, issueKey);
      results.push({ repository: update.repository, issueKey, action });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[trivy-jira] ticket update for ${update.repository} failed, retried at the next digest: ${error}`);
      results.push({ repository: update.repository, error });
    }
  }

  const skipped = results.filter((r) => "error" in r && r.error.startsWith("not attempted")).length;
  if (skipped > 0) console.error(`[trivy-jira] ${skipped} ticket update(s) not attempted before the deadline, retried at the next digest`);

  return results;
}

function describeImage(image: ImageFinding): string {
  const c = image.counts;
  return (
    `${image.repository}:${image.tag} in ${image.namespaces.join(", ")} (${image.workloads.join(", ")}): ` +
    `${c.CRITICAL} critical, ${c.HIGH} high, ${c.MEDIUM} medium, ${c.LOW} low`
  );
}

function listCves(cves: CveFinding[]): string[] {
  const lines = cves
    .slice(0, CVES_LISTED)
    .map((c) => `${c.severity} ${c.id} in ${c.resource} ${c.installedVersion}, fixed in ${c.fixedVersion}`);
  if (cves.length > CVES_LISTED) lines.push(`… and ${cves.length - CVES_LISTED} more`);
  return lines;
}
