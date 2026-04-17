# Noise Report

Generate an alert tuning proposal for the CTO when recurring noise is detected.

## When to use

After reading the startup briefing or after a sub-agent reports noise for an alert that
has already been noise 3+ times in the last 7 days.

## Procedure

1. Run `./scripts/incidents.sh patterns --days 7` to get the full picture
2. For each alert with noise count >= 3, gather:
   - Alert name and how many times it fired as noise
   - The typical cause (from incident logs): `./scripts/incidents.sh check --alert "<name>"`
   - The SigNoz alert rule details: use `signoz_get_alert` MCP tool if available, or note the alert name
3. For each noisy alert, propose a concrete fix:
   - Transient spikes → increase eval window or switch to anomaly detection
   - Test tenant noise → add namespace exclusion filter
   - Known service behavior → exclude the service or adjust threshold
   - Flapping (fires and resolves within minutes) → add a minimum duration / "for" clause
4. Send ONE Slack message to the CTO (use the `reply` tool) with all proposals grouped together:

```
:wrench: *Alert Tuning Report*

The following alerts have been firing as noise repeatedly. Each one buries real signal
and wastes investigation time. Proposed fixes:

*1. High Latency on openaire-test* (12x in 7 days, always noise)
   Cause: Transient P99 spikes, self-resolve in <10 min
   Proposal: Increase eval window from 10m to 20m, or switch to anomaly detection
   Rule: <alert name or ID>

*2. Tenant Inactive on tenant-test-** (8x in 7 days, known issue)
   Cause: Test tenant heartbeat 401s
   Proposal: Add filter to exclude namespaces matching `tenant-test-*`
   Rule: <alert name or ID>

_Fixing these would eliminate ~20 false investigations per week._
```

5. Track that you've already reported these — don't report the same noisy alerts again
   in the same session.

## Important

- Only report each noisy alert ONCE per restart cycle
- Use `reply` not `escalate` — this is a suggestion, not an emergency
- Be specific in proposals — "fix the alert" is useless, "raise threshold to X" is actionable
- Include an estimate of how many false investigations it would eliminate
