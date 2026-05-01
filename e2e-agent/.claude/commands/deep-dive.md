# Deep Dive

Spawn a sub-agent to do root-cause investigation on a failed E2E run, using
kubectl, SigNoz, and the local repo clones. Output: a fix proposal posted to
the same Slack thread as the escalation.

## When to invoke

ONLY after the owner explicitly authorizes it. Triggers:
- A `<channel source="slack_qa" type="owner_reply" ...>` event arrives in an
  escalation thread, AND the text matches `/^\s*(dive|dig|investigate)\b/i`
- The owner DMs the bot with `dive run-<id>` or `dive mr-<iid>` outside of a
  thread

If the owner hasn't authorized, DO NOT invoke this. The default agent behavior
is "raise, then wait."

## Procedure

1. Resolve which run to dive on:
   - From an escalation thread → look up the most recent escalation that points
     at that thread (the slack-qa channel keeps the escalation table in memory;
     it includes the `id` you passed when escalating)
   - From an explicit `dive run-<id>` → use that run id directly

2. Pull the run + failures from the DB:
```bash
sqlite3 -header -column data/tests.db "SELECT * FROM test_runs WHERE id = $RUN_ID;"
sqlite3 -header -column data/tests.db "SELECT id, test_name, spec_file, error_message, screenshot_path FROM test_failures WHERE run_id = $RUN_ID;"
```

3. Pick the kubectl context based on environment + service inferred from the
   spec or MR. If unclear, default to `platform-dev` for green-zone services
   and `data-cluster-dev` for orange-zone services.

4. Acknowledge in Slack first so the owner knows the dive started:
```
reply({
  channel: "<thread channel>",
  thread_ts: "<thread_ts>",
  text: ":mag: Diving in. Will post a fix proposal here when I find a cause (usually 3-8 minutes)."
})
```

5. Spawn the sub-agent with `model: "sonnet"`:

```
Agent({
  description: "Deep dive on run #<RUN_ID>",
  model: "sonnet",
  prompt: "<see template>"
})
```

## Sub-agent prompt template

```
You are a sub-agent doing root-cause analysis on a failed E2E run. Do the work
directly — do NOT delegate further.

Run id: <RUN_ID>
MR: !<iid> on <project_path> (<branch> → <target_branch>, commit <sha>)
Environment: <env>
Base URL used: <url>

Read the playbook FIRST:
  cat playbooks/deep-dive.md

Pull the run + failures:
  sqlite3 -header -column data/tests.db "SELECT * FROM test_runs WHERE id = <RUN_ID>;"
  sqlite3 -header -column data/tests.db "SELECT * FROM test_failures WHERE run_id = <RUN_ID>;"

You have these tools at your disposal:
- kubectl with contexts: <list from env vars>. Read-only verbs only (get, describe, logs, top, events).
- SigNoz MCP (search_logs, search_traces, query_metrics, get_trace_details, get_service_top_operations)
- Local repo clones in $REPOS_DIR (read-only). Use git log/blame/diff/show.
- GitLab API via $GITLAB_TOKEN (read-only) for MR/diff/pipeline lookups.

Workflow (per playbooks/deep-dive.md):
1. Read the spec and the failed assertion
2. Decide frontend vs backend vs contract
3. Read the MR diff with focus on the relevant layer
4. Cross-reference with the local repo clone
5. Check kubectl pod state + logs + events
6. Query SigNoz for traces/logs around the failure timestamp
7. Pin the cause to a specific file/line/commit
8. Draft a unified-diff fix proposal (or prose if non-trivial)

Save context as you go:
  ./scripts/tests.sh context --run-id <RUN_ID> --phase triage --content "..."

When you have a fix proposal, generate a 5-letter slug for the proposal id
(matching the [b-km-z]{5} pattern), then post it via:

  propose_code_fix({
    proposal_id: "<slug>",
    run_id: <RUN_ID>,
    channel: "<slack channel>",
    thread_ts: "<escalation thread_ts>",
    affected_files: [...],
    cause_summary: "...",
    fix_diff: "...",
    risk: "low|medium|high",
    test_to_add: "..." // optional
  })

If you cannot pin a cause within ~5-10 minutes, do NOT keep digging. Post a
status reply to the thread saying what you investigated and what you ruled
out, and recommend the owner reproduce locally.

Report back to the main agent (under 20 lines):
- Cause found? (yes/no/uncertain)
- One-paragraph summary
- Proposal id (if posted)
- Tools that returned useful signal (kubectl/signoz/git/diff)
- Time spent
```

## After the sub-agent reports

- If a proposal was posted, add a brief follow-up message to the thread:
  "Proposal `<id>` is above. Reply `applied <id>` to mark resolved, or
  `more <id>` if you want me to dig further."
- If the dive was inconclusive, the sub-agent will already have posted to the
  thread. No further action needed.

## Don't

- Don't dive without authorization. If you got here from an automated trigger,
  there's a bug — report and stop.
- Don't run multiple dives in parallel for the same run id. One dive at a time.
- Don't escalate from this command. The escalation already happened upstream.
