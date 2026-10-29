// SRE_KEDB_APPROVERS: the only Slack users whose "yes" applies a runbook (KEDB) change.
//
// Separate from SRE_OPERATORS on purpose: any operator may approve a tool call, but a change
// to what the agent believes about alerts is Leo's alone today (plan §4). Every approver must
// also be an operator, since slack-sre drops every other sender before a reply is classified.

import type { OperatorRoster } from "./operators.js";

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/**
 * Parses "U1,U2" into user id → display name (from the operator roster).
 * @throws Error on a malformed id, an id that is not an operator, or an empty list.
 */
export function parseApprovers(raw: string, operators: OperatorRoster): Map<string, string> {
  const approvers = new Map<string, string>();
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (!id) continue;
    if (!SLACK_USER_ID.test(id)) throw new Error(`SRE_KEDB_APPROVERS entry "${id}" is not a Slack user ID`);
    const name = operators.get(id);
    if (name === undefined) throw new Error(`SRE_KEDB_APPROVERS entry ${id} is not in SRE_OPERATORS; the channel would never see their replies`);
    approvers.set(id, name);
  }
  if (approvers.size === 0) throw new Error("SRE_KEDB_APPROVERS is empty: at least one approver is required");
  return approvers;
}
