# Log Incident

Log an incident to the SQLite database. Used by sub-agents after investigation, or
by the main agent for manual logging.

## Usage

```bash
./scripts/incidents.sh log \
  --alert "Alert Name" \
  --severity "critical|warning|info" \
  --status "firing|resolved" \
  --cluster "kubectl-context" \
  --service "service-name" \
  --verdict "real|noise|false_positive|known_issue|flapping" \
  --action "auto_fixed|escalated|ignored|monitoring" \
  --cause "Brief root cause description"
```

## Optional flags

```bash
  --namespace "k8s-namespace"
  --resolution "What fixed it"
  --related-mr "https://gitlab.com/.../merge_requests/123"
  --notes "Free-form notes"
  --duration "Investigation duration in seconds"
```

## Verdict values

| Verdict | When to use |
|---|---|
| `real` | Genuine incident requiring action |
| `noise` | Alert fired but nothing was actually wrong (transient blip) |
| `false_positive` | Alert logic is wrong — the condition it checks doesn't match reality |
| `known_issue` | Real but pre-existing and documented (e.g., tenant-test heartbeats) |
| `flapping` | Fires and resolves repeatedly in short succession |

## Action values

| Action | When to use |
|---|---|
| `auto_fixed` | Agent fixed it autonomously (pod restart, workflow clear, etc.) |
| `escalated` | Sent to CTO via Slack |
| `ignored` | No action needed (noise, resolved, known issue) |
| `monitoring` | Real but not actionable yet — watching for escalation |

## Marking escalations as resolved

When the CTO confirms a fix for an escalated incident:
```bash
./scripts/incidents.sh resolve --id <incident_id> --resolution "What fixed it"
```