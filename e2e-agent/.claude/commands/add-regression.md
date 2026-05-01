# Add Regression Test

Promote an ad-hoc spec into the regression suite. Goes through owner approval
via the playbook proposal flow — same path, same Slack approve/reject UX.

## When to invoke

After a sub-agent finds a real bug (classification: `regression` or `new_bug`)
AND there was no existing test for that flow, AND the flow is critical enough
to deserve permanent coverage.

## Don't invoke for

- Tests that are already in `tests/regression/`
- Cosmetic / one-off bugs unlikely to recur
- Flow that's about to be deprecated

## Procedure

1. Decide the destination path under `tests/regression/<service>/<feature>.spec.ts`.
   The destination should be stable — don't include the MR number.

2. Read the ad-hoc spec content:
```bash
cat tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts
```

3. Use the same proposal flow as `/propose-playbook`, but with `change_kind=new_file`
   and the file_path pointing at the regression destination. The "markdown" body
   is the spec source itself (TypeScript inside a markdown proposal — ugly but
   works for a single-file proposal).

```bash
./scripts/tests.sh proposal --id <slug> --file tests/regression/<service>/<feature>.spec.ts \
  --kind new_file \
  --rationale "Caught a real regression in MR !<iid>: <one-line cause>. Worth permanent coverage." \
  --markdown "$(cat tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts)"
```

```
propose_playbook_change({
  proposal_id: "<slug>",
  file_path: "tests/regression/<service>/<feature>.spec.ts",
  change_kind: "new_file",
  rationale: "...",
  proposed_markdown: "<spec source>"
})
```

## On approval

1. Move (don't copy) the file:
```bash
mkdir -p tests/regression/<service>
git mv tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts tests/regression/<service>/<feature>.spec.ts
```

2. Register it in the DB:
```bash
./scripts/tests.sh regression-add \
  --name "<service>: <feature>" \
  --spec "tests/regression/<service>/<feature>.spec.ts" \
  --description "<what flow this covers>" \
  --added-from-run <RUN_ID>
```

3. Commit:
```bash
git add tests/regression/<service>/<feature>.spec.ts
git rm tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts || true
git commit -m "regression: add <name>"
```

4. Mark the proposal committed:
```bash
./scripts/tests.sh proposal-decide --id <slug> --status committed --notes "promoted to regression"
```

## On rejection

Mark rejected. Leave the ad-hoc spec where it is — the next /test-mr run on a
related MR will still pick it up via path matching, but it won't run as part of
the regression suite.
