// Reads one incident from incidents.db, for the KEDB learning loop.
//
// A runbook proposal names an incident and the fingerprint of its alert. The loop checks that
// the two belong together before anything else, because on 2026-10-29 the agent, refused for
// lack of a raw payload, set out to retry with a different incident's fingerprint: the check
// would have passed against the wrong alert, and the lesson been filed under the wrong
// incident. Bound to incidents.db, a fingerprint can only be the one its incident was logged
// with.
//
// Through the sqlite3 CLI, as incidents.sh does, so this works the same under bun (the VM)
// and node (the tests). Read-only, bounded, and the id is digits only, so it is never SQL.

import { runProcess } from "./kedb-git.js";

const INCIDENT_ID = /^[0-9]{1,9}$/;

export interface IncidentRecord {
  id: string;
  /** Null when the incident was logged without --fingerprint (stored as '' or NULL). */
  fingerprint: string | null;
  alertName: string;
  createdAt: string;
}

export interface IncidentLookup {
  /**
   * The incident, or null when incidents.db has no such id.
   * @throws when the database cannot be read: the caller must fail closed.
   */
  find(id: string): Promise<IncidentRecord | null>;
}

export interface IncidentLookupOptions {
  dbPath: string;
  timeoutMs: number;
  /** The sqlite3 binary; the tests may point it elsewhere. */
  sqlite3?: string;
}

interface Row {
  id: number;
  fingerprint: string | null;
  alert_name: string;
  created_at: string;
}

function isRow(value: unknown): value is Row {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "number" &&
    (typeof row.fingerprint === "string" || row.fingerprint === null) &&
    typeof row.alert_name === "string" &&
    typeof row.created_at === "string"
  );
}

export function createIncidentLookup(options: IncidentLookupOptions): IncidentLookup {
  const { dbPath, timeoutMs, sqlite3 = "sqlite3" } = options;
  return {
    async find(id) {
      if (!INCIDENT_ID.test(id)) throw new Error(`incident id '${id}' is not a number`);
      const sql = `SELECT id, fingerprint, alert_name, created_at FROM incidents WHERE id = ${Number(id)};`;
      const result = await runProcess(sqlite3, ["-readonly", "-json", dbPath, sql], { cwd: "/", timeoutMs });
      if (result.code !== 0) {
        throw new Error(`cannot read incidents.db (${dbPath}): ${result.stderr.trim().slice(0, 300) || `sqlite3 exited ${result.code}`}`);
      }
      // sqlite3 -json prints nothing at all for an empty result
      if (result.stdout.trim() === "") return null;
      let rows: unknown;
      try {
        rows = JSON.parse(result.stdout);
      } catch (err) {
        throw new Error(`incidents.db answered something that is not JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(rows) || rows.length !== 1 || !isRow(rows[0])) {
        throw new Error(`incidents.db answered an unexpected shape for incident ${id}`);
      }
      const row = rows[0];
      // incidents.sh stores a missing --fingerprint as '', older rows may hold NULL: both are none
      const fingerprint = row.fingerprint === null || row.fingerprint === "" ? null : row.fingerprint;
      return { id: String(row.id), fingerprint, alertName: row.alert_name, createdAt: row.created_at };
    },
  };
}
