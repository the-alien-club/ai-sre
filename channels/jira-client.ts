// A minimal Jira Cloud REST v3 client: the three calls the Trivy channel needs.
//
// The agent had no Jira path of its own. The only Jira writer on the platform is sentinel's
// Alertmanager (AM-R) receiver, whose credentials are mounted into that pod and which only
// files alert groups; it cannot be reused from this VM. So this is a small client over
// fetch, with the credentials required from the environment and every call bounded.

import { z } from "zod";
import { OperationTimeoutError } from "./with-timeout.js";

export interface JiraConfig {
  baseUrl: string; // https://<site>.atlassian.net, no trailing slash
  email: string;
  apiToken: string;
}

/** Atlassian Document Format, the only body format REST v3 accepts. */
export interface AdfDocument {
  type: "doc";
  version: 1;
  content: unknown[];
}

export interface JiraIssueRef {
  key: string;
  summary: string;
}

export interface NewJiraIssue {
  project: string;
  issueType: string;
  summary: string;
  labels: string[];
  description: AdfDocument;
}

export interface JiraClient {
  search(jql: string, maxResults: number): Promise<JiraIssueRef[]>;
  createIssue(issue: NewJiraIssue): Promise<string>;
  addComment(issueKey: string, body: AdfDocument): Promise<void>;
  browseUrl(issueKey: string): string;
}

export class JiraError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    detail: string
  ) {
    super(`Jira ${operation} failed with HTTP ${status}: ${detail}`);
    this.name = "JiraError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraClientOptions {
  fetch?: FetchLike;
  timeoutMs: number;
}

const ERROR_DETAIL_CHARS = 300;

/** The environment variables readJiraConfig requires; start-agent.sh checks them too. */
export const JIRA_SETTINGS = ["JIRA_BASE_URL", "JIRA_USER_EMAIL", "JIRA_API_TOKEN"] as const;

/**
 * Reads the Jira credentials. All three are required and have no default: a channel that
 * would silently skip its tickets, or post them to a guessed site, is worse than one that
 * refuses to start.
 * @throws Error naming every missing or invalid variable.
 */
export function readJiraConfig(env: NodeJS.ProcessEnv): JiraConfig {
  const missing = JIRA_SETTINGS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set (see .env.example)`);
  }

  const baseUrl = (env.JIRA_BASE_URL as string).replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(baseUrl)) {
    throw new Error(`JIRA_BASE_URL must be an https site root such as https://example.atlassian.net, got "${baseUrl}"`);
  }

  return { baseUrl, email: env.JIRA_USER_EMAIL as string, apiToken: env.JIRA_API_TOKEN as string };
}

const SearchResponse = z.object({
  issues: z.array(z.object({ key: z.string(), fields: z.object({ summary: z.string() }) })),
});
const CreateResponse = z.object({ key: z.string() });

export function createJiraClient(config: JiraConfig, options: JiraClientOptions): JiraClient {
  const { fetch: fetchImpl = globalThis.fetch, timeoutMs } = options;
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;

  async function call(operation: string, path: string, body: unknown): Promise<unknown> {
    // Not AbortSignal.timeout(): its timer is unref'd, so a process with nothing else alive
    // could exit before the bound fires. The deadline covers reading the body too.
    const controller = new AbortController();
    const timeout = new OperationTimeoutError(`Jira ${operation}`, timeoutMs);
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) throw timeout;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw new JiraError(operation, response.status, text.slice(0, ERROR_DETAIL_CHARS));
    if (text === "") return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new JiraError(operation, response.status, `response is not JSON: ${text.slice(0, ERROR_DETAIL_CHARS)}`);
    }
  }

  function parse<T>(operation: string, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new JiraError(operation, 200, `unexpected response shape: ${result.error.message}`);
    return result.data;
  }

  return {
    async search(jql, maxResults) {
      const raw = await call("search", "/rest/api/3/search/jql", { jql, maxResults, fields: ["summary"] });
      return parse("search", SearchResponse, raw).issues.map((i) => ({ key: i.key, summary: i.fields.summary }));
    },

    async createIssue(issue) {
      const raw = await call("create issue", "/rest/api/3/issue", {
        fields: {
          project: { key: issue.project },
          issuetype: { name: issue.issueType },
          summary: issue.summary,
          labels: issue.labels,
          description: issue.description,
        },
      });
      return parse("create issue", CreateResponse, raw).key;
    },

    async addComment(issueKey, body) {
      await call("add comment", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { body });
    },

    browseUrl(issueKey) {
      return `${config.baseUrl}/browse/${issueKey}`;
    },
  };
}

/** An ADF document of paragraphs and bullet lists, enough for a generated ticket. */
export function adfDocument(blocks: Array<{ paragraph: string } | { bullets: string[] }>): AdfDocument {
  return {
    type: "doc",
    version: 1,
    content: blocks.map((block) =>
      "paragraph" in block
        ? { type: "paragraph", content: [{ type: "text", text: block.paragraph }] }
        : {
            type: "bulletList",
            content: block.bullets.map((item) => ({
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: item }] }],
            })),
          }
    ),
  };
}
