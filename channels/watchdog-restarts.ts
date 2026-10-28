// The session watchdog's restarts, as GET /health/session reports them.
//
// scripts/session-watchdog.sh (a systemd timer, provision/systemd/) restarts the agent when
// /health/session has been non-200 for more than 5 min, at most twice an hour. It records
// each restart in a `last_restart` file in its state directory:
//
//   {"last_restart_at":"<ISO>","restarts_last_hour":N,"restarts":["<ISO>",...]}
//
// `restarts` holds the restarts of the hour before the last one was written. The count this
// returns is recomputed from it against the current time, so a restart that is now more than
// an hour old no longer counts, however long ago the file was written.
//
// These fields are added to the /health/session body, beside the heartbeat's own; they never
// change its HTTP status, which sentinel's `sre_agent` hop reads.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SessionHealth, SessionHealthBody } from "./session-heartbeat.js";

/** Where the watchdog's systemd unit keeps its state (StateDirectory=sre-agent-watchdog). */
export const DEFAULT_WATCHDOG_LAST_RESTART_PATH = "/var/lib/sre-agent-watchdog/last_restart";

/** The watchdog's cap is per rolling hour; so is this count. */
export const RESTART_COUNT_PERIOD_MS = 60 * 60 * 1000;

export interface WatchdogRestarts {
  /** The last restart, or null when none is recorded (or the record could not be read). */
  last_restart_at: string | null;
  /** Restarts in the last hour: 0 when none is recorded, null when the record could not be read. */
  restarts_last_hour: number | null;
}

const IsoTime = z.string().datetime();
const LastRestartRecord = z.object({
  last_restart_at: IsoTime,
  restarts_last_hour: z.number().int().nonnegative(),
  restarts: z.array(IsoTime),
});

export interface WatchdogRestartsDeps {
  path: string;
  now?: () => number;
  log?: (line: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/**
 * Reads the record. Never rejects: no record is "no restart", and an unreadable or malformed
 * one is logged and reported as null, so the probe still answers and the problem is visible.
 */
export function createWatchdogRestartsReader(deps: WatchdogRestartsDeps): () => Promise<WatchdogRestarts> {
  const { path, now = Date.now, log = (line: string) => console.error(line) } = deps;

  return async () => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      if (isMissingFile(err)) return { last_restart_at: null, restarts_last_hour: 0 };
      log(`[signoz-webhook] could not read the watchdog's restart record ${path}: ${errorMessage(err)}`);
      return { last_restart_at: null, restarts_last_hour: null };
    }

    let parsed: z.infer<typeof LastRestartRecord>;
    try {
      parsed = LastRestartRecord.parse(JSON.parse(text));
    } catch (err) {
      log(`[signoz-webhook] the watchdog's restart record ${path} is malformed: ${errorMessage(err)}`);
      return { last_restart_at: null, restarts_last_hour: null };
    }

    const at = now();
    // A restart stamped in the future (the clock stepped back) still counts, as it does for
    // the watchdog's own cap
    const restartsLastHour = parsed.restarts.filter((iso) => at - Date.parse(iso) < RESTART_COUNT_PERIOD_MS).length;
    return { last_restart_at: parsed.last_restart_at, restarts_last_hour: restartsLastHour };
  };
}

export interface SessionHealthWithRestarts {
  httpStatus: SessionHealth["httpStatus"];
  body: SessionHealthBody & WatchdogRestarts;
}

/** What GET /health/session answers: the heartbeat's status and body, plus the restarts. */
export function withWatchdogRestarts(health: SessionHealth, restarts: WatchdogRestarts): SessionHealthWithRestarts {
  return { httpStatus: health.httpStatus, body: { ...health.body, ...restarts } };
}
