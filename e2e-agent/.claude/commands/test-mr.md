# Test MR

Spawn a sub-agent to test an MR pipeline event. Sub-agent reads the diff, picks
or generates Playwright specs, runs them, classifies failures, logs to SQLite,
and reports back.

## When to invoke

Whenever a `<channel source="gitlab-webhook" event_type="pipeline" pipeline_status="success">`
event arrives AND the event has an associated `mr_iid`.

## Procedure

1. Parse the event meta: `project_path`, `project_id`, `mr_iid`, `mr_title`,
   `commit_sha`, `source_branch`, `target_branch`, `mr_url`.
2. Determine the environment: usually `dev` for source-branch pipelines and
   `staging` for default-branch pipelines.
3. Resolve the base URL (preview URL from pipeline variables, MR comments, or
   fall back to `$DEV_BASE_URL`).
4. Spawn the sub-agent with `model: "sonnet"`:

```
Agent({
  description: "Test MR !<iid> on <project_path>",
  model: "sonnet",
  prompt: "<see prompt template below>"
})
```

## Sub-agent prompt template

```
You are a sub-agent testing an MR. Do the work directly — do NOT delegate further.

FIRST: Check history.
  ./scripts/tests.sh check-mr --mr-iid <iid> --project-path "<project_path>"
  ./scripts/tests.sh flakes --days 14
If there's prior flake context for tests touching this MR, factor it in.

MR details:
- Project: <project_path> (id: <project_id>)
- MR !<iid>: <mr_title>
- Source: <source_branch> → Target: <target_branch>
- Commit: <commit_sha>
- MR URL: <mr_url>
- Base URL: <resolved_base_url>
- Environment: <dev|staging|prod>

Workflow:
1. Read the diff:
   curl -s "$GITLAB_BASE_URL/api/v4/projects/<project_id>/merge_requests/<iid>/changes" \
     -H "PRIVATE-TOKEN: $GITLAB_TOKEN" > /tmp/mr-<iid>-diff.json

2. Read the relevant playbooks:
   cat playbooks/analyze-mr.md
   cat playbooks/playwright-recipes.md
   # Plus service-specific playbook(s) — choose based on which paths changed:
   #   MCPs/mcp-* → playbooks/test-mcp-server.md
   #   web-app/packages/frontend → playbooks/test-frontend.md (if exists, else recipes)
   #   web-app/packages/backend → playbooks/test-backend-api.md (if exists, else recipes)

3. Save context after analysis:
   ./scripts/tests.sh context --corr "mr-<iid>" --phase analyze \
     --content "<which surfaces changed and which tests will run>"

4. Pick or generate specs:
   - Existing regression spec covering the change → use it
   - New surface → generate ad-hoc spec at tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts

5. Run Playwright (one focused command):
   PLAYWRIGHT_BASE_URL="<base_url>" npx playwright test <spec_paths> \
     --reporter=json,list --output=data/artifacts/run-<timestamp> 2>&1 | tee /tmp/run.log

6. Parse results from the JSON report and classify each failure per
   playbooks/flake-triage.md.

7. Log the run:
   RUN_ID=$(./scripts/tests.sh log-run --trigger mr_pipeline \
     --project-path "<project_path>" --project-id <project_id> --mr-iid <iid> \
     --commit-sha "<commit_sha>" --branch "<source_branch>" --environment "<env>" \
     --base-url "<base_url>" --specs "<comma-separated spec paths>" \
     --status "<pass|fail|flake|blocked>" --verdict "<verdict>" \
     --summary "<one-line>" --mr-url "<mr_url>" \
     --artifact-dir "data/artifacts/run-<timestamp>")

8. For each failure, log it:
   ./scripts/tests.sh log-failure --run-id $RUN_ID \
     --test-name "..." --spec-file "..." \
     --error-message "..." --error-stack "..." \
     --screenshot-path "..." --classification "..."

9. Save context for plan/execute/triage/report phases too.

Report back (under 30 lines):
- Status: pass / fail / flake / blocked / error
- Run id
- Specs run: count
- Failures: array of { test_name, classification, screenshot_path }
- Verdict (overall): regression / new_bug / flake / env_issue / expected_change
- Cause (one paragraph if any failures)
- Recommendation: escalate / file / re-run-for-flake-check
- If escalate: which screenshots to upload to Slack (pick the 1-2 most diagnostic)
```

## After the sub-agent reports

- All pass → post a `:white_check_mark:` to the QA channel via `reply`. Include
  run id and MR URL. Done.
- Failures + `escalate` recommendation → call `escalate` with the sub-agent's
  cause text. Then call `upload_screenshot` for each diagnostic screenshot,
  attached to the escalation thread. Use the resolution thread to verify any fix.
- Failures + `file` recommendation (flake/env) → DM owner via `reply` (not
  escalate) and continue.
- Failures + `re-run-for-flake-check` → invoke `/run-regression` with
  `--specs <path> --flake-recheck` to re-run that single spec. If it passes,
  classify as flake; if it fails again, escalate.

## Don't

- Don't auto-fix the MR or push commits.
- Don't run the full regression suite — that's `/run-regression`'s job.
- Don't escalate flakes on first occurrence (unless it's a critical flow).
