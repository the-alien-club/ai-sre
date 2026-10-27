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
