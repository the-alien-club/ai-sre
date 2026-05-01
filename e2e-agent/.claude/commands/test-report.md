# Test Report

Compile a daily summary of test runs and post it to the QA Slack channel.
Mirror of the SRE agent's `/daily-summary`.

## When to invoke

- Once per day, end of the workday
- On owner request ("how did we do today?")

## Procedure

1. Pull the day's data via the briefing CLI plus a few targeted queries:
```bash
./scripts/tests.sh briefing --days 1
sqlite3 -header -column data/tests.db "SELECT id, mr_iid, project_path, status, verdict, summary FROM test_runs WHERE created_at > datetime('now', '-1 day') ORDER BY created_at DESC;"
sqlite3 -header -column data/tests.db "SELECT proposal_id, file_path, status FROM playbook_proposals WHERE decided_at > datetime('now', '-1 day') OR status = 'pending';"
```

2. Format the message (Slack mrkdwn):
```
:bar_chart: *Daily QA Report* (<date>)

*Runs today:* <total>  (<pass> pass | <fail> fail | <flake> flake)

*Real failures:*
  - MR !<iid> <project>: <verdict> — <summary> (run #<id>)
  - ...

*Flakes flagged:*
  - <test name> — <count>x in 14d

*Playbook activity:*
  - Proposed: <count>
  - Approved/committed: <count>
  - Pending: <count>

*Next:* <one sentence on what's outstanding (open escalations, pending proposals)>
```

3. Post to the QA channel via `reply`:
```
reply({ channel: process.env.QA_CHANNEL_ID, text: "<message>" })
```
or DM the owner if there's no QA channel configured.

## Don't

- Don't include passing MRs by id — too noisy. Just totals.
- Don't escalate from this command. If something needs urgent attention, it
  should already have been escalated when it happened.
- Don't generate the report when nothing happened. If there were 0 runs,
  send a one-liner: ":zzz: *Daily QA Report* — no MRs shipped today."
