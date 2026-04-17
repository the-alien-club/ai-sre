-- SRE Agent incident memory — SQLite schema
-- Stores every alert investigation for pattern detection and context across restarts.

CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

    -- Alert identity
    alert_name TEXT NOT NULL,
    fingerprint TEXT,
    severity TEXT NOT NULL,  -- critical, warning, info
    status TEXT NOT NULL,    -- firing, resolved

    -- Location
    cluster TEXT,
    namespace TEXT,
    service TEXT,

    -- Investigation result
    verdict TEXT NOT NULL,   -- real, noise, false_positive, flapping, known_issue
    action TEXT NOT NULL,    -- auto_fixed, escalated, ignored, monitoring
    cause TEXT,              -- brief root cause description
    resolution TEXT,         -- what fixed it (if resolved)
    related_mr TEXT,         -- GitLab MR URL if a merge caused it

    -- Metadata
    investigation_duration_sec INTEGER,
    escalation_acknowledged INTEGER DEFAULT 0,  -- 1 if CTO responded
    notes TEXT               -- free-form notes
);

-- Index for the most common queries
CREATE INDEX IF NOT EXISTS idx_incidents_alert ON incidents(alert_name, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_cluster ON incidents(cluster, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_verdict ON incidents(verdict, created_at);

-- View: alert frequency in the last 7 days (for pattern detection)
CREATE VIEW IF NOT EXISTS recurring_alerts AS
SELECT
    alert_name,
    cluster,
    service,
    COUNT(*) as fire_count,
    SUM(CASE WHEN verdict = 'noise' OR verdict = 'false_positive' OR verdict = 'known_issue' THEN 1 ELSE 0 END) as noise_count,
    SUM(CASE WHEN verdict = 'real' THEN 1 ELSE 0 END) as real_count,
    SUM(CASE WHEN action = 'auto_fixed' THEN 1 ELSE 0 END) as auto_fixed_count,
    SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END) as escalated_count,
    MAX(created_at) as last_seen,
    MIN(created_at) as first_seen
FROM incidents
WHERE created_at > datetime('now', '-7 days')
GROUP BY alert_name, cluster, service
ORDER BY fire_count DESC;

-- View: recent escalations still pending
CREATE VIEW IF NOT EXISTS pending_escalations AS
SELECT
    id, created_at, alert_name, fingerprint, cluster, service, severity,
    cause, notes
FROM incidents
WHERE action = 'escalated'
  AND escalation_acknowledged = 0
  AND created_at > datetime('now', '-3 days')
ORDER BY created_at DESC;
