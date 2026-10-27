// What the escalate tool and the nag loop refuse to handle.
//
// Trivy findings are posted by trivy-webhook.ts itself: the daily digest with no mention,
// and an exposed secret with exactly one page. Neither may enter the nag loop, which is
// what turned a CVE backlog into 16 threads nagged 8-12 times each on 2026-10-26/27. The
// channel instructions say so, and this makes it hold even if the agent escalates anyway,
// or a Trivy escalation persisted before this change is restored from disk.

const TRIVY = /^trivy[-_ ]|\btrivy\b/i;

/** Whether an escalation is about a Trivy finding, by its fingerprint or its alert name. */
export function isTrivyEscalation(alertFingerprint: string, alertName: string): boolean {
  return TRIVY.test(alertFingerprint) || TRIVY.test(alertName);
}

/** The escalate tool's answer to a Trivy escalation, as an error the agent can act on. */
export const TRIVY_ESCALATION_REFUSED =
  "escalate refused: Trivy findings are posted by the trivy-webhook channel itself (CVEs as one daily digest, " +
  "an exposed secret paged once) and never enter the nag loop. Answer in the thread_ts the secret event gave you, " +
  "with the reply tool.";
