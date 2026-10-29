// Slack mrkdwn escaping for text this process did not write.
//
// Image names, package names and secret rule titles come from scanned images. Slack reads
// `<@U123>`, `<!channel>` and `<!here>` in message text as mentions, so unescaped they could
// page people from a digest that must never page anyone. Slack's own rule: escape &, < and >.

export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Splits lines into messages of at most `maxChars`, never mid-line. A single line longer
 * than that is cut, so no message can exceed what Slack accepts.
 */
export function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const raw of lines) {
    const line = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw;
    const candidate = current ? `${current}\n${line}` : line;

    if (candidate.length > maxChars) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Slack mrkdwn markers that may wrap a whole reply without changing what it says: a code
 * block, inline code, bold and italic. Strikethrough (`~`) is deliberately absent: a
 * struck-out "yes" says the opposite. Longest first, so ``` is not read as three `.
 */
const WRAPPERS = ["```", "`", "*", "_"] as const;
/** Slack's quote marker as it arrives in event text (escaped), and as typed. */
const QUOTE_PREFIX = /^(?:&gt;|>)[ \t]*/;
/** At most this many layers of formatting are peeled; real replies have one or two. */
const MAX_FORMAT_LAYERS = 8;

/**
 * The words of a reply with Slack's formatting around them removed, for matching a reply
 * against an exact phrase only: the runbook approvals (kedb-approval.ts APPROVE_RE,
 * REJECT_RE) and the permission verdicts (slack-sre.ts). What is stored keeps the original.
 * Copying "yes downgrade KB-1" out of a proposal post that shows it as inline code gives
 * "`yes downgrade KB-1`" (2026-10-29, KB-1); a quote, bold or italic around the reply, outer
 * whitespace (no-break spaces included) and a trailing period mean the same. Only formatting
 * around the whole reply is removed: the words themselves must still match exactly.
 * sre-kedb ci/verify-approvals.ts normalizeReplyText reads Slack's copy of the message the
 * same way; keep the two equal.
 */
export function normalizeReplyText(text: string): string {
  let current = text.replace(/\u00a0/g, " ").trim();
  for (let layer = 0; layer < MAX_FORMAT_LAYERS; layer++) {
    let next = current.replace(QUOTE_PREFIX, "").replace(/[.!]+$/, "").trim();
    const wrapper = WRAPPERS.find((w) => next.length > 2 * w.length && next.startsWith(w) && next.endsWith(w));
    if (wrapper !== undefined) next = next.slice(wrapper.length, -wrapper.length).trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}
