# Playbook: Deep Dive (root cause + fix proposal)

The QA agent's default behavior is **raise, then dive**. After a failed E2E run
the agent escalates with the screenshots and the verdict. It does NOT
automatically dig into kubectl, SigNoz, or the repo source. That dive is
expensive (context, time, tokens) and intrusive (read-only, but still queries
production observability).

The dive runs only when the owner authorizes it: by replying `dive` (or `dig`,
`investigate`) in the escalation thread on Slack.

This playbook is for the dive sub-agent: how to use kubectl, SigNoz, and the
repo clones to find a root cause and propose a fix.

## Inputs the dive sub-agent gets

- Run id (so it can pull the test failure rows from the DB)
- MR details (project, iid, branch, commit_sha, mr_url)
- Failed test name(s), error message(s), spec file(s)
- The screenshot path(s) — already uploaded to Slack
- Resolved environment (dev/staging/prod) and base URL
- Slack channel + thread_ts for posting the proposal

## Tools available

Same set as the SRE agent's investigation sub-agents:

1. **kubectl** — read-only via service account, all 5 cluster contexts:
   - `platform-dev`, `platform-prod`
   - `data-cluster-dev`, `data-cluster-biorxiv`, `data-cluster-alien-hosted`
   Allowed verbs: `get`, `describe`, `logs`, `top`, `events`. NEVER `delete`,
   `apply`, `exec`, `scale`.

2. **SigNoz MCP** — `search_logs`, `search_traces`, `query_metrics`,
   `get_service_top_operations`, `get_trace_details`, etc. Filter by
   `service.name`, `k8s.namespace.name`, time window around the failure timestamp.

3. **Repo clones in `$REPOS_DIR`** — read-only. Use `git log`, `git blame`,
   `git diff`, `grep`. Do NOT push, commit, or modify.

4. **GitLab API** — `$GITLAB_TOKEN` for read-only MR/diff/pipeline lookups.

## Workflow

### 1. Reproduce mentally — what was the failing assertion?

Pull the failure record:
```bash
sqlite3 -header -column data/tests.db \
  "SELECT test_name, spec_file, error_message, error_stack, screenshot_path FROM test_failures WHERE run_id = $RUN_ID;"
```

Read the spec file:
```bash
cat <spec_file>
```

Locate the assertion that failed in the stack. The error message usually
includes the locator (e.g., `getByRole('button', { name: 'Place order' })`).

### 2. Was it the frontend or the backend?

Decide which layer to look at first:
- Locator not found / wrong text → frontend
- 5xx error in the network tab → backend
- 4xx → likely an API contract change between FE and BE
- Timeout with no response → backend or infra

### 3. Read the MR diff with focus

Pull the diff for the files most likely involved:
```bash
curl -s "$GITLAB_BASE_URL/api/v4/projects/<project_id>/merge_requests/<iid>/changes" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" | jq -r '.changes[] | select(.new_path | test("frontend|backend|api")) | .new_path + "\n" + .diff'
```

Look for:
- Renamed/removed buttons, labels, form fields (frontend regressions)
- Changed API response shape (backend regressions)
- Changed auth requirement (401 where 200 used to work)

### 4. Confirm via repo source

If the diff is small, read the changed file in full from the local clone:
```bash
cd $REPOS_DIR/<repo>
git fetch --quiet origin
git show origin/<source_branch>:<file_path>
```

Cross-reference with the test's expectations.

### 5. Confirm via runtime state (kubectl)

If the failure looks like a backend issue:
```bash
NS=<namespace>   # e.g. backend, frontend, tenant-<x>
CTX=<kubectl context>

# Pod state
kubectl --context $CTX get pods -n $NS -o wide
kubectl --context $CTX describe pod <pod> -n $NS

# Recent logs from the affected service
kubectl --context $CTX logs -l app=<service> -n $NS --tail=100 --since=15m

# Events around the failure window
kubectl --context $CTX get events -n $NS --sort-by=.lastTimestamp | tail -30
```

### 6. Confirm via SigNoz

For a service-level signal:
```
signoz_search_logs:
  service: "<service.name>"
  time_range: "15m around failure timestamp"
  filters: severity_text IN ('ERROR', 'WARN') AND k8s.namespace.name = '<ns>'

signoz_search_traces:
  service: "<service.name>"
  filters: has_error = true
  time_range: "15m"
  limit: 5

signoz_get_trace_details:
  trace_id: "<from above>"
```

Look for: a stack trace, a 5xx response, a panicking dependency. Match it to
the diff.

### 7. Identify the cause

State the cause in one paragraph: which line of which file in which commit
broke which test. If you can't pin it that precisely, you don't have a root
cause yet — keep digging or report uncertainty.

### 8. Draft a fix proposal

Format a unified diff against the MR's source branch:

```
File: <repo>/<path>
Hunk:
@@ <line context> @@
- <broken line>
+ <fixed line>

Why this fixes it: <one paragraph>
Risk: <low|medium|high — what could regress>
Test to add: <if applicable, the spec snippet that would catch this>
```

Keep diffs tight — only the lines that need to change. If multiple files need
changes, list each as a separate hunk.

For non-trivial fixes, sketch the fix in prose instead of a precise diff. The
owner reads it and decides whether to apply it themselves.

### 9. Save context to the DB

```bash
./scripts/tests.sh context --run-id $RUN_ID --phase triage \
  --content "Cause: <paragraph>. Fix proposed: <one-line summary>."
```

### 10. Post the proposal

Use the `propose_code_fix` tool on the slack-qa channel — it posts the proposal
to the same Slack thread the escalation lives in, with the diff in a code block.

```
propose_code_fix({
  proposal_id: "<5-letter slug>",
  run_id: <RUN_ID>,
  channel: "<slack channel from event>",
  thread_ts: "<escalation thread_ts>",
  affected_files: ["<repo>/<path>", ...],
  cause_summary: "<one paragraph>",
  fix_diff: "<unified diff or prose>",
  risk: "<low|medium|high>",
  test_to_add: "<optional spec snippet>"
})
```

The owner reviews the proposal and applies it on their own machine. The QA
agent does NOT push code or open MRs — that requires explicit owner action.

## Don't

- Don't `kubectl exec` or `kubectl delete` anything (forbidden).
- Don't push branches or commits in `$REPOS_DIR` — read-only.
- Don't propose fixes that span more than ~30 lines without flagging the size
  prominently — those are usually wrong.
- Don't speculate. If you can't pin the cause, say so and report what you
  ruled out.
- Don't dive without authorization. If the main agent dispatches you, the
  authorization happened upstream.

## When to give up

If after 5-10 minutes of investigation you still can't pin the cause:
1. Save what you found (`./scripts/tests.sh context ... --phase triage`)
2. Post a status update to the thread: "Investigated <X, Y, Z>; cause unclear.
   Best guess: <hypothesis>. Recommend the owner reproduce locally."
3. Exit. Don't keep spinning — that burns tokens and the owner is waiting.
