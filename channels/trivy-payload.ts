// Validation of the Trivy Operator webhook payloads this channel acts on.
//
// The body is untrusted until checked: a truncated or partial CR (or an operator upgrade
// that drops a field) must be answered with a 400, never crash the handler of the only
// process that pages for exposed secrets.

import { z } from "zod";

const Metadata = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  labels: z.record(z.string()).optional(),
});

const Artifact = z.object({
  repository: z.string().min(1),
  tag: z.string().optional(),
  digest: z.string().optional(),
});

export const VulnerabilityReportPayload = z.object({
  kind: z.literal("VulnerabilityReport"),
  metadata: Metadata,
  report: z.object({
    artifact: Artifact,
    vulnerabilities: z
      .array(
        z.object({
          vulnerabilityID: z.string(),
          resource: z.string(),
          installedVersion: z.string(),
          fixedVersion: z.string().optional(),
          severity: z.string(),
        })
      )
      .default([]),
  }),
});

export const ExposedSecretReportPayload = z.object({
  kind: z.literal("ExposedSecretReport"),
  metadata: Metadata,
  report: z.object({
    artifact: Artifact,
    secrets: z
      .array(
        z.object({
          ruleID: z.string(),
          category: z.string(),
          severity: z.string(),
          title: z.string(),
          target: z.string(),
        })
      )
      .default([]),
  }),
});

export type VulnerabilityReport = z.infer<typeof VulnerabilityReportPayload>;
export type ExposedSecretReport = z.infer<typeof ExposedSecretReportPayload>;
export type ReportMetadata = z.infer<typeof Metadata>;

/** The workload a report is about, as trivy-operator labels it. */
export function workloadOf(metadata: ReportMetadata): string {
  return metadata.labels?.["trivy-operator.resource.name"] ?? metadata.name;
}

/** A readable reason a payload was rejected, for the 400 and the log. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
