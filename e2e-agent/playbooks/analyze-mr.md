# Playbook: Analyze an MR Diff

Goal: take a GitLab MR with a successful pipeline and decide what to test.

## 1. Fetch the diff

```bash
curl -s "$GITLAB_BASE_URL/api/v4/projects/<project_id>/merge_requests/<iid>/changes" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" > /tmp/mr-diff.json

jq '.changes[] | {old_path, new_path, renamed: .renamed_file, deleted: .deleted_file}' /tmp/mr-diff.json
```

For files that look interesting, get the full diff:
```bash
jq -r '.changes[] | select(.new_path == "<path>") | .diff' /tmp/mr-diff.json
```

## 2. Classify what changed

| Change pattern | Test approach |
|---|---|
| `web-app/packages/frontend/**` | UI test — see `playwright-recipes.md` and `test-frontend.md` |
| `web-app/packages/backend/**` route handler | API test — `test-backend-api.md` |
| `MCPs/mcp-*/src/**` tool handler | MCP test — `test-mcp-server.md` |
| `data-cluster/**` FastAPI endpoint | API test against tenant data API |
| `workers/**` job processor | Trigger a job through the API and assert outcome |
| Chart values / yaml / Dockerfile / lockfile only | Infra change — no E2E required, mark `expected_change` |
| `tests/**` only | The MR is itself a test change — run those tests, don't generate new ones |

**Rule:** if no tracked surface changed, classify as `expected_change` and stop.

## 3. Pick existing tests that touch the changed surfaces

```bash
# Find regression specs that import or reference the changed files
grep -rln "<changed-symbol-or-path>" tests/regression/ tests/<service>/ 2>/dev/null
```

If there's a matching spec, run it first.

## 4. Generate ad-hoc tests for new surfaces

If the diff adds a new route, button, or MCP tool, generate a focused spec under
`tests/<service>/ad-hoc/mr-<iid>-<slug>.spec.ts`. Keep it tight — one or two `test()`
blocks targeted at the new surface. Don't try to cover everything.

## 5. Resolve the base URL

The pipeline event sometimes carries a preview URL. Check in this order:
1. `pipeline.variables` containing `PREVIEW_URL` or `REVIEW_APP_URL`
2. The latest comment from the GitLab review-app bot on the MR
3. The pattern `https://mr-<iid>.dev.example.com` (default convention)
4. Fall back to `$DEV_BASE_URL`

## 6. Decide scope

- 1-3 file diff in one service → run only matching specs, fail fast
- Diff spans multiple services → run regression suite for each affected service
- Diff is a refactor with no behavioral change claim → run regression suite
  for the service to confirm

## 7. What NOT to do

- Don't run the full regression suite for every MR. It's expensive and noisy.
- Don't try to test the SigNoz / observability backend changes — that's the SRE
  agent's territory.
- Don't auto-fix the MR. You report bugs; humans fix them.
