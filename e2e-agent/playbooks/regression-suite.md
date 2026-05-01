# Playbook: Regression Suite

The regression suite is the ground truth — tests that always run on default-branch
merges and on a daily schedule. It must stay small, fast, and high-signal.

## What goes in `tests/regression/`

A test belongs in regression if **all** of these are true:
1. It exercises a critical user flow (login, checkout, MCP tool listing, etc.)
2. It has caught a real bug at least once, OR covers a flow that has historically
   broken
3. It runs in under 60 seconds
4. It is not flaky (passes 19+ times out of 20 in the last 30 days)

## What does NOT belong

- Visual snapshot tests (handle separately if needed; high false-positive rate)
- Tests for one-off MR features that aren't long-lived
- Performance/load tests — these are infra concerns, not regression
- Tests that depend on external services without mocks

## Adding a test

Sub-agents NEVER auto-add to regression. Workflow:
1. A sub-agent finds a bug and writes an ad-hoc test under `tests/<service>/ad-hoc/`
2. Main agent decides if the bug pattern is recurring enough to be worth a
   permanent test
3. Main agent invokes `/add-regression`, which:
   - Calls `propose_playbook_change` with `change_kind=new_file` and the spec
     content as the proposed markdown (file path under `tests/regression/`)
   - Owner approves over Slack
4. On approve: move the spec to `tests/regression/<service>/`, run
   `./scripts/tests.sh regression-add --name "..." --spec tests/regression/...`,
   and commit

## Removing or disabling a test

If a regression test is flaking 3+ times in 14 days:
1. Mark it disabled: `sqlite3 data/tests.db "UPDATE regression_tests SET enabled = 0 WHERE name = '<n>';"`
2. Propose a fix via `propose_playbook_change` with the rewritten spec
3. After owner approves and the new spec is in place, re-enable

## Layout

```
tests/regression/
├── frontend/
│   ├── auth-login.spec.ts
│   ├── checkout.spec.ts
│   └── ...
├── backend/
│   ├── api-health.spec.ts
│   └── auth-jwt.spec.ts
├── mcp/
│   ├── mcp-datacluster-tools.spec.ts
│   └── mcp-openaire-tools.spec.ts
└── data-cluster/
    └── tenant-api-health.spec.ts
```

## Running the suite

```bash
# Full suite
PLAYWRIGHT_BASE_URL="$STAGING_BASE_URL" npx playwright test tests/regression \
  --reporter=json,list --output=data/artifacts/regression-$(date +%s)

# Subset
PLAYWRIGHT_BASE_URL="$STAGING_BASE_URL" npx playwright test tests/regression/frontend
```

## Daily run

Schedule via cron on the QA VM:
```cron
0 6 * * * cd /opt/e2e-agent && bun run channels/internal-trigger.ts daily-regression
```
(The `internal-trigger` is just a convention for synthetic events; not yet
implemented in this skeleton — file an MR if you add it.)
