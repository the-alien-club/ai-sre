// A minimal Rundeck API client: the three calls the sentinel remediation path needs.
//
// Rundeck runs on VM-A (sentinel, SDS-1000) and serves plain HTTP on NodePort 30440, reached
// only over the WireGuard link between VM-A and this VM. The agent's token (role `sre-agent`)
// can read and run jobs in group `actions` of project `sentinel`, and nothing else
// (sentinel rundeck/acl/sre-agent.aclpolicy). Every call is bounded (CLAUDE_ERROR_PATTERNS.md §14).

import { z } from "zod";
import { OperationTimeoutError } from "./with-timeout.js";

/** The API version Rundeck 6.3.0 reports as current; sentinel's scripts and tests pin the same. */
const API_VERSION = 60;
const ERROR_DETAIL_CHARS = 300;

export interface RundeckConfig {
  baseUrl: string; // scheme://host[:port], no trailing slash
  apiToken: string;
}

export interface RundeckJob {
  id: string;
  group: string;
  name: string;
}

export interface RundeckJobOption {
  name: string;
  enforced: boolean;
  values: string[];
}

export interface RundeckExecution {
  id: number;
  permalink: string | undefined;
}

export interface RundeckClient {
  /** The one job with exactly this group and name. @throws RundeckError when there is not exactly one. */
  findJob(project: string, group: string, name: string): Promise<RundeckJob>;
  /** The options the job declares, as its live definition has them. */
  jobOptions(jobId: string): Promise<RundeckJobOption[]>;
  /** Starts the job with exactly these options and returns the execution Rundeck created. */
  runJob(jobId: string, options: Record<string, string>): Promise<RundeckExecution>;
}

export class RundeckError extends Error {
  constructor(
    readonly operation: string,
    /** The HTTP status, or 0 when Rundeck answered 2xx with something unusable. */
    readonly status: number,
    /** Rundeck's own `errorCode`, such as `api.error.job.options-invalid`, when it sent one. */
    readonly errorCode: string | undefined,
    detail: string
  ) {
    super(`Rundeck ${operation} failed${status > 0 ? ` with HTTP ${status}` : ""}: ${detail}`);
    this.name = "RundeckError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RundeckClientOptions {
  fetch?: FetchLike;
  timeoutMs: number;
}

/** The environment variables readRundeckConfig requires; start-agent.sh checks them too. */
export const RUNDECK_SETTINGS = ["RUNDECK_URL", "RUNDECK_API_TOKEN"] as const;

// Rundeck has no TLS of its own: plain HTTP is only acceptable to a private address, which is
// what the WireGuard peer is. A token sent in clear over the internet could run prod remediations.
const PRIVATE_IPV4 = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

/**
 * Reads the Rundeck endpoint and token. Both are required and have no default: a remediation
 * path that silently does nothing is found out only when stage 2 pages a human.
 * @throws Error naming every missing or invalid variable.
 */
export function readRundeckConfig(env: NodeJS.ProcessEnv): RundeckConfig {
  const missing = RUNDECK_SETTINGS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set (see .env.example)`);
  }

  const baseUrl = (env.RUNDECK_URL as string).trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`RUNDECK_URL must be a URL such as http://10.66.0.1:30440, got "${baseUrl}"`);
  }
  if (url.origin !== baseUrl) {
    throw new Error(`RUNDECK_URL must be a bare origin (scheme, host, port) with no path, got "${baseUrl}"`);
  }
  if (url.protocol === "http:" && !PRIVATE_IPV4.test(url.hostname)) {
    throw new Error(`RUNDECK_URL may use plain http only to a private IPv4 address (the WireGuard peer), got "${baseUrl}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`RUNDECK_URL must be http or https, got "${baseUrl}"`);
  }

  return { baseUrl, apiToken: (env.RUNDECK_API_TOKEN as string).trim() };
}

const JobListing = z.array(z.object({ id: z.string().min(1), group: z.string().nullable(), name: z.string() }));
const JobDefinition = z
  .array(
    z.object({
      options: z
        .array(
          z.object({
            name: z.string(),
            enforced: z.boolean().optional(),
            values: z.array(z.string()).optional(),
          })
        )
        .optional(),
    })
  )
  .length(1);
const ExecutionStarted = z.object({ id: z.number().int().positive(), permalink: z.string().optional() });
const ErrorBody = z.object({ errorCode: z.string().optional(), message: z.string().optional() });

export function createRundeckClient(config: RundeckConfig, options: RundeckClientOptions): RundeckClient {
  const { fetch: fetchImpl = globalThis.fetch, timeoutMs } = options;
  const api = `${config.baseUrl}/api/${API_VERSION}`;

  async function call(operation: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    // Not AbortSignal.timeout(): its timer is unref'd, so a process with nothing else alive
    // could exit before the bound fires. The deadline covers reading the body too.
    const controller = new AbortController();
    const timeout = new OperationTimeoutError(`Rundeck ${operation}`, timeoutMs);
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);

    const headers: Record<string, string> = { "X-Rundeck-Auth-Token": config.apiToken, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(`${api}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        // A redirect would mean the URL is wrong (Rundeck sends unauthenticated web requests
        // to its login page); following it could carry the token somewhere unintended.
        redirect: "error",
      });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) throw timeout;
      throw err;
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown = null;
    let parseError: string | undefined;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parseError = `response is not JSON: ${text.slice(0, ERROR_DETAIL_CHARS)}`;
      }
    }

    if (!response.ok) {
      const error = ErrorBody.safeParse(parsed);
      const errorCode = error.success ? error.data.errorCode : undefined;
      const detail = error.success && error.data.message ? error.data.message : text.slice(0, ERROR_DETAIL_CHARS);
      throw new RundeckError(operation, response.status, errorCode, detail);
    }
    if (parseError !== undefined) throw new RundeckError(operation, 0, undefined, parseError);
    return parsed;
  }

  function parse<T>(operation: string, schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new RundeckError(operation, 0, undefined, `unexpected response shape: ${result.error.message}`);
    return result.data;
  }

  return {
    async findJob(project, group, name) {
      const operation = `find job ${group}/${name}`;
      const query = new URLSearchParams({ groupPathExact: group, jobExactFilter: name });
      const raw = await call(operation, "GET", `/project/${encodeURIComponent(project)}/jobs?${query}`);
      // The filters are Rundeck's; the exact match is checked here again rather than trusted
      const matches = parse(operation, JobListing, raw).filter((job) => job.group === group && job.name === name);
      if (matches.length !== 1) {
        throw new RundeckError(operation, 0, undefined, `expected exactly one job ${group}/${name} in ${project}, found ${matches.length}`);
      }
      const [job] = matches;
      return { id: job.id, group, name };
    },

    async jobOptions(jobId) {
      const operation = `read job ${jobId}`;
      const raw = await call(operation, "GET", `/job/${encodeURIComponent(jobId)}?format=json`);
      const [definition] = parse(operation, JobDefinition, raw);
      return (definition.options ?? []).map((option) => ({
        name: option.name,
        enforced: option.enforced === true,
        values: option.values ?? [],
      }));
    },

    async runJob(jobId, jobOptions) {
      const operation = `run job ${jobId}`;
      const raw = await call(operation, "POST", `/job/${encodeURIComponent(jobId)}/run`, { options: jobOptions });
      const execution = parse(operation, ExecutionStarted, raw);
      return { id: execution.id, permalink: execution.permalink };
    },
  };
}
