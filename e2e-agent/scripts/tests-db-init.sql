-- E2E QA Agent — SQLite schema
-- Persists every test run, failure, regression test, and playbook proposal.

-- One row per Playwright invocation (per MR pipeline, per regression run, etc.)
CREATE TABLE IF NOT EXISTS test_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Trigger
    trigger_kind TEXT NOT NULL,    -- mr_pipeline, regression, manual, flake_recheck
    project_path TEXT,             -- e.g. "the-alien-club/web-app"
    project_id INTEGER,
    mr_iid INTEGER,
    commit_sha TEXT,
    branch TEXT,
    environment TEXT,              -- dev, staging, prod

    -- Execution
    base_url TEXT,
    spec_paths TEXT,               -- comma-separated test file paths
    started_at TEXT,
    finished_at TEXT,
    duration_sec INTEGER,

    -- Outcome
    status TEXT NOT NULL,          -- pass, fail, flake, blocked, error
    verdict TEXT,                  -- new_bug, regression, flake, env_issue, expected_change
    summary TEXT,                  -- 1-3 sentence outcome
    related_mr_url TEXT,
    artifact_dir TEXT              -- path to screenshots/videos for this run
);

CREATE INDEX IF NOT EXISTS idx_runs_mr ON test_runs(project_path, mr_iid, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON test_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_branch ON test_runs(branch, created_at);

-- One row per failing test within a run (a run can have multiple)
CREATE TABLE IF NOT EXISTS test_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,

    test_name TEXT NOT NULL,       -- "checkout > can complete purchase"
    spec_file TEXT NOT NULL,       -- "tests/regression/checkout.spec.ts"
    error_message TEXT,
    error_stack TEXT,
    screenshot_path TEXT,
    video_path TEXT,
    trace_path TEXT,

    -- Triage
    classification TEXT,           -- regression, new_bug, flake, env_issue, expected_change
    similar_failure_run_id INTEGER,-- if this matches a prior failure
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_failures_run ON test_failures(run_id);
CREATE INDEX IF NOT EXISTS idx_failures_test ON test_failures(test_name, created_at);
CREATE INDEX IF NOT EXISTS idx_failures_class ON test_failures(classification, created_at);

-- The persistent regression suite — tests that run on every shipped MR or schedule.
CREATE TABLE IF NOT EXISTS regression_tests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    name TEXT NOT NULL UNIQUE,     -- canonical test name
    spec_file TEXT NOT NULL,       -- path under tests/
    description TEXT,
    added_from_run_id INTEGER REFERENCES test_runs(id),
    enabled INTEGER NOT NULL DEFAULT 1,

    -- Stats
    last_run_at TEXT,
    last_pass_at TEXT,
    last_fail_at TEXT,
    pass_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    flake_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_regression_enabled ON regression_tests(enabled, name);

-- Playbook proposals queued for human approval via Slack.
CREATE TABLE IF NOT EXISTS playbook_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    proposal_id TEXT NOT NULL UNIQUE,  -- the slug used in Slack
    file_path TEXT NOT NULL,
    change_kind TEXT NOT NULL,         -- add_section, edit_section, new_file, delete_section
    rationale TEXT NOT NULL,
    proposed_markdown TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending, approved, rejected, committed
    decided_at TEXT,
    decided_by TEXT,
    decision_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON playbook_proposals(status, created_at);

-- Investigation context trail (mirrors ai-sre's incident_context table).
-- Sub-agents write notes as they triage / run / report.
CREATE TABLE IF NOT EXISTS run_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    run_id INTEGER REFERENCES test_runs(id),
    correlation_id TEXT,                  -- e.g. mr_iid or proposal_id, when run_id not yet set
    author TEXT NOT NULL DEFAULT 'sub-agent',
    phase TEXT NOT NULL,                  -- analyze, plan, execute, triage, report
    content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_run ON run_context(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_corr ON run_context(correlation_id, created_at);

-- View: flaky tests in the last 14 days
CREATE VIEW IF NOT EXISTS flaky_tests AS
SELECT
    test_name,
    spec_file,
    COUNT(*) as failure_count,
    SUM(CASE WHEN classification = 'flake' THEN 1 ELSE 0 END) as flake_count,
    SUM(CASE WHEN classification = 'regression' THEN 1 ELSE 0 END) as regression_count,
    MAX(created_at) as last_failure
FROM test_failures
WHERE created_at > datetime('now', '-14 days')
GROUP BY test_name, spec_file
HAVING COUNT(*) > 1
ORDER BY failure_count DESC;

-- View: pending playbook proposals
CREATE VIEW IF NOT EXISTS pending_proposals AS
SELECT id, created_at, proposal_id, file_path, change_kind, rationale
FROM playbook_proposals
WHERE status = 'pending'
ORDER BY created_at DESC;
