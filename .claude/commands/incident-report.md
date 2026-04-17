# Incident Report

Generate a structured incident report when an incident is resolved and publish it to Notion.

## When to use

After an incident is fully resolved — meaning:
- The alert has stopped firing (or was a one-time event)
- The fix has been verified (auto-fix confirmed, or CTO confirmed resolution)
- There's enough context in the investigation trail to write a meaningful report

## Procedure

1. Gather all data for the incident. Spawn a sub-agent with this prompt:

```
You are a sub-agent compiling an incident report. Do the work directly.

Gather all information for this incident:
- Fingerprint: <fingerprint>

Run these commands:
1. ./scripts/incidents.sh timeline --fp "<fingerprint>"
   This gives you the full incident log entries AND investigation context notes.

2. ./scripts/incidents.sh check --alert "<alert_name>" --days 30
   This shows if this alert has a history of firing.

Compile everything into this report structure:

## Incident Report: <Alert Name> on <Service/Cluster>

**Date**: <when it fired>
**Duration**: <from firing to resolution>
**Severity**: <critical/warning/info>
**Environment**: <dev/staging/prod>
**Fingerprint**: <fingerprint>

### Summary
One paragraph: what happened, what was the impact, how it was resolved.

### Timeline
Chronological list of events:
- [timestamp] Alert fired: <details>
- [timestamp] Investigation started: <what was checked>
- [timestamp] Root cause identified: <what was found>
- [timestamp] Action taken: <what was done>
- [timestamp] Resolution confirmed: <how it was verified>

### Root Cause
What actually caused the issue. Be specific — name the component, the commit,
the config change, the resource constraint.

### Resolution
What fixed it. Include exact commands run or changes made.

### Impact
- Services affected
- Duration of impact
- Data loss (if any)
- User-facing impact (if any)

### Action Items
Follow-up work needed to prevent recurrence:
- [ ] <specific action> — e.g., "Increase memory limit for backend pods"
- [ ] <specific action> — e.g., "Add integration test for cache bounds"
- [ ] <specific action> — e.g., "Tune alert threshold from 5% to 10%"

### Lessons Learned
What we'd do differently next time. What worked well.

Return the full report as markdown.
```

2. Read the sub-agent's report.

3. Publish to Notion using the MCP:
   - Create a page in the Knowledge Base (collection://f04d749f-502c-42c9-905c-cb4d201dbfcf)
   - Title: "Incident Report: <Alert Name> — <Date>"
   - Content: the full report markdown
   - If the Notion MCP is not available, save the report locally to `data/reports/<fingerprint>.md`

4. Post a summary to Slack (reply tool):
```
:page_facing_up: *Incident Report Filed*

*Alert:* <name>
*Duration:* <X minutes/hours>
*Root cause:* <one line>
*Resolution:* <one line>
*Action items:* <count>

Full report: <Notion link or local path>
```

## Context trail — how sub-agents should save context

During investigation, sub-agents should save context notes at each phase:

```bash
# During triage
./scripts/incidents.sh context --fp "<fingerprint>" --phase triage \
  --content "Alert fired at 14:30. Checking pod health on platform-dev."

# During investigation
./scripts/incidents.sh context --fp "<fingerprint>" --phase investigation \
  --content "kubectl shows pod backend-xyz in CrashLoopBackOff. 4 restarts in 10 min. Last exit code 137 (OOMKilled)."

# During diagnosis
./scripts/incidents.sh context --fp "<fingerprint>" --phase diagnosis \
  --content "MR !432 merged 18 min before alert. Introduces unbounded in-memory cache. Memory usage jumped from 400Mi to 1.8Gi."

# During fix
./scripts/incidents.sh context --fp "<fingerprint>" --phase fix \
  --content "Executed: kubectl rollout restart deployment/backend -n backend --context platform-dev"

# During verification
./scripts/incidents.sh context --fp "<fingerprint>" --phase verification \
  --content "New pods 2/2 ready. Memory stable at 420Mi. Error rate back to 0%. Fix confirmed."

# Resolution summary
./scripts/incidents.sh context --fp "<fingerprint>" --phase resolution \
  --content "Root cause: MR !432 unbounded cache. Fixed by pod restart. MR needs revert or fix-forward. Escalated to CTO."
```

The incident reporter reads all these notes to build the timeline and narrative.