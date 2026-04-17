#!/usr/bin/env bash
# Incident memory CLI — used by sub-agents to query and log incidents.
#
# Usage:
#   ./scripts/incidents.sh log --alert "High Error Rate" --severity critical --status firing \
#       --cluster platform-dev --service backend --verdict real --action escalated \
#       --cause "MR !432 caused OOM" --related-mr "https://gitlab.com/..."
#
#   ./scripts/incidents.sh check --alert "High Error Rate" [--cluster platform-dev] [--days 7]
#   ./scripts/incidents.sh fingerprint --fp abc123def
#   ./scripts/incidents.sh patterns [--days 7]
#   ./scripts/incidents.sh briefing [--days 7]
#   ./scripts/incidents.sh resolve --id 42 --resolution "MR reverted"

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB="$SCRIPT_DIR/../data/incidents.db"

# Ensure DB exists
mkdir -p "$(dirname "$DB")"
if [ ! -f "$DB" ]; then
    sqlite3 "$DB" < "$SCRIPT_DIR/incidents-db-init.sql"
fi

CMD="${1:-help}"
shift || true

case "$CMD" in
    log)
        # Parse named arguments
        ALERT="" SEVERITY="" STATUS="" CLUSTER="" NAMESPACE="" SERVICE=""
        VERDICT="" ACTION="" CAUSE="" RESOLUTION="" RELATED_MR="" NOTES="" DURATION=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --alert) ALERT="$2"; shift 2;;
                --severity) SEVERITY="$2"; shift 2;;
                --status) STATUS="$2"; shift 2;;
                --cluster) CLUSTER="$2"; shift 2;;
                --namespace) NAMESPACE="$2"; shift 2;;
                --service) SERVICE="$2"; shift 2;;
                --verdict) VERDICT="$2"; shift 2;;
                --action) ACTION="$2"; shift 2;;
                --cause) CAUSE="$2"; shift 2;;
                --resolution) RESOLUTION="$2"; shift 2;;
                --related-mr) RELATED_MR="$2"; shift 2;;
                --notes) NOTES="$2"; shift 2;;
                --duration) DURATION="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done

        if [ -z "$ALERT" ] || [ -z "$SEVERITY" ] || [ -z "$VERDICT" ] || [ -z "$ACTION" ]; then
            echo "Required: --alert, --severity, --verdict, --action"
            exit 1
        fi

        sqlite3 "$DB" "INSERT INTO incidents (alert_name, severity, status, cluster, namespace, service, verdict, action, cause, resolution, related_mr, notes, investigation_duration_sec) VALUES ('$(echo "$ALERT" | sed "s/'/''/g")', '${SEVERITY}', '${STATUS:-firing}', '${CLUSTER}', '${NAMESPACE}', '${SERVICE}', '${VERDICT}', '${ACTION}', '$(echo "$CAUSE" | sed "s/'/''/g")', '$(echo "$RESOLUTION" | sed "s/'/''/g")', '${RELATED_MR}', '$(echo "$NOTES" | sed "s/'/''/g")', ${DURATION:-NULL});"

        echo "Incident logged: $ALERT ($VERDICT → $ACTION)"
        ;;

    check)
        # Check recent history for an alert name
        ALERT="" CLUSTER="" DAYS=7
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --alert) ALERT="$2"; shift 2;;
                --cluster) CLUSTER="$2"; shift 2;;
                --days) DAYS="$2"; shift 2;;
                *) shift;;
            esac
        done

        WHERE="alert_name = '$(echo "$ALERT" | sed "s/'/''/g")' AND created_at > datetime('now', '-${DAYS} days')"
        [ -n "$CLUSTER" ] && WHERE="$WHERE AND cluster = '$CLUSTER'"

        sqlite3 -header -column "$DB" "SELECT created_at, verdict, action, cause, resolution FROM incidents WHERE $WHERE ORDER BY created_at DESC LIMIT 10;"
        ;;

    fingerprint)
        # Check if a fingerprint has been seen recently
        FP=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --fp) FP="$2"; shift 2;;
                *) shift;;
            esac
        done

        sqlite3 -header -column "$DB" "SELECT created_at, alert_name, verdict, action, cause FROM incidents WHERE fingerprint = '$FP' ORDER BY created_at DESC LIMIT 5;"
        ;;

    patterns)
        # Show recurring patterns from the last N days
        DAYS=7
        [ "${1:-}" = "--days" ] && DAYS="$2"

        echo "=== Recurring Alerts (last ${DAYS} days) ==="
        sqlite3 -header -column "$DB" "SELECT alert_name, cluster, service, COUNT(*) as fires, SUM(CASE WHEN verdict IN ('noise','false_positive','known_issue') THEN 1 ELSE 0 END) as noise, SUM(CASE WHEN verdict = 'real' THEN 1 ELSE 0 END) as real, SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END) as escalated, MAX(created_at) as last_seen FROM incidents WHERE created_at > datetime('now', '-${DAYS} days') GROUP BY alert_name, cluster, service HAVING COUNT(*) > 1 ORDER BY fires DESC;"

        echo ""
        echo "=== Pending Escalations ==="
        sqlite3 -header -column "$DB" "SELECT id, created_at, alert_name, cluster, cause FROM incidents WHERE action = 'escalated' AND escalation_acknowledged = 0 AND created_at > datetime('now', '-3 days') ORDER BY created_at DESC;"
        ;;

    briefing)
        # Generate a startup briefing for the main agent
        DAYS=7
        [ "${1:-}" = "--days" ] && DAYS="$2"

        TOTAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents WHERE created_at > datetime('now', '-${DAYS} days');")
        NOISE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents WHERE verdict IN ('noise','false_positive','known_issue') AND created_at > datetime('now', '-${DAYS} days');")
        REAL=$(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents WHERE verdict = 'real' AND created_at > datetime('now', '-${DAYS} days');")
        FIXED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents WHERE action = 'auto_fixed' AND created_at > datetime('now', '-${DAYS} days');")
        ESCALATED=$(sqlite3 "$DB" "SELECT COUNT(*) FROM incidents WHERE action = 'escalated' AND created_at > datetime('now', '-${DAYS} days');")

        echo "=== SRE Briefing — Last ${DAYS} Days ==="
        echo "Total: ${TOTAL} alerts processed | ${NOISE} noise | ${REAL} real | ${FIXED} auto-fixed | ${ESCALATED} escalated"
        echo ""

        # Recurring noise
        RECURRING=$(sqlite3 -separator ' | ' "$DB" "SELECT alert_name || ' on ' || COALESCE(service, cluster, '?'), COUNT(*) || 'x' FROM incidents WHERE verdict IN ('noise','false_positive','known_issue') AND created_at > datetime('now', '-${DAYS} days') GROUP BY alert_name, service, cluster HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC;")
        if [ -n "$RECURRING" ]; then
            echo "Recurring noise (consider tuning):"
            echo "$RECURRING" | while read -r line; do echo "  - $line"; done
            echo ""
        fi

        # Recent real incidents
        REAL_INCIDENTS=$(sqlite3 -separator '' "$DB" "SELECT '[' || date(created_at) || '] ' || alert_name || ' on ' || COALESCE(service, cluster, '?') || ' — ' || action || CASE WHEN cause IS NOT NULL AND cause != '' THEN ': ' || cause ELSE '' END FROM incidents WHERE verdict = 'real' AND created_at > datetime('now', '-${DAYS} days') ORDER BY created_at DESC LIMIT 10;")
        if [ -n "$REAL_INCIDENTS" ]; then
            echo "Recent real incidents:"
            echo "$REAL_INCIDENTS" | while read -r line; do echo "  - $line"; done
            echo ""
        fi

        # Pending escalations
        PENDING=$(sqlite3 -separator '' "$DB" "SELECT '[' || date(created_at) || '] ' || alert_name || ' on ' || COALESCE(cluster, '?') || ' — ' || COALESCE(cause, 'unknown cause') FROM incidents WHERE action = 'escalated' AND escalation_acknowledged = 0 AND created_at > datetime('now', '-3 days') ORDER BY created_at DESC;")
        if [ -n "$PENDING" ]; then
            echo "Pending escalations (unacknowledged):"
            echo "$PENDING" | while read -r line; do echo "  - $line"; done
            echo ""
        fi

        [ "$TOTAL" = "0" ] && echo "No incidents recorded yet. Fresh start."
        ;;

    resolve)
        # Mark an escalation as acknowledged/resolved
        ID="" RESOLUTION=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --id) ID="$2"; shift 2;;
                --resolution) RESOLUTION="$2"; shift 2;;
                *) shift;;
            esac
        done

        sqlite3 "$DB" "UPDATE incidents SET escalation_acknowledged = 1, resolution = '$(echo "$RESOLUTION" | sed "s/'/''/g")' WHERE id = $ID;"
        echo "Incident $ID marked as resolved."
        ;;

    help|*)
        echo "SRE Agent Incident Memory"
        echo ""
        echo "Commands:"
        echo "  log        Log a new incident (--alert, --severity, --verdict, --action, ...)"
        echo "  check      Check history for an alert (--alert, [--cluster], [--days])"
        echo "  fingerprint  Check a fingerprint (--fp)"
        echo "  patterns   Show recurring patterns ([--days])"
        echo "  briefing   Generate startup briefing ([--days])"
        echo "  resolve    Mark escalation resolved (--id, --resolution)"
        echo ""
        echo "DB location: $DB"
        ;;
esac
