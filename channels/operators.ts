// The operator roster (SRE_OPERATORS): the only people the agent listens to, the only ones
// who may approve its tool use, and the people a page @-mentions.
//
// Shared by slack-sre.ts (which gates and pages) and trivy-webhook.ts (which pages once for
// an exposed secret), so both read the same variable the same way.

/** Slack user ID -> display name, in roster order. */
export type OperatorRoster = Map<string, string>;

/**
 * Parse "<slack_user_id>:<display_name>" entries, comma-separated. The display name is
 * carried so the agent can address people by name without the users:read scope.
 * @throws Error on a malformed entry or an empty roster, never a partial result.
 */
export function parseOperators(raw: string): OperatorRoster {
  const operators: OperatorRoster = new Map();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(
        `SRE_OPERATORS entry "${trimmed}" is malformed — expected "<slack_user_id>:<display_name>"`
      );
    }

    const userId = trimmed.slice(0, separator).trim();
    const displayName = trimmed.slice(separator + 1).trim();
    if (!userId || !displayName) {
      throw new Error(
        `SRE_OPERATORS entry "${trimmed}" is malformed — both user ID and display name are required`
      );
    }

    operators.set(userId, displayName);
  }

  if (operators.size === 0) {
    throw new Error("SRE_OPERATORS is empty — at least one operator is required");
  }

  return operators;
}

/** The mention string that pages every operator, e.g. "<@U1> <@U2>". */
export function operatorMentions(operators: OperatorRoster): string {
  return [...operators.keys()].map((id) => `<@${id}>`).join(" ");
}

/** "Leo (U1), Adrien (U2)", for the agent's instructions and startup logs. */
export function operatorRoster(operators: OperatorRoster): string {
  return [...operators.entries()].map(([id, name]) => `${name} (${id})`).join(", ");
}
