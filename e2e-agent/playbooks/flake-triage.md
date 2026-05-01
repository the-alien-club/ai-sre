# Playbook: Flake Triage

A "flake" is a test that fails non-deterministically — passes on retry without
any code change. Flakes destroy trust in the suite. Triage every failure before
classifying it as a flake.

## Decision tree

```
Test failed.
├── Did it fail on the same line/assertion as a prior failure?
│   ├── Yes, same MR → likely a real bug, classify `regression` or `new_bug`
│   └── Yes, different MR → check flake history:
│       ./scripts/tests.sh flakes --days 30
│       ├── This test has flaked 3+ times → classify `flake`, propose fix
│       └── First time → re-run once. If pass, classify `flake` (single).
│                          If fail, classify `regression` or `new_bug`.
└── Different failure mode each time → likely env or timing issue:
    ├── Network/503/timeout → `env_issue`, DM owner via reply
    └── Selector/element-not-found → `flake`, propose better selector
```

## How to re-run safely

Sub-agents may re-run a single failing test ONCE for flake detection:

```bash
PLAYWRIGHT_BASE_URL="<url>" npx playwright test <spec> -g "<test title>" \
  --retries=0 --reporter=list 2>&1 | tee /tmp/recheck.log
```

Don't re-run the whole suite. Don't re-run more than once. If it still fails,
it's not a flake.

## Common flake patterns

| Symptom | Likely cause | Fix |
|---|---|---|
| `getByRole(...)` finds 0 elements | Race with hydration | Add `await page.waitForLoadState("networkidle")` or a more specific locator |
| `Element is not visible` | Animation in progress | `test.use({ reducedMotion: "reduce" })` |
| Timeout after 30s | Backend cold start | Increase navigationTimeout for that suite, or pre-warm |
| Different text each run | Date/time formatting | `page.emulateTimezone("UTC")` and freeze date |
| Tests pass alone, fail in suite | Shared state leak | Fresh `storageState` per test, or `context: "isolated"` |
| Random 500 from API | Real backend flake | This is `env_issue`, not `flake`; DM the SRE agent's owner |

## Don't do

- Don't add `page.waitForTimeout(N)` to mask a flake. It will come back.
- Don't catch and ignore failures with try/catch in test code.
- Don't auto-retry in the spec itself (`test.describe.configure({ retries: 5 })`)
  — the global config has retries=1; that's enough.

## Logging flakes

When you classify a failure as a flake, include the recheck outcome in the notes:

```bash
./scripts/tests.sh log-failure --run-id $RUN_ID \
  --test-name "..." --spec-file "..." \
  --error-message "..." --classification flake \
  --notes "Re-ran once and passed. First flake for this test in 30d."
```

## Escalation policy

- 1 flake in 30 days for a regression test → log, no escalation
- 3+ flakes in 30 days for the same test → propose a playbook fix and disable
  the test until fixed
- Flake on a critical flow (login, checkout) → DM owner via `reply` even on
  first occurrence so they know it's brittle
