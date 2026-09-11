# Daily Summary

Generate an end-of-day summary of all incidents and post it to the team channel on Slack.

## When to use

At the end of the day (or when an operator asks for a status update).

## Procedure

1. Generate the briefing: `./scripts/incidents.sh briefing --days 1`
2. Get patterns: `./scripts/incidents.sh patterns --days 1`
3. Compose a Slack message with the `reply` tool:

```
:clipboard: *SRE Daily Summary*

*Alerts processed:* <total> | <noise> noise | <real> real | <auto-fixed> auto-fixed | <escalated> escalated

*Auto-fixed:*
- <list each auto-fix with brief cause and what was done>

*Escalated:*
- <list each escalation with status: acknowledged/pending>

*Noise:*
- <top noisy alerts with fire count>

*Cluster health:* <one-line summary per cluster>

*Recommendation:* <any tuning suggestions or follow-ups needed>
```

4. If there are recurring noise patterns that haven't been reported yet, invoke `/noise-report`

## Important

- Keep it concise — people read this on their phone
- Focus on what matters: real incidents, pending escalations, trends
- Don't list every single noise alert — group them by type
