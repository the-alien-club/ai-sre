// Raw alert payload retention (plan §5d).
//
// Every alert pushed to the session is kept, as received, for 7 days under
// data/alert-payloads/<fingerprint>/<received ms>-<status>.json. The learning loop (plan P2)
// compares a runbook proposal against the raw payload of its incident, so that text an
// attacker put in an alert cannot be laundered into a trusted KEDB entry.
//
// Retention must never cost an alert its delivery: retain() never rejects, is bounded, and its
// failures are logged. The fingerprint comes from the sender, so it only names a directory
// when it is a plain token; anything else is hashed. Payloads can carry secrets in labels or
// annotations, so files are 0600 in 0700 directories, and are never logged.

import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AlertmanagerAlert } from "./alert-delivery.js";
import { withTimeout } from "./with-timeout.js";

export const ALERT_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on retained files, whatever their age: a flood of alerts must not fill the disk. */
export const ALERT_PAYLOAD_MAX_FILES = 20_000;
/** Pruning walks the whole directory, so it runs at most this often. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const RETAIN_TIMEOUT_MS = 5 * 1000;
const PRUNE_TIMEOUT_MS = 60 * 1000;

const SAFE_FINGERPRINT = /^[A-Za-z0-9_-]{1,128}$/;

export interface AlertPayloadStoreOptions {
  /** Usually <data>/alert-payloads. Created on first write. */
  dir: string;
  retentionMs?: number;
  maxFiles?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface AlertPayloadStore {
  /** Keeps one alert. Never rejects. */
  retain(alert: AlertmanagerAlert, groupStatus: string): Promise<void>;
  /** Deletes files past retention, then the oldest beyond the cap. Never rejects. */
  prune(): Promise<void>;
}

/** The directory name for a fingerprint: itself when it is a plain token, else a hash. */
export function fingerprintDir(fingerprint: string | undefined): string {
  const fp = fingerprint ?? "";
  if (SAFE_FINGERPRINT.test(fp)) return fp;
  return `h-${createHash("sha256").update(fp).digest("hex").slice(0, 32)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAlertPayloadStore(options: AlertPayloadStoreOptions): AlertPayloadStore {
  const { dir, retentionMs = ALERT_PAYLOAD_RETENTION_MS, maxFiles = ALERT_PAYLOAD_MAX_FILES, now = Date.now, log = (line) => console.error(line) } = options;
  let lastPruneAt = Number.NEGATIVE_INFINITY;
  let pruning: Promise<void> | undefined;
  let sequence = 0;

  async function write(alert: AlertmanagerAlert, groupStatus: string): Promise<void> {
    const receivedAt = now();
    const fpDir = join(dir, fingerprintDir(alert.fingerprint));
    await mkdir(fpDir, { recursive: true, mode: 0o700 });
    const status = alert.status === "resolved" ? "resolved" : "firing";
    // The sequence keeps two copies received in the same millisecond apart.
    const name = `${receivedAt}-${String(sequence++ % 1000).padStart(3, "0")}-${status}.json`;
    const path = join(fpDir, name);
    const temp = `${path}.tmp`;
    const record = { received_at: new Date(receivedAt).toISOString(), group_status: groupStatus, alert };
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
      await rename(temp, path);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async function pruneNow(): Promise<void> {
    let fingerprints: string[];
    try {
      fingerprints = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    const cutoff = now() - retentionMs;
    const kept: Array<{ path: string; mtimeMs: number }> = [];
    for (const fp of fingerprints) {
      const fpDir = join(dir, fp);
      let names: string[];
      try {
        names = await readdir(fpDir);
      } catch {
        continue; // not a directory, or gone since the listing
      }
      for (const name of names) {
        const path = join(fpDir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) await unlink(path);
          else kept.push({ path, mtimeMs: info.mtimeMs });
        } catch (err) {
          // A file renamed into place or pruned since the listing is not an error.
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      // Removes the directory once empty. ENOTEMPTY is the normal case, and also what protects
      // a payload a concurrent retain() has just written.
      try {
        await rmdir(fpDir);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw err;
      }
    }

    if (kept.length > maxFiles) {
      kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const excess = kept.slice(0, kept.length - maxFiles);
      for (const { path } of excess) await unlink(path);
      log(`[alert-payloads] over the ${maxFiles}-file cap: deleted the ${excess.length} oldest payloads before their 7 days`);
    }
  }

  async function prune(): Promise<void> {
    if (pruning) return pruning;
    lastPruneAt = now();
    pruning = withTimeout(pruneNow(), PRUNE_TIMEOUT_MS, "alert payload pruning")
      .catch((err: unknown) => log(`[alert-payloads] pruning ${dir} failed: ${errorMessage(err)}`))
      .finally(() => {
        pruning = undefined;
      });
    return pruning;
  }

  return {
    async retain(alert, groupStatus) {
      try {
        await withTimeout(write(alert, groupStatus), RETAIN_TIMEOUT_MS, "alert payload retention");
      } catch (err) {
        // Not fatal: the alert is still delivered. The log names the fingerprint only, never
        // the payload, which can hold secrets.
        log(`[alert-payloads] could not keep the payload of ${JSON.stringify(alert.fingerprint)}: ${errorMessage(err)}`);
      }
      // Not awaited: pruning can take a while and never affects this alert.
      if (now() - lastPruneAt >= PRUNE_INTERVAL_MS) void prune();
    },
    prune,
  };
}
