#!/usr/bin/env bash
# E2E Agent test memory CLI — used by sub-agents to query and log test runs.
#
# Common commands:
#   ./scripts/tests.sh log-run --trigger mr_pipeline --project-path the-alien-club/web-app \
#       --mr-iid 1234 --commit-sha abc123 --branch feat/x --environment dev \
#       --status fail --verdict new_bug --summary "Checkout broken on Chromium"
#
#   ./scripts/tests.sh log-failure --run-id 42 --test-name "checkout > completes" \
#       --spec-file tests/regression/checkout.spec.ts --error-message "..." \
#       --screenshot-path data/artifacts/.../screenshot.png --classification new_bug
#
#   ./scripts/tests.sh check-mr --mr-iid 1234 --project-path the-alien-club/web-app
#   ./scripts/tests.sh flakes [--days 14]
#   ./scripts/tests.sh briefing [--days 7]
#   ./scripts/tests.sh proposal --id <slug> --file playbooks/x.md --kind add_section \
#       --rationale "..." --markdown "$(cat <<'EOF' ... EOF)"
#   ./scripts/tests.sh proposal-decide --id <slug> --status approved|rejected --notes "..."
#   ./scripts/tests.sh regression-add --name "Login smoke" --spec tests/regression/login.spec.ts
#   ./scripts/tests.sh context --phase analyze --content "..." [--run-id N | --corr ID]

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="$SCRIPT_DIR/../data/tests.db"

mkdir -p "$(dirname "$DB")"
if [ ! -f "$DB" ]; then
    sqlite3 "$DB" < "$SCRIPT_DIR/tests-db-init.sql"
fi

# SQL-escape a string for single-quoted SQL literals.
esc() { echo "$1" | sed "s/'/''/g"; }

CMD="${1:-help}"
shift || true

case "$CMD" in
    log-run)
        TRIGGER="" PROJECT_PATH="" PROJECT_ID="" MR_IID="" COMMIT="" BRANCH="" ENVIRONMENT=""
        BASE_URL="" SPECS="" STARTED="" FINISHED="" DURATION=""
        STATUS="" VERDICT="" SUMMARY="" MR_URL="" ARTIFACT_DIR=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --trigger) TRIGGER="$2"; shift 2;;
                --project-path) PROJECT_PATH="$2"; shift 2;;
                --project-id) PROJECT_ID="$2"; shift 2;;
                --mr-iid) MR_IID="$2"; shift 2;;
                --commit-sha) COMMIT="$2"; shift 2;;
                --branch) BRANCH="$2"; shift 2;;
                --environment) ENVIRONMENT="$2"; shift 2;;
                --base-url) BASE_URL="$2"; shift 2;;
                --specs) SPECS="$2"; shift 2;;
                --started) STARTED="$2"; shift 2;;
                --finished) FINISHED="$2"; shift 2;;
                --duration) DURATION="$2"; shift 2;;
                --status) STATUS="$2"; shift 2;;
                --verdict) VERDICT="$2"; shift 2;;
                --summary) SUMMARY="$2"; shift 2;;
                --mr-url) MR_URL="$2"; shift 2;;
                --artifact-dir) ARTIFACT_DIR="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done
        if [ -z "$TRIGGER" ] || [ -z "$STATUS" ]; then
            echo "Required: --trigger, --status"; exit 1
        fi
        sqlite3 "$DB" "INSERT INTO test_runs (
            trigger_kind, project_path, project_id, mr_iid, commit_sha, branch, environment,
            base_url, spec_paths, started_at, finished_at, duration_sec,
            status, verdict, summary, related_mr_url, artifact_dir
        ) VALUES (
            '$(esc "$TRIGGER")', '$(esc "$PROJECT_PATH")', ${PROJECT_ID:-NULL}, ${MR_IID:-NULL},
            '$(esc "$COMMIT")', '$(esc "$BRANCH")', '$(esc "$ENVIRONMENT")',
            '$(esc "$BASE_URL")', '$(esc "$SPECS")', '$(esc "$STARTED")', '$(esc "$FINISHED")',
            ${DURATION:-NULL},
            '$(esc "$STATUS")', '$(esc "$VERDICT")', '$(esc "$SUMMARY")',
            '$(esc "$MR_URL")', '$(esc "$ARTIFACT_DIR")'
        );"
        ID=$(sqlite3 "$DB" "SELECT last_insert_rowid();")
        echo "$ID"
        ;;

    log-failure)
        RUN_ID="" TEST_NAME="" SPEC="" ERR_MSG="" ERR_STACK="" SHOT="" VIDEO="" TRACE=""
        CLASSIFICATION="" SIMILAR="" NOTES=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --run-id) RUN_ID="$2"; shift 2;;
                --test-name) TEST_NAME="$2"; shift 2;;
                --spec-file) SPEC="$2"; shift 2;;
                --error-message) ERR_MSG="$2"; shift 2;;
                --error-stack) ERR_STACK="$2"; shift 2;;
                --screenshot-path) SHOT="$2"; shift 2;;
                --video-path) VIDEO="$2"; shift 2;;
                --trace-path) TRACE="$2"; shift 2;;
                --classification) CLASSIFICATION="$2"; shift 2;;
                --similar-run-id) SIMILAR="$2"; shift 2;;
                --notes) NOTES="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done
        if [ -z "$RUN_ID" ] || [ -z "$TEST_NAME" ] || [ -z "$SPEC" ]; then
            echo "Required: --run-id, --test-name, --spec-file"; exit 1
        fi
        sqlite3 "$DB" "INSERT INTO test_failures (
            run_id, test_name, spec_file, error_message, error_stack,
            screenshot_path, video_path, trace_path,
            classification, similar_failure_run_id, notes
        ) VALUES (
            $RUN_ID, '$(esc "$TEST_NAME")', '$(esc "$SPEC")',
            '$(esc "$ERR_MSG")', '$(esc "$ERR_STACK")',
            '$(esc "$SHOT")', '$(esc "$VIDEO")', '$(esc "$TRACE")',
            '$(esc "$CLASSIFICATION")', ${SIMILAR:-NULL}, '$(esc "$NOTES")'
        );"
        echo "Failure logged for run $RUN_ID: $TEST_NAME"
        ;;

    check-mr)
        MR_IID="" PROJECT_PATH="" DAYS=30
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --mr-iid) MR_IID="$2"; shift 2;;
                --project-path) PROJECT_PATH="$2"; shift 2;;
                --days) DAYS="$2"; shift 2;;
                *) shift;;
            esac
        done
        WHERE="created_at > datetime('now', '-${DAYS} days')"
        [ -n "$MR_IID" ] && WHERE="$WHERE AND mr_iid = $MR_IID"
        [ -n "$PROJECT_PATH" ] && WHERE="$WHERE AND project_path = '$(esc "$PROJECT_PATH")'"
        sqlite3 -header -column "$DB" "SELECT id, created_at, status, verdict, summary FROM test_runs WHERE $WHERE ORDER BY created_at DESC LIMIT 10;"
        ;;

    flakes)
        DAYS=14
        [ "${1:-}" = "--days" ] && DAYS="$2"
        echo "=== Flaky / repeatedly failing tests (last ${DAYS} days) ==="
        sqlite3 -header -column "$DB" "SELECT test_name, spec_file, COUNT(*) as fails,
            SUM(CASE WHEN classification='flake' THEN 1 ELSE 0 END) as flakes,
            SUM(CASE WHEN classification='regression' THEN 1 ELSE 0 END) as regs,
            MAX(created_at) as last_failure
        FROM test_failures
        WHERE created_at > datetime('now', '-${DAYS} days')
        GROUP BY test_name, spec_file
        HAVING COUNT(*) > 1
        ORDER BY fails DESC;"
        ;;

    briefing)
        DAYS=7
        [ "${1:-}" = "--days" ] && DAYS="$2"
        TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM test_runs WHERE created_at > datetime('now', '-${DAYS} days');")
        PASS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM test_runs WHERE status='pass' AND created_at > datetime('now', '-${DAYS} days');")
        FAIL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM test_runs WHERE status='fail' AND created_at > datetime('now', '-${DAYS} days');")
        FLAKE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM test_runs WHERE status='flake' AND created_at > datetime('now', '-${DAYS} days');")
        REGRESSIONS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM regression_tests WHERE enabled = 1;")
        PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM playbook_proposals WHERE status='pending';")
        echo "=== E2E Briefing — Last ${DAYS} Days ==="
        echo "Runs: ${TOTAL} | ${PASS} pass | ${FAIL} fail | ${FLAKE} flake"
        echo "Regression suite: ${REGRESSIONS} tests enabled"
        echo "Pending playbook proposals: ${PENDING}"
        echo ""

        FLAKY=$(sqlite3 -separator ' | ' "$DB" "SELECT test_name || ' (' || spec_file || ')', COUNT(*) || 'x' FROM test_failures WHERE created_at > datetime('now', '-${DAYS} days') GROUP BY test_name, spec_file HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC LIMIT 5;")
        if [ -n "$FLAKY" ]; then
            echo "Repeatedly failing tests (likely flakes or unaddressed regressions):"
            echo "$FLAKY" | while read -r line; do echo "  - $line"; done
            echo ""
        fi

        RECENT=$(sqlite3 -separator '' "$DB" "SELECT '[' || date(created_at) || '] MR !' || COALESCE(mr_iid, 0) || ' (' || COALESCE(project_path, '?') || ') — ' || status || ': ' || COALESCE(summary, '?') FROM test_runs WHERE status IN ('fail','error') AND created_at > datetime('now', '-${DAYS} days') ORDER BY created_at DESC LIMIT 10;")
        if [ -n "$RECENT" ]; then
            echo "Recent failures:"
            echo "$RECENT" | while read -r line; do echo "  - $line"; done
            echo ""
        fi

        if [ "$PENDING" -gt 0 ]; then
            echo "Playbook proposals awaiting owner approval:"
            sqlite3 -separator '' "$DB" "SELECT '  - ' || proposal_id || ' (' || file_path || '): ' || rationale FROM playbook_proposals WHERE status='pending' ORDER BY created_at DESC;"
        fi

        [ "$TOTAL" = "0" ] && echo "No test runs recorded yet. Fresh start."
        ;;

    proposal)
        PID="" FILE="" KIND="" RATIONALE="" MARKDOWN=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --id) PID="$2"; shift 2;;
                --file) FILE="$2"; shift 2;;
                --kind) KIND="$2"; shift 2;;
                --rationale) RATIONALE="$2"; shift 2;;
                --markdown) MARKDOWN="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done
        if [ -z "$PID" ] || [ -z "$FILE" ] || [ -z "$KIND" ] || [ -z "$RATIONALE" ] || [ -z "$MARKDOWN" ]; then
            echo "Required: --id, --file, --kind, --rationale, --markdown"; exit 1
        fi
        sqlite3 "$DB" "INSERT INTO playbook_proposals (proposal_id, file_path, change_kind, rationale, proposed_markdown) VALUES ('$(esc "$PID")', '$(esc "$FILE")', '$(esc "$KIND")', '$(esc "$RATIONALE")', '$(esc "$MARKDOWN")');"
        echo "Proposal recorded: $PID ($FILE)"
        ;;

    proposal-decide)
        PID="" STATUS="" NOTES="" BY="owner"
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --id) PID="$2"; shift 2;;
                --status) STATUS="$2"; shift 2;;
                --notes) NOTES="$2"; shift 2;;
                --by) BY="$2"; shift 2;;
                *) shift;;
            esac
        done
        if [ -z "$PID" ] || [ -z "$STATUS" ]; then
            echo "Required: --id, --status (approved|rejected|committed)"; exit 1
        fi
        sqlite3 "$DB" "UPDATE playbook_proposals SET status = '$(esc "$STATUS")', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), decided_by = '$(esc "$BY")', decision_notes = '$(esc "$NOTES")' WHERE proposal_id = '$(esc "$PID")';"
        echo "Proposal $PID → $STATUS"
        ;;

    regression-add)
        NAME="" SPEC="" DESC="" RUN_ID=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --name) NAME="$2"; shift 2;;
                --spec) SPEC="$2"; shift 2;;
                --description) DESC="$2"; shift 2;;
                --added-from-run) RUN_ID="$2"; shift 2;;
                *) shift;;
            esac
        done
        if [ -z "$NAME" ] || [ -z "$SPEC" ]; then
            echo "Required: --name, --spec"; exit 1
        fi
        sqlite3 "$DB" "INSERT INTO regression_tests (name, spec_file, description, added_from_run_id) VALUES ('$(esc "$NAME")', '$(esc "$SPEC")', '$(esc "$DESC")', ${RUN_ID:-NULL});"
        echo "Regression test added: $NAME → $SPEC"
        ;;

    regression-list)
        sqlite3 -header -column "$DB" "SELECT id, name, spec_file, enabled, pass_count || '/' || (pass_count + fail_count) as pass_ratio, last_run_at FROM regression_tests ORDER BY name;"
        ;;

    context)
        RUN_ID="" CORR="" PHASE="" CONTENT="" AUTHOR="sub-agent"
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --run-id) RUN_ID="$2"; shift 2;;
                --corr) CORR="$2"; shift 2;;
                --phase) PHASE="$2"; shift 2;;
                --content) CONTENT="$2"; shift 2;;
                --author) AUTHOR="$2"; shift 2;;
                *) shift;;
            esac
        done
        if [ -z "$PHASE" ] || [ -z "$CONTENT" ]; then
            echo "Required: --phase (analyze|plan|execute|triage|report), --content, and one of --run-id|--corr"
            exit 1
        fi
        sqlite3 "$DB" "INSERT INTO run_context (run_id, correlation_id, author, phase, content) VALUES (${RUN_ID:-NULL}, '$(esc "$CORR")', '$(esc "$AUTHOR")', '$(esc "$PHASE")', '$(esc "$CONTENT")');"
        echo "Context saved: [$PHASE]"
        ;;

    timeline)
        RUN_ID="" CORR=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --run-id) RUN_ID="$2"; shift 2;;
                --corr) CORR="$2"; shift 2;;
                *) shift;;
            esac
        done
        if [ -n "$RUN_ID" ]; then
            echo "=== Run $RUN_ID ==="
            sqlite3 -header -column "$DB" "SELECT * FROM test_runs WHERE id = $RUN_ID;"
            echo ""
            echo "--- Failures ---"
            sqlite3 -header -column "$DB" "SELECT test_name, spec_file, classification, screenshot_path FROM test_failures WHERE run_id = $RUN_ID;"
            echo ""
            echo "--- Context ---"
            sqlite3 -separator '' "$DB" "SELECT '[' || created_at || '] [' || phase || '] (' || author || ') ' || content FROM run_context WHERE run_id = $RUN_ID ORDER BY created_at;"
        elif [ -n "$CORR" ]; then
            echo "=== Correlation $CORR ==="
            sqlite3 -separator '' "$DB" "SELECT '[' || created_at || '] [' || phase || '] (' || author || ') ' || content FROM run_context WHERE correlation_id = '$(esc "$CORR")' ORDER BY created_at;"
        else
            echo "Required: --run-id or --corr"; exit 1
        fi
        ;;

    help|*)
        echo "E2E Agent Test Memory"
        echo ""
        echo "Commands:"
        echo "  log-run            Insert a test run row, prints new id"
        echo "  log-failure        Insert a failure row tied to a run"
        echo "  check-mr           Recent runs for an MR"
        echo "  flakes             Repeatedly failing tests"
        echo "  briefing           Startup briefing"
        echo "  proposal           Save a playbook proposal"
        echo "  proposal-decide    Mark a proposal approved/rejected/committed"
        echo "  regression-add     Promote a test into the regression suite"
        echo "  regression-list    List regression tests"
        echo "  context            Save investigation context (--phase, --content)"
        echo "  timeline           Show context for a run or correlation id"
        echo ""
        echo "DB location: $DB"
        ;;
esac
