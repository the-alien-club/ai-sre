# Check Incident History

Query the incident database for past occurrences of an alert or fingerprint.

## Usage

Use this before or during an investigation to understand if an alert is recurring,
what the previous diagnosis was, and what fixed it last time.

## Commands

```bash
# Check by alert name (most common)
./scripts/incidents.sh check --alert "High Error Rate" --cluster platform-dev --days 7

# Check by fingerprint (exact same alert instance)
./scripts/incidents.sh fingerprint --fp "abc123def456"

# See all recurring patterns
./scripts/incidents.sh patterns --days 7

# Full briefing
./scripts/incidents.sh briefing --days 7
```

## How to interpret results

- **Same alert, always noise**: Skip investigation, log as known noise
- **Same alert, was real last time**: Investigate thoroughly — it might be the same root cause
- **Same alert, was auto-fixed last time**: Try the same fix, but escalate if it fails again
- **Same fingerprint fired and resolved recently**: Likely flapping — investigate the root cause of the flapping, not just the current firing
- **Alert was escalated and never acknowledged**: Mention this in the new escalation — "this was also escalated on [date] and never resolved"
