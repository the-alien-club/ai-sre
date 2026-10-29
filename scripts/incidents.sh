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
#   ./scripts/incidents.sh correct --id 42 --verdict noise --by Leo

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# INCIDENTS_DB exists so the tests can point at a scratch database; production uses the default
DB="${INCIDENTS_DB:-$SCRIPT_DIR/../data/incidents.db}"
# The runbook proposal store slack-sre keeps beside the database (channels/proposal-store.ts)
KEDB_PROPOSALS="$(dirname "$DB")/kedb-proposals.json"

# Every value reaching SQL goes through one of these two helpers, never string interpolation.
# Arguments come from alert labels and sub-agent output, so they are attacker-influenced:
# a fingerprint or cluster name containing a quote used to be able to rewrite the query.

# Encode text as a hex blob literal cast back to TEXT. The literal can only contain
# [0-9a-f], so no input can terminate it, whatever quotes or semicolons it carries.
sql_text() {
    printf "CAST(X'%s' AS TEXT)" "$(printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n')"
}

# Validate a non-negative integer argument; anything else is a usage error, not a default.
# At most 9 digits: every count, id and day window fits, and SQLite never sees an
# integer large enough to overflow or turn into a float.
sql_int() {
    local name="$1" value="$2"
    if [[ ! "$value" =~ ^[0-9]{1,9}$ ]]; then
        echo "Invalid $name: expected a non-negative integer of at most 9 digits, got '$value'" >&2
        exit 1
    fi
    printf '%s' "$value"
}

# Bounds on the startup briefing (see `briefing`): alert classes listed per section, and
# the longest name or cause shown before it is clipped.
readonly BRIEFING_CLASSES=10
readonly BRIEFING_NAME_CHARS=80
readonly BRIEFING_CAUSE_CHARS=160

# SQL for <expression> on one line and at most <max> characters, ending in "…" when
# clipped. Line breaks become spaces, so a multi-line cause cannot break the line layout.
sql_clip() {
    local flat="replace(replace($1, char(13), ' '), char(10), ' ')" max="$2"
    printf "CASE WHEN length(%s) > %d THEN substr(%s, 1, %d) || '…' ELSE %s END" \
        "$flat" "$max" "$flat" "$((max - 1))" "$flat"
}

# more_classes <count> <command>: the line saying how many classes the section left out.
more_classes() {
    if (( $1 > BRIEFING_CLASSES )); then
        echo "  … and $(( $1 - BRIEFING_CLASSES )) more alert classes: $2"
    fi
}

# Vocabularies the CLI validates. VERDICTS is incidents.verdict's; ACTION_LADDER is the KEDB's
# (sre-kedb schema), lowest first; CORROBORATION_RESULTS are what a sub-agent reports per check.
readonly VERDICTS="real noise false_positive known_issue flapping"
readonly KEDB_MATCHES="exact family none"
readonly ACTION_LADDER="ignore log fyi ticket escalate page"
readonly CORROBORATION_RESULTS="pass fail not-run"
readonly KEDB_ID_RE='^[a-z0-9][a-z0-9-]*/(_family|[a-z0-9][a-z0-9-]*)$'
readonly KEDB_REV_RE='^[0-9a-f]{7,40}$'

# one_of <name> <value> <allowed words>: the value, or a usage error naming what is allowed.
one_of() {
    local name="$1" value="$2" allowed="$3" word
    for word in $allowed; do
        if [ "$value" = "$word" ]; then printf '%s' "$value"; return 0; fi
    done
    echo "Invalid $name: expected one of: $allowed; got '$value'" >&2
    exit 1
}

# matching <name> <value> <ERE>: the value when it matches the pattern, or a usage error.
matching() {
    local name="$1" value="$2" pattern="$3"
    if [[ ! "$value" =~ $pattern ]]; then
        echo "Invalid $name: '$value' does not match $pattern" >&2
        exit 1
    fi
    printf '%s' "$value"
}

# SQL for an optional text value: NULL when empty, so "not reported" stays distinguishable
# from an empty report in the KEDB columns.
sql_text_or_null() {
    if [ -z "$1" ]; then printf 'NULL'; else sql_text "$1"; fi
}

# Run SQL read from stdin against the database. The statement never travels as a
# command-line argument: hex-encoded values double its size, and a long cause or note
# would otherwise hit the kernel's argument length limit ("Argument list too long").
# -bail makes any SQL error a non-zero exit.
sql_run() {
    sqlite3 -bail "$@" "$DB"
}

# Ensure DB exists
mkdir -p "$(dirname "$DB")"
if [ ! -f "$DB" ]; then
    sqlite3 "$DB" < "$SCRIPT_DIR/incidents-db-init.sql"
fi

# KEDB columns on incidents (plan §6). The init SQL runs only when the file is missing, so an
# existing database gains them here, on any command, idempotently: a column is added only when
# pragma table_info does not list it. Two invocations racing may both try; the loser's ALTER
# fails with "duplicate column", which is fine as long as the column exists afterwards.
readonly KEDB_COLUMNS="kedb_id kedb_rev kedb_match kedb_predicted_verdict kedb_predicted_action corroboration operator_verdict operator_verdict_by operator_verdict_at"
ensure_kedb_columns() {
    local existing column error
    existing="$(sql_run <<< "SELECT name FROM pragma_table_info('incidents');")" || return 1
    for column in $KEDB_COLUMNS; do
        grep -qx "$column" <<< "$existing" && continue
        if ! error="$(sql_run <<< "ALTER TABLE incidents ADD COLUMN ${column} TEXT;" 2>&1)"; then
            if ! sql_run <<< "SELECT name FROM pragma_table_info('incidents');" | grep -qx "$column"; then
                echo "Could not add column ${column} to incidents in $DB: $error" >&2
                return 1
            fi
        fi
    done
}
ensure_kedb_columns || exit 1

CMD="${1:-help}"
shift || true

case "$CMD" in
    log)
        # Parse named arguments
        ALERT="" SEVERITY="" STATUS="" CLUSTER="" NAMESPACE="" SERVICE=""
        VERDICT="" ACTION="" CAUSE="" RESOLUTION="" RELATED_MR="" NOTES="" DURATION="" FP=""
        KEDB_ID="" KEDB_REV="" KEDB_MATCH="" KEDB_PRED_VERDICT="" KEDB_PRED_ACTION="" CORROBORATION=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --alert) ALERT="$2"; shift 2;;
                --severity) SEVERITY="$2"; shift 2;;
                --status) STATUS="$2"; shift 2;;
                --cluster) CLUSTER="$2"; shift 2;;
                --namespace) NAMESPACE="$2"; shift 2;;
                --service) SERVICE="$2"; shift 2;;
                --fingerprint|--fp) FP="$2"; shift 2;;
                --verdict) VERDICT="$2"; shift 2;;
                --action) ACTION="$2"; shift 2;;
                --cause) CAUSE="$2"; shift 2;;
                --resolution) RESOLUTION="$2"; shift 2;;
                --related-mr) RELATED_MR="$2"; shift 2;;
                --notes) NOTES="$2"; shift 2;;
                --duration) DURATION="$2"; shift 2;;
                --kedb-id) KEDB_ID="$2"; shift 2;;
                --kedb-rev) KEDB_REV="$2"; shift 2;;
                --kedb-match) KEDB_MATCH="$2"; shift 2;;
                --kedb-predicted-verdict) KEDB_PRED_VERDICT="$2"; shift 2;;
                --kedb-predicted-action) KEDB_PRED_ACTION="$2"; shift 2;;
                --corroboration) CORROBORATION="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done

        if [ -z "$ALERT" ] || [ -z "$SEVERITY" ] || [ -z "$VERDICT" ] || [ -z "$ACTION" ]; then
            echo "Required: --alert, --severity, --verdict, --action"
            exit 1
        fi

        # The KEDB flags are copied from the alert's channel meta; each is optional, but a
        # value given must be well formed, since the KEDB metrics are computed from them.
        [ -n "$KEDB_MATCH" ] && { KEDB_MATCH="$(one_of --kedb-match "$KEDB_MATCH" "$KEDB_MATCHES")" || exit 1; }
        [ -n "$KEDB_ID" ] && { KEDB_ID="$(matching --kedb-id "$KEDB_ID" "$KEDB_ID_RE")" || exit 1; }
        [ -n "$KEDB_REV" ] && { KEDB_REV="$(matching --kedb-rev "$KEDB_REV" "$KEDB_REV_RE")" || exit 1; }
        [ -n "$KEDB_PRED_VERDICT" ] && { KEDB_PRED_VERDICT="$(one_of --kedb-predicted-verdict "$KEDB_PRED_VERDICT" "$VERDICTS")" || exit 1; }
        [ -n "$KEDB_PRED_ACTION" ] && { KEDB_PRED_ACTION="$(one_of --kedb-predicted-action "$KEDB_PRED_ACTION" "$ACTION_LADDER")" || exit 1; }
        if [ -n "$KEDB_ID" ] && [ "$KEDB_MATCH" != "exact" ] && [ "$KEDB_MATCH" != "family" ]; then
            echo "--kedb-id needs --kedb-match exact or family" >&2
            exit 1
        fi
        if [ -n "$CORROBORATION" ]; then
            # A JSON object of check id -> pass|fail|not-run, checked by SQLite's own JSON parser.
            # CASE, not AND: SQLite may evaluate both sides of an AND, and json_type raises on
            # malformed JSON where json_valid only returns 0.
            VALID="$(sql_run <<< "SELECT CASE WHEN json_valid(v) THEN json_type(v) = 'object' AND NOT EXISTS (SELECT 1 FROM json_each(v) WHERE type != 'text' OR value NOT IN ('pass','fail','not-run') OR key NOT GLOB '[a-z0-9]*' OR key GLOB '*[^a-z0-9-]*') ELSE 0 END FROM (SELECT $(sql_text "$CORROBORATION") AS v);")" || exit 1
            if [ "$VALID" != "1" ]; then
                echo "Invalid --corroboration: expected a JSON object of check id -> one of: $CORROBORATION_RESULTS; got '$CORROBORATION'" >&2
                exit 1
            fi
        fi

        DURATION_SQL="NULL"
        if [ -n "$DURATION" ]; then
            DURATION_SQL="$(sql_int --duration "$DURATION")" || exit 1
        fi

        sql_run <<< "INSERT INTO incidents (alert_name, fingerprint, severity, status, cluster, namespace, service, verdict, action, cause, resolution, related_mr, notes, investigation_duration_sec, kedb_id, kedb_rev, kedb_match, kedb_predicted_verdict, kedb_predicted_action, corroboration) VALUES ($(sql_text "$ALERT"), $(sql_text "$FP"), $(sql_text "$SEVERITY"), $(sql_text "${STATUS:-firing}"), $(sql_text "$CLUSTER"), $(sql_text "$NAMESPACE"), $(sql_text "$SERVICE"), $(sql_text "$VERDICT"), $(sql_text "$ACTION"), $(sql_text "$CAUSE"), $(sql_text "$RESOLUTION"), $(sql_text "$RELATED_MR"), $(sql_text "$NOTES"), ${DURATION_SQL}, $(sql_text_or_null "$KEDB_ID"), $(sql_text_or_null "$KEDB_REV"), $(sql_text_or_null "$KEDB_MATCH"), $(sql_text_or_null "$KEDB_PRED_VERDICT"), $(sql_text_or_null "$KEDB_PRED_ACTION"), $(sql_text_or_null "$CORROBORATION"));" || exit 1

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

        DAYS="$(sql_int --days "$DAYS")" || exit 1
        WHERE="alert_name = $(sql_text "$ALERT") AND created_at > datetime('now', '-${DAYS} days')"
        [ -n "$CLUSTER" ] && WHERE="$WHERE AND cluster = $(sql_text "$CLUSTER")"

        sql_run -header -column <<< "SELECT created_at, verdict, action, cause, resolution FROM incidents WHERE $WHERE ORDER BY created_at DESC LIMIT 10;"
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

        sql_run -header -column <<< "SELECT created_at, alert_name, verdict, action, cause FROM incidents WHERE fingerprint = $(sql_text "$FP") ORDER BY created_at DESC LIMIT 5;"
        ;;

    patterns)
        # Show recurring patterns from the last N days
        DAYS=7
        [ "${1:-}" = "--days" ] && DAYS="$2"
        DAYS="$(sql_int --days "$DAYS")" || exit 1

        echo "=== Recurring Alerts (last ${DAYS} days) ==="
        sql_run -header -column <<< "SELECT alert_name, cluster, service, COUNT(*) as fires, SUM(CASE WHEN verdict IN ('noise','false_positive','known_issue') THEN 1 ELSE 0 END) as noise, SUM(CASE WHEN verdict = 'real' THEN 1 ELSE 0 END) as real, SUM(CASE WHEN action = 'escalated' THEN 1 ELSE 0 END) as escalated, MAX(created_at) as last_seen FROM incidents WHERE created_at > datetime('now', '-${DAYS} days') GROUP BY alert_name, cluster, service HAVING COUNT(*) > 1 ORDER BY fires DESC;"

        echo ""
        echo "=== Pending Escalations ==="
        sql_run -header -column <<< "SELECT id, created_at, alert_name, cluster, cause FROM incidents WHERE action = 'escalated' AND escalation_acknowledged = 0 AND created_at > datetime('now', '-3 days') ORDER BY created_at DESC;"
        ;;

    briefing)
        # Generate a startup briefing for the main agent. It is pasted into the agent's
        # first prompt, so its size must not grow with the number of incidents: one alert
        # class (263 Trivy findings in 3 days) once made it 50KB. Each section is
        # summarised per alert class, capped at a fixed number of classes, and every
        # free-text value is clipped, so the briefing stays a few KB whatever the database
        # holds. The detail is one `check`, `patterns` or `timeline` away.
        DAYS=7
        [ "${1:-}" = "--days" ] && DAYS="$2"
        DAYS="$(sql_int --days "$DAYS")" || exit 1
        WINDOW="created_at > datetime('now', '-${DAYS} days')"
        NOISY="verdict IN ('noise','false_positive','known_issue')"
        PENDING_WINDOW="action = 'escalated' AND escalation_acknowledged = 0 AND created_at > datetime('now', '-3 days')"
        NAME="$(sql_clip alert_name "$BRIEFING_NAME_CHARS")"
        LOCATION="$(sql_clip "COALESCE(service || ' @ ' || cluster, service, cluster, '?')" "$BRIEFING_NAME_CHARS")"
        CAUSE="CASE WHEN cause IS NOT NULL AND cause != '' THEN ': ' || $(sql_clip cause "$BRIEFING_CAUSE_CHARS") ELSE '' END"

        TOTAL=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE ${WINDOW};") || exit 1
        NOISE=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE ${NOISY} AND ${WINDOW};") || exit 1
        REAL=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE verdict = 'real' AND ${WINDOW};") || exit 1
        FIXED=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE action = 'auto_fixed' AND ${WINDOW};") || exit 1
        ESCALATED=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE action = 'escalated' AND ${WINDOW};") || exit 1

        echo "=== SRE Briefing — Last ${DAYS} Days ==="
        echo "Total: ${TOTAL} alerts processed | ${NOISE} noise | ${REAL} real | ${FIXED} auto-fixed | ${ESCALATED} escalated"
        echo ""

        # Recurring noise: one line per alert, service and cluster that was noise 3+ times
        NOISE_CLASSES="SELECT alert_name, NULLIF(service, '') AS service, NULLIF(cluster, '') AS cluster, COUNT(*) AS fires FROM incidents WHERE ${NOISY} AND ${WINDOW} GROUP BY 1, 2, 3 HAVING COUNT(*) >= 3"
        NOISE_COUNT=$(sql_run <<< "SELECT COUNT(*) FROM (${NOISE_CLASSES});") || exit 1
        if [ "$NOISE_COUNT" != "0" ]; then
            echo "Recurring noise (consider tuning):"
            sql_run <<< "SELECT '  - ' || ${NAME} || ' on ' || ${LOCATION} || ' | ' || fires || 'x' FROM (${NOISE_CLASSES}) ORDER BY fires DESC, alert_name LIMIT ${BRIEFING_CLASSES};" || exit 1
            more_classes "$NOISE_COUNT" "./scripts/incidents.sh patterns --days ${DAYS}"
            echo ""
        fi

        # Real incidents: one line per alert, service and cluster, with its latest outcome
        REAL_CLASSES="SELECT *, COUNT(*) OVER (PARTITION BY alert_name, service, cluster) AS fires, ROW_NUMBER() OVER (PARTITION BY alert_name, service, cluster ORDER BY created_at DESC, id DESC) AS latest FROM (SELECT id, created_at, alert_name, NULLIF(service, '') AS service, NULLIF(cluster, '') AS cluster, action, cause FROM incidents WHERE verdict = 'real' AND ${WINDOW})"
        REAL_COUNT=$(sql_run <<< "SELECT COUNT(*) FROM (${REAL_CLASSES}) WHERE latest = 1;") || exit 1
        if [ "$REAL_COUNT" != "0" ]; then
            echo "Recent real incidents (${REAL} in ${REAL_COUNT} alert classes, latest first):"
            sql_run <<< "SELECT '  - [' || date(created_at) || '] ' || ${NAME} || ' on ' || ${LOCATION} || ' — ' || fires || 'x, latest ' || action || ${CAUSE} FROM (${REAL_CLASSES}) WHERE latest = 1 ORDER BY created_at DESC, id DESC LIMIT ${BRIEFING_CLASSES};" || exit 1
            more_classes "$REAL_COUNT" "./scripts/incidents.sh check --alert <name> --days ${DAYS}"
            echo ""
        fi

        # Pending escalations: one line per alert, with every cluster it is pending on
        PENDING_CLASSES="SELECT *, COUNT(*) OVER (PARTITION BY alert_name) AS fires, ROW_NUMBER() OVER (PARTITION BY alert_name ORDER BY created_at DESC, id DESC) AS latest FROM (SELECT id, created_at, alert_name, NULLIF(cluster, '') AS cluster, cause FROM incidents WHERE ${PENDING_WINDOW})"
        PENDING_CLUSTERS="SELECT alert_name, group_concat(DISTINCT NULLIF(cluster, '')) AS clusters FROM incidents WHERE ${PENDING_WINDOW} GROUP BY alert_name"
        PENDING=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE ${PENDING_WINDOW};") || exit 1
        PENDING_COUNT=$(sql_run <<< "SELECT COUNT(*) FROM (${PENDING_CLASSES}) WHERE latest = 1;") || exit 1
        if [ "$PENDING_COUNT" != "0" ]; then
            echo "Pending escalations (unacknowledged, last 3 days: ${PENDING} in ${PENDING_COUNT} alert classes, latest first):"
            sql_run <<< "SELECT '  - [' || date(p.created_at) || '] ' || ${NAME} || ' — ' || p.fires || 'x' || COALESCE(' on ' || $(sql_clip c.clusters "$BRIEFING_NAME_CHARS"), '') || ' (latest #' || p.id || ')' || ${CAUSE} FROM (${PENDING_CLASSES}) AS p JOIN (${PENDING_CLUSTERS}) AS c USING (alert_name) WHERE p.latest = 1 ORDER BY p.created_at DESC, p.id DESC LIMIT ${BRIEFING_CLASSES};" || exit 1
            more_classes "$PENDING_COUNT" "./scripts/incidents.sh patterns --days 3"
            echo ""
        fi

        # KEDB: how its predictions fared, and which entries got it wrong. An entry mispredicts
        # when its predicted verdict differs from the final one: the operator's correction if
        # there is one, else the agent's. Only exact matches predict anything.
        KEDB_ROWS=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE kedb_match IS NOT NULL AND ${WINDOW};") || exit 1
        if [ "$KEDB_ROWS" != "0" ]; then
            FINAL="COALESCE(NULLIF(operator_verdict, ''), verdict)"
            EXACT=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE kedb_match = 'exact' AND ${WINDOW};") || exit 1
            FAMILY=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE kedb_match = 'family' AND ${WINDOW};") || exit 1
            PREDICTED="kedb_match = 'exact' AND kedb_predicted_verdict IS NOT NULL AND ${WINDOW}"
            PREDICTIONS=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE ${PREDICTED};") || exit 1
            RIGHT=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE ${PREDICTED} AND kedb_predicted_verdict = ${FINAL};") || exit 1
            CORRECTED=$(sql_run <<< "SELECT COUNT(*) FROM incidents WHERE operator_verdict IS NOT NULL AND ${WINDOW};") || exit 1
            echo "KEDB: ${KEDB_ROWS} logged with a KEDB match field | ${EXACT} exact | ${FAMILY} family only | predictions right ${RIGHT}/${PREDICTIONS} | ${CORRECTED} corrected by an operator"

            WRONG_CLASSES="SELECT kedb_id, COUNT(*) AS wrong, group_concat(DISTINCT kedb_predicted_verdict || '→' || ${FINAL}) AS how FROM incidents WHERE ${PREDICTED} AND kedb_predicted_verdict != ${FINAL} GROUP BY kedb_id"
            WRONG_COUNT=$(sql_run <<< "SELECT COUNT(*) FROM (${WRONG_CLASSES});") || exit 1
            if [ "$WRONG_COUNT" != "0" ]; then
                echo "Entries that mispredicted (review them; 2+ is a wrong entry):"
                sql_run <<< "SELECT '  - ' || $(sql_clip kedb_id "$BRIEFING_NAME_CHARS") || ' | ' || wrong || 'x (' || $(sql_clip how "$BRIEFING_NAME_CHARS") || ')' FROM (${WRONG_CLASSES}) ORDER BY wrong DESC, kedb_id LIMIT ${BRIEFING_CLASSES};" || exit 1
                if (( WRONG_COUNT > BRIEFING_CLASSES )); then
                    echo "  … and $(( WRONG_COUNT - BRIEFING_CLASSES )) more entries"
                fi
            fi
            echo ""
        fi

        # Runbook proposals still open (KEDB learning loop, plan §4). slack-sre writes the store;
        # no file means no proposal was ever made. Unreadable, the briefing says so and goes on:
        # the loop refuses to run on it too, and the agent must hear why.
        if [ -f "$KEDB_PROPOSALS" ]; then
            if PROPOSALS_OUT=$(jq -r --argjson now "$(date +%s)" --argjson max "$BRIEFING_CLASSES" '
                [ .proposals | group_by(.id)[] | max_by(.rev)
                  | select(.status == "pending" or .status == "approved" or .status == "failed" or .status == "stale") ]
                | sort_by(.posted_at // .created_at)
                | if length == 0 then empty else
                    "Runbook proposals open (\(length)); approvers answer them in their Slack threads:",
                    (.[:$max][]
                      | "  - \(.id) rev \(.rev) \(.status)\(if .downgrade then " (downgrade)" else "" end): \(.entry_id), incident #\(.incident_id), \((($now * 1000 - (.posted_at // .created_at)) / 86400000) | floor)d old"
                        + (if .status == "failed" then ", retry with apply_runbook_update" elif .status == "stale" then ", re-propose with supersedes" else "" end)
                        + (if .status_reason then " (" + (.status_reason | gsub("[\r\n]+"; " ") | .[0:120]) + ")" else "" end)),
                    (if length > $max then "  … and \(length - $max) more: list_runbook_proposals" else empty end)
                  end' "$KEDB_PROPOSALS" 2>&1); then
                if [ -n "$PROPOSALS_OUT" ]; then
                    printf '%s\n\n' "$PROPOSALS_OUT"
                fi
            else
                echo "Runbook proposals: ${KEDB_PROPOSALS} is unreadable (${PROPOSALS_OUT:0:200}); the learning loop is off until it is fixed."
                echo ""
            fi
        fi

        # An if, not `[ ... ] && echo`: as the last command that form made briefing exit 1
        # whenever incidents existed, and start-agent.sh then appended its failure fallback
        if [ "$TOTAL" = "0" ]; then
            echo "No incidents recorded yet. Fresh start."
        fi
        ;;

    context)
        # Write a context note for an ongoing investigation
        FP="" PHASE="" CONTENT="" AUTHOR="sub-agent" INCIDENT_ID=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --fp) FP="$2"; shift 2;;
                --phase) PHASE="$2"; shift 2;;
                --content) CONTENT="$2"; shift 2;;
                --author) AUTHOR="$2"; shift 2;;
                --incident-id) INCIDENT_ID="$2"; shift 2;;
                *) echo "Unknown arg: $1"; exit 1;;
            esac
        done

        if [ -z "$FP" ] || [ -z "$PHASE" ] || [ -z "$CONTENT" ]; then
            echo "Required: --fp, --phase (triage|investigation|diagnosis|fix|verification|resolution), --content"
            exit 1
        fi

        INCIDENT_ID_SQL="NULL"
        if [ -n "$INCIDENT_ID" ]; then
            INCIDENT_ID_SQL="$(sql_int --incident-id "$INCIDENT_ID")" || exit 1
        fi

        sql_run <<< "INSERT INTO incident_context (fingerprint, incident_id, author, phase, content) VALUES ($(sql_text "$FP"), ${INCIDENT_ID_SQL}, $(sql_text "$AUTHOR"), $(sql_text "$PHASE"), $(sql_text "$CONTENT"));" || exit 1
        echo "Context saved: [$PHASE] for $FP"
        ;;

    timeline)
        # Get the full investigation timeline for a fingerprint
        FP=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --fp) FP="$2"; shift 2;;
                *) shift;;
            esac
        done

        if [ -z "$FP" ]; then
            echo "Required: --fp <fingerprint>"
            exit 1
        fi

        echo "=== Incident Timeline for $FP ==="
        echo ""

        # Incident log entries
        echo "--- Incident Log ---"
        sql_run -header -column <<< "SELECT id, created_at, alert_name, severity, verdict, action, cause, resolution FROM incidents WHERE fingerprint = $(sql_text "$FP") ORDER BY created_at;"

        echo ""
        echo "--- Investigation Context ---"
        sql_run -separator '' <<< "SELECT '[' || created_at || '] [' || phase || '] (' || author || ') ' || content FROM incident_context WHERE fingerprint = $(sql_text "$FP") ORDER BY created_at;"
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

        if [ -z "$ID" ]; then
            echo "Required: --id"
            exit 1
        fi
        ID="$(sql_int --id "$ID")" || exit 1

        UPDATED="$(sql_run <<< "UPDATE incidents SET escalation_acknowledged = 1, resolution = $(sql_text "$RESOLUTION") WHERE id = ${ID}; SELECT changes();")" || exit 1
        if [ "$UPDATED" != "1" ]; then
            echo "No incident with id $ID; nothing resolved" >&2
            exit 1
        fi
        echo "Incident $ID marked as resolved."
        ;;

    correct)
        # Record an operator's verdict when it differs from the agent's (e.g. Leo in the
        # thread: "that was noise"). The agent's own verdict is kept; the KEDB metrics read
        # COALESCE(operator_verdict, verdict).
        ID="" VERDICT="" BY=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --id) ID="$2"; shift 2;;
                --verdict) VERDICT="$2"; shift 2;;
                --by) BY="$2"; shift 2;;
                *) echo "Unknown arg: $1" >&2; exit 1;;
            esac
        done

        if [ -z "$ID" ] || [ -z "$VERDICT" ] || [ -z "$BY" ]; then
            echo "Required: --id, --verdict ($VERDICTS), --by <operator name>" >&2
            exit 1
        fi
        ID="$(sql_int --id "$ID")" || exit 1
        VERDICT="$(one_of --verdict "$VERDICT" "$VERDICTS")" || exit 1

        UPDATED="$(sql_run <<< "UPDATE incidents SET operator_verdict = $(sql_text "$VERDICT"), operator_verdict_by = $(sql_text "$BY"), operator_verdict_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ${ID}; SELECT changes();")" || exit 1
        if [ "$UPDATED" != "1" ]; then
            echo "No incident with id $ID; nothing corrected" >&2
            exit 1
        fi
        echo "Incident $ID: operator verdict $VERDICT (by $BY)."
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
        echo "  context    Save investigation context (--fp, --phase, --content, [--author])"
        echo "  timeline   Full investigation timeline (--fp)"
        echo "  resolve    Mark escalation resolved (--id, --resolution)"
        echo "  correct    Record an operator's verdict (--id, --verdict, --by)"
        echo ""
        echo "log also takes the KEDB fields from the alert's meta: --kedb-id, --kedb-rev,"
        echo "  --kedb-match (exact|family|none), --kedb-predicted-verdict, --kedb-predicted-action,"
        echo "  --corroboration '{\"<check id>\":\"pass|fail|not-run\"}'"
        echo ""
        echo "DB location: $DB"
        ;;
esac
