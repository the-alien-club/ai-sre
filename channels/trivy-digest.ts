// The daily Trivy digest as Slack messages.
//
// One top-level message: totals, then what is new since the previous digest, highlighted.
// The per-image counts by severity follow as replies in its thread, so the shared channel
// gets one message a day however many images are scanned.
//
// Nothing here mentions anyone. Every string that comes from a scanned image is escaped, and
// trivy-slack.ts refuses to post digest text that contains a mention anyway.

import { escapeSlackText } from "./slack-text.js";
import type { TicketResult } from "./trivy-jira.js";
import {
  digestSnapshot,
  emptyCounts,
  imagesForDigest,
  SEVERITIES,
  type ImageChange,
  type SeverityCounts,
  type TrivyState,
} from "./trivy-findings.js";

export interface DigestMessages {
  summary: string;
  details: string[]; // thread replies, one line per image
  shown: Record<string, string[]>; // for markDigestSent, captured at build time
}

const HIGHLIGHTS_SHOWN = 15;
const NEW_CVES_NAMED = 3;
const FAILURES_NAMED = 5;

/** @returns null when no image has any CVE: nothing worth a message. */
export function buildDigest(
  state: TrivyState,
  now: number,
  tickets: TicketResult[],
  browseUrl: (issueKey: string) => string
): DigestMessages | null {
  const images = imagesForDigest(state);
  if (images.length === 0) return null;

  const link = (repository: string): string => {
    const ticket = state.jiraTickets[repository];
    return ticket ? ` <${browseUrl(ticket.issueKey)}|${ticket.issueKey}>` : "";
  };

  const totals = emptyCounts();
  let fixable = 0;
  for (const { finding } of images) {
    for (const s of SEVERITIES) totals[s] += finding.counts[s];
    fixable += finding.actionable.length;
  }

  const changed = images.filter((i) => i.isNewImage || i.newCves.length > 0);
  const lines = [
    `:shield: *Daily Trivy digest* — ${new Date(now).toISOString().slice(0, 10)}`,
    `${images.length} image(s) scanned: ${formatCounts(totals)}; ${fixable} fixable HIGH/CRITICAL.`,
    "",
  ];

  if (changed.length === 0) {
    lines.push("Nothing new since the previous digest.");
  } else {
    lines.push(`*New since the previous digest* (${changed.length}):`);
    for (const change of changed.slice(0, HIGHLIGHTS_SHOWN)) {
      lines.push(`• ${describeChange(change)}${link(change.finding.repository)}`);
    }
    if (changed.length > HIGHLIGHTS_SHOWN) lines.push(`• … and ${changed.length - HIGHLIGHTS_SHOWN} more, marked in the thread`);
  }

  lines.push("", ...describeTickets(tickets), "_Per-image counts in the thread. CVE backlog, not an incident: no page, no reminders._");

  return {
    summary: lines.join("\n"),
    details: describeImages(images, link),
    shown: digestSnapshot(images),
  };
}

function describeChange({ finding, isNewImage, newCves }: ImageChange): string {
  const image = `*${escapeSlackText(`${finding.repository}:${finding.tag}`)}*`;
  if (isNewImage) return `:new: ${image} — new image: ${formatCounts(finding.counts)}`;

  const named = newCves
    .slice(0, NEW_CVES_NAMED)
    .map((c) => escapeSlackText(`${c.id} (${c.severity.toLowerCase()}, ${c.resource})`))
    .join(", ");
  const more = newCves.length > NEW_CVES_NAMED ? `, +${newCves.length - NEW_CVES_NAMED} more` : "";
  return `:arrow_up: ${image} — ${newCves.length} new fixable: ${named}${more}`;
}

function describeImages(images: ImageChange[], link: (repository: string) => string): string[] {
  const own = images.filter((i) => i.finding.ownImage);
  const thirdParty = images.filter((i) => !i.finding.ownImage);
  const lines: string[] = ["Counts are critical/high/medium/low; *fix* is how many HIGH/CRITICAL have a fixed version."];

  const section = (title: string, list: ImageChange[]) => {
    if (list.length === 0) return;
    lines.push("", `*${title}* (${list.length}):`);
    for (const change of list) {
      const { finding } = change;
      const c = finding.counts;
      const marker = change.isNewImage ? ":new: " : change.newCves.length > 0 ? `:arrow_up: +${change.newCves.length} ` : "";
      lines.push(
        `• ${marker}${escapeSlackText(`${finding.repository}:${finding.tag}`)} ` +
          `[${escapeSlackText(finding.namespaces.join(", "))}] ` +
          `${c.CRITICAL}/${c.HIGH}/${c.MEDIUM}/${c.LOW}, fix ${finding.actionable.length}${link(finding.repository)}`
      );
    }
  };

  section("Our images (ns-data-streaming)", own);
  section("Third-party images (upstream upgrades)", thirdParty);
  return lines;
}

function describeTickets(tickets: TicketResult[]): string[] {
  if (tickets.length === 0) return [];

  const created = tickets.filter((t) => "action" in t && t.action === "created").length;
  const commented = tickets.filter((t) => "action" in t && t.action === "commented").length;
  const failed = tickets.filter((t): t is { repository: string; error: string } => "error" in t);
  const lines = [`Jira (SDS, label trivy): ${created} ticket(s) opened, ${commented} updated.`];

  if (failed.length > 0) {
    lines.push(
      `:warning: Jira update failed for ${failed.length} image(s), retried at the next digest: ` +
        failed
          .slice(0, FAILURES_NAMED)
          .map((f) => escapeSlackText(`${f.repository} (${f.error.slice(0, 120)})`))
          .join("; ") +
        (failed.length > FAILURES_NAMED ? `; +${failed.length - FAILURES_NAMED} more in the agent's error log` : "")
    );
  }
  return lines;
}

function formatCounts(c: SeverityCounts): string {
  return `${c.CRITICAL} critical, ${c.HIGH} high, ${c.MEDIUM} medium, ${c.LOW} low`;
}
