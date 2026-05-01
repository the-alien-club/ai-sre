# Check History

Query test history for an MR or a specific test name. Used to make better
decisions during triage (is this a real regression or a known flake?).

## Usage

For an MR:
```bash
./scripts/tests.sh check-mr --mr-iid <iid> --project-path "<path>" --days 30
```

For flakes:
```bash
./scripts/tests.sh flakes --days 14
```

For full timeline of a single run:
```bash
./scripts/tests.sh timeline --run-id <id>
```

For a correlation id (e.g., before a run is logged, while sub-agent context is being saved):
```bash
./scripts/tests.sh timeline --corr "mr-<iid>"
```

## When to use

- Before deciding "is this a flake or a real bug?" — check past runs of that test
- Before opening a duplicate escalation — see if the MR has already been triaged
- When the owner asks "what did we test on this MR?" — pull the timeline

## Don't

- Don't dump the full DB into your context. Filter aggressively.
- Don't query the DB from the main agent — sub-agents do this.
