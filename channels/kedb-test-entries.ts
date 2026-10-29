// KEDB entry fixtures for the learning-loop tests: the Falco family, and the shell-history
// signature entry before and after the KB-1 change of plan §7 (a new benign cause that lowers
// a verified match from page to fyi).

export const FALCO_FAMILY = `---
id: falco/_family
kind: family
status: active
security: true
match:
  alertname: ["Falco Suspicious Process", "/Falco/"]
default:
  verdict: real
  action: page
updated: 2026-10-29
updated_by: test
---
# Playbook: Falco

Treat every Falco event as security relevant.
`;

const HEAD = `---
id: falco/delete-or-rename-shell-history
kind: signature
family: falco/_family
status: active
security: true
match:
  alertname: ["Falco Suspicious Process"]
  labels:
    rule: "Delete or rename shell history"
default:
  verdict: real
  action: page
`;

const TAIL = `auto_fix: null
false_trails:
  - "Do not call it SSH: the parent is login on ttyS0."
evidence:
  - incident: "3501"
related_changes:
  - "k8s-charts !106"
incidents: ["3501"]
updated: 2026-10-29
updated_by: test
---
## Symptoms

Falco reports a shell history rewrite on a node.

## Verification (read-only)

Read the node journal.

## Known benign causes

None recorded yet.

## When it is real

Any other parent than login on ttyS0.

## False trails

Not SSH.

## History

2026-10-28: first seen.
`;

export const HISTORY_ENTRY = `${HEAD}benign_causes: []
${TAIL}`;

export const KAPSULE_CAUSE = `benign_causes:
  - id: kapsule-serial-console-agent-update
    summary: Kapsule logs in over the serial console to update scw-k8s-agent.
    signature:
      user.name: ubuntu
      proc.pname: login
      proc.tty: 1088
    corroboration:
      - id: serial-login
        check: "node journal: pam_unix(login:session) opens a session for ubuntu on ttyS0"
        runner: operator
      - id: short-session
        check: "node journal: the session closes within 30 s"
        runner: operator
    verdict_if_verified: known_issue
    action_if_verified: fyi
    action_if_signature_only: escalate
`;

/** The KB-1 change: the Kapsule serial-console cause, verified → fyi. A downgrade. */
export const HISTORY_WITH_CAUSE = `${HEAD}${KAPSULE_CAUSE}${TAIL}`;

/** Replaces `from` with `to` in an entry, failing loudly when `from` is absent. */
export function edit(entry: string, from: string, to: string): string {
  if (!entry.includes(from)) throw new Error(`fixture edit: ${JSON.stringify(from)} not found`);
  return entry.replace(from, to);
}
