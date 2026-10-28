// Session heartbeat: proof that the whole loop answers, not just that a port is open.
//
// GET /health says the channel's HTTP listener is up. That stays true while the Claude session
// behind it is wedged, rate-limited, stuck compacting or waiting on a prompt, which is exactly
// when an alert pushed to it goes nowhere. So the channel asks the session a question it can
// only answer by working end to end: every HEARTBEAT_INTERVAL_MS it pushes `heartbeat <nonce>`,
// and the session answers by calling the `heartbeat_ack` tool with that nonce
// (channel → session → MCP tool call → channel). GET /health/session reports how long ago it
// last did.
//
// This is a round trip on purpose (CLAUDE_ERROR_PATTERNS.md §14): a liveness signal the
// channel produced on its own would keep flowing while the session made no progress.
//
// The contract sentinel's `sre_agent` hop probes is fixed: the path /health/session, 200 when
// the last ack is younger than SESSION_MAX_AGE_MS and 503 otherwise (including before the
// first ack), and a JSON body whose `age_seconds` it reads. Keep all three stable.

import { randomUUID } from "node:crypto";

/** How often the channel asks. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** The first heartbeat, once the session has had time to start. */
export const HEARTBEAT_FIRST_DELAY_MS = 60 * 1000;
/** One missed ack is tolerated (a long turn); two are not. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 1000;
/** A nonce is accepted for two intervals after it was sent, never longer. */
export const NONCE_MAX_AGE_MS = 2 * HEARTBEAT_INTERVAL_MS;

/** The tool the session answers with. */
export const HEARTBEAT_ACK_TOOL = "heartbeat_ack";

export interface SessionHealthBody {
  status: "ok" | "stale" | "never_acked";
  last_ack_at: string | null;
  age_seconds: number | null;
  max_age_seconds: number;
  heartbeat_interval_seconds: number;
}

export interface SessionHealth {
  httpStatus: 200 | 503;
  body: SessionHealthBody;
}

export type AckResult = { ok: true } | { ok: false; error: string };

/** Cancels a scheduled callback. */
export type Cancel = () => void;

export interface SessionHeartbeatDeps {
  /** Pushes one channel notification to the session. Must be bounded; rejects when it failed. */
  push: (content: string, meta: Record<string, string>) => Promise<void>;
  now?: () => number;
  newNonce?: () => string;
  /** Runs `callback` once after `delayMs`. Injected so tests never wait on a real 5-min timer. */
  schedule?: (callback: () => void, delayMs: number) => Cancel;
  log?: (line: string) => void;
  intervalMs?: number;
  firstDelayMs?: number;
  maxAgeMs?: number;
}

export interface SessionHeartbeat {
  /** Schedules the first heartbeat, then one every interval until stop(). */
  start(): void;
  stop(): void;
  /** Sends one heartbeat now. Never rejects: a failed push is logged, and the probe shows it. */
  beat(): Promise<void>;
  /** The heartbeat_ack tool. Never throws: an unknown or expired nonce is an error result. */
  ack(nonce: unknown): AckResult;
  /** What GET /health/session answers. */
  health(): SessionHealth;
}

interface SentNonce {
  nonce: string;
  sentAt: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function realSchedule(callback: () => void, delayMs: number): Cancel {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export function createSessionHeartbeat(deps: SessionHeartbeatDeps): SessionHeartbeat {
  const {
    push,
    now = Date.now,
    newNonce = randomUUID,
    schedule = realSchedule,
    log = (line: string) => console.error(line),
    intervalMs = HEARTBEAT_INTERVAL_MS,
    firstDelayMs = HEARTBEAT_FIRST_DELAY_MS,
    maxAgeMs = SESSION_MAX_AGE_MS,
  } = deps;
  const nonceMaxAgeMs = 2 * intervalMs;

  let pending: SentNonce | undefined;
  let previous: SentNonce | undefined;
  let lastAck: { nonce: string; at: number } | undefined;
  let cancel: Cancel | undefined;
  // Bumped by start() and stop(), so a beat still in flight from a stopped run never
  // schedules into a newer one.
  let generation = 0;

  async function beat(): Promise<void> {
    const nonce = newNonce();
    previous = pending;
    pending = { nonce, sentAt: now() };
    try {
      await push(`heartbeat ${nonce}`, { kind: "heartbeat", nonce });
    } catch (err) {
      // The nonce stays pending: the notification may have arrived anyway. If the session is
      // really unreachable, no ack comes and /health/session goes stale on its own.
      log(`[session-heartbeat] could not push heartbeat ${nonce}: ${errorMessage(err)}`);
    }
  }

  function scheduleNext(run: number, delayMs: number): void {
    cancel = schedule(() => {
      // beat() never rejects; the next one is scheduled only once this one is done, so two
      // can never overlap.
      void beat().then(() => {
        if (run === generation) scheduleNext(run, intervalMs);
      });
    }, delayMs);
  }

  function isAcceptable(sent: SentNonce | undefined, nonce: string, at: number): boolean {
    return sent !== undefined && sent.nonce === nonce && at - sent.sentAt <= nonceMaxAgeMs;
  }

  return {
    start() {
      if (cancel !== undefined) return;
      generation++;
      scheduleNext(generation, firstDelayMs);
    },

    stop() {
      generation++;
      cancel?.();
      cancel = undefined;
    },

    beat,

    ack(nonce) {
      if (typeof nonce !== "string" || nonce.length === 0) return { ok: false, error: "unknown nonce: nonce must be a non-empty string" };
      const at = now();
      if (!isAcceptable(pending, nonce, at) && !isAcceptable(previous, nonce, at)) {
        return {
          ok: false,
          error: `unknown nonce ${nonce}: only the last two heartbeats are accepted, for ${nonceMaxAgeMs / 60_000} min after they were sent`,
        };
      }
      lastAck = { nonce, at };
      return { ok: true };
    },

    health() {
      const common = { max_age_seconds: maxAgeMs / 1000, heartbeat_interval_seconds: intervalMs / 1000 };
      if (lastAck === undefined) {
        return { httpStatus: 503, body: { status: "never_acked", last_ack_at: null, age_seconds: null, ...common } };
      }
      const ageMs = now() - lastAck.at;
      const fresh = ageMs < maxAgeMs;
      return {
        httpStatus: fresh ? 200 : 503,
        body: {
          status: fresh ? "ok" : "stale",
          last_ack_at: new Date(lastAck.at).toISOString(),
          age_seconds: Math.floor(ageMs / 1000),
          ...common,
        },
      };
    },
  };
}
