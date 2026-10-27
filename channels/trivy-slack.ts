// Posting Trivy findings to the team channel, directly from the Trivy channel process.
//
// Not through the agent: when the agent was handed each finding and told to use `reply`
// rather than `escalate`, the guarantee lived in a prompt. Here it lives in code. The digest
// is posted with no mention (and refused if one slips in), and an exposed secret is posted
// once with one page and is never registered with the nag loop in slack-sre.ts.

import { chunkLines, escapeSlackText } from "./slack-text.js";
import type { DigestMessages } from "./trivy-digest.js";
import { OperationTimeoutError, withTimeout } from "./with-timeout.js";

/** The slice of @slack/web-api's WebClient this module needs. Narrow, so tests can stub it. */
export interface ChatPoster {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{ ok?: boolean; ts?: string; error?: string }>;
  };
}

export interface SlackPoster {
  /** Posts and returns the message ts. @throws on failure or timeout. */
  post(text: string, threadTs?: string): Promise<string>;
}

// Slack accepts 40k characters but folds anything past ~4k behind "show more"
const THREAD_CHUNK_CHARS = 3500;
const MENTION = /<[@!]/;

export class DigestPartiallyPostedError extends Error {
  constructor(
    readonly summaryTs: string | null, // null: the summary post timed out, it may or may not be visible
    readonly postedChunks: number,
    readonly totalChunks: number,
    cause: unknown
  ) {
    super(
      (summaryTs === null
        ? `digest summary post timed out and may be visible; ${totalChunks} thread message(s) not posted: `
        : `digest summary posted (ts ${summaryTs}) but only ${postedChunks}/${totalChunks} thread message(s): `) +
        (cause instanceof Error ? cause.message : String(cause))
    );
    this.name = "DigestPartiallyPostedError";
  }
}

export function createSlackPoster(client: ChatPoster, channel: string, timeoutMs: number): SlackPoster {
  return {
    async post(text, threadTs) {
      const result = await withTimeout(
        client.chat.postMessage({ channel, text, thread_ts: threadTs, unfurl_links: false, unfurl_media: false }),
        timeoutMs,
        "slack chat.postMessage"
      );
      if (!result.ok || !result.ts) throw new Error(`slack chat.postMessage failed: ${result.error ?? "no ts returned"}`);
      return result.ts;
    },
  };
}

/**
 * Posts the digest summary, then its per-image lines in the summary's thread.
 * @throws Error if any digest text would mention someone, before anything is posted.
 * @throws DigestPartiallyPostedError when the summary went out (or timed out) but a thread message did not,
 *   so the caller can tell "nothing visible" (retry) from "visible but incomplete" (do not).
 */
export async function postDigest(poster: SlackPoster, digest: DigestMessages): Promise<string> {
  const chunks = chunkLines(digest.details, THREAD_CHUNK_CHARS);

  for (const text of [digest.summary, ...chunks]) {
    if (MENTION.test(text)) throw new Error("refusing to post a Trivy digest that contains a mention");
  }

  let ts: string;
  try {
    ts = await poster.post(digest.summary);
  } catch (err) {
    // Slack may have accepted a post that timed out here: posting it again a minute later
    // would put two digests in the channel, so it counts as visible but incomplete
    if (err instanceof OperationTimeoutError) throw new DigestPartiallyPostedError(null, 0, chunks.length, err);
    throw err;
  }

  for (let i = 0; i < chunks.length; i++) {
    try {
      await poster.post(chunks[i], ts);
    } catch (err) {
      throw new DigestPartiallyPostedError(ts, i, chunks.length, err);
    }
  }

  return ts;
}

export interface SecretEscalation {
  image: string;
  workload: string;
  namespace: string;
  secrets: Array<{ ruleID: string; category: string; severity: string; title: string; target: string }>;
}

const SECRETS_LISTED = 10;

/** The one message for an exposed secret: the only Trivy message that pages anyone. */
export function secretEscalationText(finding: SecretEscalation, mentions: string): string {
  const listed = finding.secrets
    .slice(0, SECRETS_LISTED)
    .map((s) => `• [${s.severity}] ${s.ruleID} (${s.category}): ${s.title} in \`${s.target}\``);
  if (finding.secrets.length > SECRETS_LISTED) listed.push(`• … and ${finding.secrets.length - SECRETS_LISTED} more`);

  return [
    ":rotating_light: *Trivy: exposed secret in a container image*",
    mentions,
    "",
    `*Image:* ${escapeSlackText(finding.image)}`,
    `*Workload:* ${escapeSlackText(finding.workload)} in ${escapeSlackText(finding.namespace)}`,
    "*Findings:*",
    ...listed.map(escapeSlackText),
    "",
    "*Action:* if the secret is real, rotate it (revoke and reissue), then rebuild the image without it.",
    "_Posted once per image build, with no reminders. The SRE agent is checking whether the image is deployed and answers in this thread._",
  ].join("\n");
}
