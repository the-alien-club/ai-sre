# Run Regression

Run the regression suite (or a subset) against a target environment. Used:
- After a default-branch merge
- On a daily schedule
- For flake-rechecks of a single spec
- When the owner asks "run regression on staging"

## Procedure

1. Determine target environment and base URL:
   - `staging` → `$STAGING_BASE_URL`
   - `dev` → `$DEV_BASE_URL`
   - `prod` → only with explicit owner approval (DM check first)

2. Determine scope:
   - Full suite: `tests/regression`
   - One service: `tests/regression/<service>`
   - Single spec (flake-recheck): `tests/regression/<path-to-spec>`

3. Spawn a sub-agent with `model: "sonnet"`:

```
Agent({
  description: "Regression run on <env>",
  model: "sonnet",
  prompt: "<see template>"
})
```

## Sub-agent prompt template

```
You are a sub-agent running the regression suite. Do the work directly.

Target:
- Environment: <env>
- Base URL: <url>
- Scope: <full | service:<name> | spec:<path>>
- Trigger: <merge | scheduled | manual | flake_recheck>

Workflow:
1. List enabled regression tests from the DB (filter to scope):
   ./scripts/tests.sh regression-list

2. Run Playwright:
   PLAYWRIGHT_BASE_URL="<url>" npx playwright test <scope_paths> \
     --reporter=json,list --output=data/artifacts/regression-<timestamp> 2>&1 | tee /tmp/regression.log

3. Update per-test stats in the DB for each test that ran:
   - Increment pass_count / fail_count / flake_count
   - Update last_run_at, last_pass_at, last_fail_at
   (You can do this via direct sqlite3 UPDATE statements; see schema.)

4. Log the run:
   RUN_ID=$(./scripts/tests.sh log-run --trigger <trigger> --environment <env> \
     --base-url "<url>" --status <status> --verdict <verdict> \
     --summary "<n> passed, <m> failed of <total> regression tests" \
     --artifact-dir "data/artifacts/regression-<timestamp>")

5. Log each failure as in /test-mr.

Report back (under 20 lines):
- Total / passed / failed / flake counts
- Run id
- Failures: list of { test_name, classification }
- Recommendation: file / escalate
- If failure rate spikes (e.g., >20% failures vs last 7 days), flag it
```

## After the sub-agent reports

- All pass → no need for chatter unless this is a scheduled run; in which case
  a brief summary in the QA channel is fine.
- New regression failures → escalate to owner with run id and 1-2 screenshots.
- Multiple unrelated failures → likely an env/infra issue. DM owner via `reply`
  with details rather than escalating per-failure.

## Flake rechecks

When invoked with `--flake-recheck <spec>`, run only that one spec, ONCE. Do not
re-run a flake check — if it still fails, it's not a flake.
