// Sentinel stage-1 remediation: deterministic, no LLM in the loop.
//
// Sentinel (tooling/sentinel, signoz/README.md D-8) sends a `remediable` hop's stage-1 alert to
// this agent only. The alert names the fix itself: `sentinel_action` is a Rundeck job in group
// `actions`, `sentinel_target` the one allowlisted resource it acts on. The agent's whole job is
// to start that job once, with exactly those values, and let it report its own outcome to
// #alerts-ops. If the job refuses or fails, the condition stays true and sentinel's stage 2
// (`Hop down: <hop>`) escalates to a human by persistence.
//
// So this runs in code, before anything reaches the Claude session, and never chooses an
// action, a target or a node: it validates what the alert says against an allowlist and the
// live job definition, and either runs it or logs why not.
//
// - One run per firing episode of a fingerprint. Alertmanager re-notifies every hour while the
//   alert fires and keeps its startsAt, so (fingerprint, startsAt) is the episode. A fingerprint
//   is a hash of the labels and comes back when the same node or cluster breaks again later;
//   that new episode gets its own run, and the job's breaker caps runs per fingerprint.
// - Whatever came of the attempt (started, refused, or Rundeck unreachable) is final for the
//   episode. A timed-out run may have started, so it is never retried either.
// - Resolved notifications for this class are ignored.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RemediationOutcome, RemediationRecord } from "./remediation-store.js";
import { RundeckError, type RundeckClient, type RundeckJobOption } from "./rundeck-client.js";

/** The class label sentinel puts on a stage-1 alert of a hop with `remediation`. */
export const REMEDIABLE_CLASS = "remediable";

// The target is `<context>/<namespace>/<name>` in today's catalog. Conservative on purpose:
// each segment is a DNS-label-like run of lowercase letters, digits and inner hyphens, so
// nothing in it can be read as an option, a relative path or a shell token by any step
// downstream. Rundeck still enforces the job's own value list on top of this.
const TARGET_SEGMENT = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const TARGET_PATTERN = new RegExp(`^${TARGET_SEGMENT}(/${TARGET_SEGMENT})*$`);
const TARGET_MAX_CHARS = 253;
// The `fingerprint` option's regex in every generated sentinel job (generated/rundeck/jobs/*.yaml)
const FINGERPRINT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Stage 1 runs before any ticket exists, so the job takes `none` (D-8)
const STAGE_ONE_INCIDENT = "none";
// The options this path sends; the job must declare every one of them, because Rundeck OSS
// accepts an undeclared option silently and the step would never see it.
const SENT_OPTIONS = ["target", "fingerprint", "incident"] as const;

// -- Allowlist configuration --------------------------------------------------

const RemediationConfigSchema = z
  .object({
    rundeckProject: z.string().regex(/^[a-z0-9-]+$/),
    jobGroup: z.string().regex(/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/),
    actions: z
      .array(z.string().regex(/^[a-z0-9_]+$/))
      .min(1)
      .refine((actions) => new Set(actions).size === actions.length, "actions must not repeat"),
  })
  .strict();

export type RemediationConfig = z.infer<typeof RemediationConfigSchema>;

/** The allowlist shipped with the code; a change to it is a reviewed MR, never a VM edit. */
export const DEFAULT_REMEDIATION_CONFIG_PATH = new URL("./sentinel-remediation.json", import.meta.url);

/** @throws Error when the file is missing, not JSON, or not a valid allowlist. */
export function readRemediationConfig(path: string | URL): RemediationConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the remediation allowlist ${String(path)}: ${errorMessage(err)}`);
  }
  const parsed = RemediationConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the remediation allowlist ${String(path)} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

// -- Alert validation ---------------------------------------------------------

/** The parts of an Alertmanager webhook alert this path reads. */
export interface IncomingAlert {
  status?: unknown;
  labels?: unknown;
  startsAt?: unknown;
  fingerprint?: unknown;
}

export interface RemediationRequest {
  fingerprint: string;
  startsAt: string;
  alertName: string;
  action: string;
  target: string;
}

const AlertShape = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string()),
  startsAt: z.string().min(1),
  fingerprint: z.string(),
});

/** Whether an entry of a webhook's `alerts` array is a sentinel stage-1 alert. Safe on any JSON value. */
export function isRemediable(alert: unknown): alert is IncomingAlert {
  if (typeof alert !== "object" || alert === null || !("labels" in alert)) return false;
  const { labels } = alert;
  return typeof labels === "object" && labels !== null && "sentinel_class" in labels && labels.sentinel_class === REMEDIABLE_CLASS;
}

type Validation = { kind: "resolved" } | { kind: "invalid"; reason: string } | { kind: "valid"; request: RemediationRequest };

export function validateRemediation(alert: IncomingAlert, config: RemediationConfig): Validation {
  const shape = AlertShape.safeParse(alert);
  if (!shape.success) return { kind: "invalid", reason: `malformed alert: ${shape.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
  const { status, labels, startsAt, fingerprint } = shape.data;

  if (status === "resolved") return { kind: "resolved" };

  if (!FINGERPRINT_PATTERN.test(fingerprint)) return { kind: "invalid", reason: `fingerprint ${JSON.stringify(fingerprint)} is not a valid Alertmanager fingerprint` };
  if (Number.isNaN(Date.parse(startsAt))) return { kind: "invalid", reason: `startsAt ${JSON.stringify(startsAt)} is not a timestamp` };

  const action = labels.sentinel_action;
  if (action === undefined) return { kind: "invalid", reason: "sentinel_action label is missing" };
  if (!config.actions.includes(action)) {
    return { kind: "invalid", reason: `sentinel_action ${JSON.stringify(action)} is not in the allowlist (${config.actions.join(", ")})` };
  }

  const target = labels.sentinel_target;
  if (target === undefined) return { kind: "invalid", reason: "sentinel_target label is missing" };
  if (target.length > TARGET_MAX_CHARS || !TARGET_PATTERN.test(target)) {
    return { kind: "invalid", reason: `sentinel_target ${JSON.stringify(target)} does not match ${TARGET_PATTERN}` };
  }

  return { kind: "valid", request: { fingerprint, startsAt, alertName: labels.alertname ?? "unknown", action, target } };
}

// -- The remediator -----------------------------------------------------------

export type RemediationResult =
  | { status: "ignored_resolved" }
  | { status: "invalid"; reason: string }
  | { status: "duplicate"; record: RemediationRecord }
  | { status: "not_persisted"; reason: string }
  | { status: "started"; executionId: number }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string };

export interface RemediatorDeps {
  config: RemediationConfig;
  rundeck: RundeckClient;
  /** fingerprint → the latest episode's record; the caller loads it from the store. */
  records: Map<string, RemediationRecord>;
  /** Writes `records` to disk. @throws when it cannot. */
  persist: () => void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface Remediator {
  /** Handles one `remediable` alert. Never throws: every failure is logged and returned. */
  handle(alert: IncomingAlert): Promise<RemediationResult>;
}

/** A job definition that does not match the contract; the run is refused before it is asked for. */
class DefinitionMismatch extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkDefinition(options: RundeckJobOption[], target: string): void {
  const declared = new Map(options.map((option) => [option.name, option]));
  const undeclared = SENT_OPTIONS.filter((name) => !declared.has(name));
  if (undeclared.length > 0) throw new DefinitionMismatch(`the job does not declare option(s) ${undeclared.join(", ")}`);

  const targetOption = declared.get("target");
  if (!targetOption?.enforced || targetOption.values.length === 0) {
    throw new DefinitionMismatch("the job's target option is not an enforced value list");
  }
  if (!targetOption.values.includes(target)) {
    throw new DefinitionMismatch(`target ${target} is not one of the job's values (${targetOption.values.join(", ")})`);
  }
}

/** Refused: Rundeck or the definition said no. Failed: Rundeck could not be asked, or answered nonsense. */
function classify(err: unknown): { outcome: Extract<RemediationOutcome, "refused" | "failed">; reason: string } {
  if (err instanceof DefinitionMismatch) return { outcome: "refused", reason: err.message };
  if (err instanceof RundeckError && err.status >= 400 && err.status < 500) {
    return { outcome: "refused", reason: err.errorCode ? `${err.message} (${err.errorCode})` : err.message };
  }
  return { outcome: "failed", reason: errorMessage(err) };
}

export function createRemediator(deps: RemediatorDeps): Remediator {
  const { config, rundeck, records, persist, now = Date.now, log = (line: string) => console.error(line) } = deps;

  function describe(request: RemediationRequest): string {
    return `${config.jobGroup}/${request.action} target=${request.target} fingerprint=${request.fingerprint} (${request.alertName}, firing since ${request.startsAt})`;
  }

  /** Records the outcome; a failed write is logged, since the run itself already happened. */
  function settle(record: RemediationRecord): void {
    try {
      persist();
    } catch (err) {
      log(
        `[sentinel-remediation] ${record.outcome} ${record.action} for ${record.fingerprint} but could not persist it; ` +
          `after a restart a repeat of this alert may run again (the job's breaker still limits it): ${errorMessage(err)}`
      );
    }
  }

  async function remediate(request: RemediationRequest, record: RemediationRecord): Promise<RemediationResult> {
    try {
      const job = await rundeck.findJob(config.rundeckProject, config.jobGroup, request.action);
      checkDefinition(await rundeck.jobOptions(job.id), request.target);
      const execution = await rundeck.runJob(job.id, {
        target: request.target,
        fingerprint: request.fingerprint,
        incident: STAGE_ONE_INCIDENT,
      });

      record.outcome = "started";
      record.executionId = execution.id;
      record.executionUrl = execution.permalink;
      settle(record);
      log(`[sentinel-remediation] started ${describe(request)}: execution ${execution.id}${execution.permalink ? ` ${execution.permalink}` : ""}`);
      return { status: "started", executionId: execution.id };
    } catch (err) {
      const { outcome, reason } = classify(err);
      record.outcome = outcome;
      record.detail = reason;
      settle(record);
      log(`[sentinel-remediation] ${outcome} ${describe(request)}, not retried for this episode: ${reason}`);
      return { status: outcome, reason };
    }
  }

  return {
    async handle(alert) {
      try {
        const validation = validateRemediation(alert, config);
        if (validation.kind === "resolved") return { status: "ignored_resolved" };
        if (validation.kind === "invalid") {
          log(`[sentinel-remediation] skipped a remediable alert: ${validation.reason}`);
          return { status: "invalid", reason: validation.reason };
        }

        const { request } = validation;
        const previous = records.get(request.fingerprint);
        if (previous && previous.startsAt === request.startsAt) return { status: "duplicate", record: previous };

        // Claimed and written before the first call to Rundeck, and synchronously, so neither a
        // concurrent delivery nor a restart mid-call can start a second run for this episode.
        const record: RemediationRecord = {
          ...request,
          claimedAt: now(),
          outcome: "claimed",
          executionId: undefined,
          executionUrl: undefined,
          detail: undefined,
        };
        records.set(request.fingerprint, record);
        try {
          persist();
        } catch (err) {
          // Nothing was asked of Rundeck, so the next re-notification may try again
          if (previous) records.set(request.fingerprint, previous);
          else records.delete(request.fingerprint);
          const reason = `could not persist the claim, so nothing was run: ${errorMessage(err)}`;
          log(`[sentinel-remediation] skipped ${describe(request)}: ${reason}`);
          return { status: "not_persisted", reason };
        }

        return await remediate(request, record);
      } catch (err) {
        // The last line of defence: an alert must never take the webhook channel down
        const reason = `unexpected error: ${errorMessage(err)}`;
        log(`[sentinel-remediation] ${reason}`);
        return { status: "failed", reason };
      }
    },
  };
}
