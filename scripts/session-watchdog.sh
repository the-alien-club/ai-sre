#!/usr/bin/env bash
# Session watchdog: restarts the agent when its Claude session has stopped answering.
#
# GET /health/session (channels/session-heartbeat.ts) is 200 while the session answered a
# heartbeat in the last 12 min, and 503 otherwise. A 503 that lasts means the session is
# wedged: rate-limited, stuck compacting, or waiting on a prompt no one will answer. Until
# now that needed a human to notice and run `pm2 restart sre-agent`. This does it, once a
# minute from a systemd timer (provision/systemd/), and bounds itself so it can never loop:
#
# - It restarts only after the probe has been non-200 for MORE than WINDOW_SECONDS on
#   consecutive checks. A gap between two checks longer than MAX_GAP_SECONDS (the timer did
#   not run, the VM rebooted) starts the window again, so an old first failure never counts.
# - A restart ends the window. The new session answers its first heartbeat about 2 min after
#   it starts (503 `never_acked` until then), so the next restart is at least WINDOW_SECONDS
#   plus one check after the previous one.
# - At most RESTART_CAP restarts in any CAP_PERIOD_SECONDS. Past that it logs the refusal on
#   every check and does nothing else: a session that two restarts did not fix needs a human,
#   and sentinel's `sre_agent` hop pages one.
# - Every attempt counts toward the cap, including one pm2 reported as failed.
#
# Every decision is one line on stderr, which systemd sends to the journal with the priority
# in its `<N>` prefix (journalctl -u sre-agent-session-watchdog). stdout is left to pm2.
#
# State, in $STATE_DIRECTORY (systemd's StateDirectory=, /var/lib/sre-agent-watchdog, 0750
# sre-agent):
#   first_failure    epoch seconds of the first non-200 of the current streak; absent if healthy
#   last_check       epoch seconds of the previous check
#   restart_history  epoch seconds of each restart in the last CAP_PERIOD_SECONDS, one per line
#   last_restart     JSON for operators and for GET /health/session (channels/watchdog-restarts.ts):
#                    {"last_restart_at":"<ISO>","restarts_last_hour":N,"restarts":["<ISO>",...]}
#
# Environment (set by the service unit; nothing is defaulted):
#   SRE_WATCHDOG_URL  the session probe, http://127.0.0.1:8788/health/session
#   STATE_DIRECTORY   where the state lives
#
# Every external wait is bounded (CLAUDE_ERROR_PATTERNS.md §14): curl by --max-time, pm2 by
# timeout(1), and the whole run by the unit's TimeoutStartSec.

set -euo pipefail

readonly WINDOW_SECONDS=300
readonly MAX_GAP_SECONDS=180
readonly RESTART_CAP=2
readonly CAP_PERIOD_SECONDS=3600
readonly CURL_CONNECT_TIMEOUT_SECONDS=2
readonly CURL_MAX_TIME_SECONDS=5
readonly PM2_TIMEOUT_SECONDS=120
readonly PM2_APP=sre-agent

readonly URL="${SRE_WATCHDOG_URL:?SRE_WATCHDOG_URL must be set to the session probe URL}"
readonly STATE_DIR="${STATE_DIRECTORY:?STATE_DIRECTORY must be set to the watchdog state directory}"

readonly FIRST_FAILURE_FILE="$STATE_DIR/first_failure"
readonly LAST_CHECK_FILE="$STATE_DIR/last_check"
readonly HISTORY_FILE="$STATE_DIR/restart_history"
readonly LAST_RESTART_FILE="$STATE_DIR/last_restart"
readonly LOCK_FILE="$STATE_DIR/lock"

# log <priority> <message>: one journal line. 3 err, 4 warning, 6 info. On stderr, so a log
# line inside a command substitution is never captured as its value.
log() {
  local priority="$1"
  shift
  printf '<%s>[session-watchdog] %s\n' "$priority" "$*" >&2
}

is_epoch() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

iso_time() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ
}

# write_atomically <file> <content>: never leaves a half-written file behind for a reader.
write_atomically() {
  local tmp="$1.tmp.$$"
  printf '%s\n' "$2" > "$tmp"
  mv -f "$tmp" "$1"
}

# read_epoch <file>: the epoch in <file>, or nothing if the file is absent. Fails on a file
# that holds anything else, so corrupt state is never mistaken for "no state".
read_epoch() {
  local value
  [ -e "$1" ] || return 0
  value="$(< "$1")"
  if ! is_epoch "$value"; then
    log 3 "state file $1 does not hold an epoch: '${value}'"
    return 1
  fi
  printf '%s' "$value"
}

# recent_restarts <now>: the restart epochs younger than CAP_PERIOD_SECONDS, one per line.
# Fails on a corrupt history: the cap cannot be enforced without it, so nothing may restart.
recent_restarts() {
  local now="$1" line
  [ -e "$HISTORY_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    if ! is_epoch "$line"; then
      log 3 "restart history $HISTORY_FILE holds '${line}', not an epoch; refusing to restart until it is fixed"
      return 1
    fi
    if (( now - line < CAP_PERIOD_SECONDS )); then
      printf '%s\n' "$line"
    fi
  done < "$HISTORY_FILE"
}

# record_restart <epoch>...: rewrites the history and last_restart from the restart epochs of
# the last hour, the newest last.
record_restart() {
  local epoch history="" isos=""
  for epoch in "$@"; do
    history+="${epoch}"$'\n'
    isos+="${isos:+,}\"$(iso_time "$epoch")\""
  done
  write_atomically "$HISTORY_FILE" "${history%$'\n'}"
  write_atomically "$LAST_RESTART_FILE" \
    "{\"last_restart_at\":\"$(iso_time "${*: -1}")\",\"restarts_last_hour\":$#,\"restarts\":[${isos}]}"
}

# probe: sets PROBE_CODE (000 when there was no HTTP answer) and PROBE_DETAIL (the body's
# `status`, or curl's exit code). curl's own message goes to stderr, and so to the journal.
probe() {
  local response curl_status=0
  response="$(curl -sS --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" --max-time "$CURL_MAX_TIME_SECONDS" \
    -w '\n%{http_code}' "$URL")" || curl_status=$?
  PROBE_CODE="${response##*$'\n'}"
  [[ "$PROBE_CODE" =~ ^[0-9]{3}$ ]] || PROBE_CODE=000
  if (( curl_status != 0 )); then
    PROBE_DETAIL="curl exit ${curl_status}"
  elif [[ "${response%$'\n'*}" =~ \"status\"[[:space:]]*:[[:space:]]*\"([a-z_]+)\" ]]; then
    PROBE_DETAIL="${BASH_REMATCH[1]}"
  else
    PROBE_DETAIL="no status in the body"
  fi
}

# restart_agent <now> <streak-seconds>
restart_agent() {
  local now="$1" streak="$2" listed
  local -a recent=()
  listed="$(recent_restarts "$now")" || return 1
  [ -z "$listed" ] || mapfile -t recent <<< "$listed"

  if (( ${#recent[@]} >= RESTART_CAP )); then
    log 4 "session unhealthy for ${streak}s (HTTP ${PROBE_CODE}, ${PROBE_DETAIL}), but ${#recent[@]} restarts in the last hour reached the cap of ${RESTART_CAP}; not restarting"
    return 0
  fi

  # The window ends here, whatever pm2 answers: the next restart needs a whole new window.
  # The attempt is recorded before pm2 runs, so one that hangs or is killed still counts.
  rm -f "$FIRST_FAILURE_FILE"
  record_restart "${recent[@]}" "$now"
  log 4 "session unhealthy for ${streak}s (HTTP ${PROBE_CODE}, ${PROBE_DETAIL}); running pm2 restart ${PM2_APP} (restart $(( ${#recent[@]} + 1 )) of ${RESTART_CAP} this hour)"
  if ! timeout "$PM2_TIMEOUT_SECONDS" pm2 restart "$PM2_APP"; then
    log 3 "pm2 restart ${PM2_APP} failed or did not finish in ${PM2_TIMEOUT_SECONDS}s; it still counts toward the cap"
    return 1
  fi
  log 6 "pm2 restart ${PM2_APP} done; another restart needs ${WINDOW_SECONDS}s of failures from the next check"
}

# read_streak_epoch <file>: like read_epoch, but a corrupt first_failure or last_check only
# restarts the window. That can delay a restart, never cause one.
read_streak_epoch() {
  if ! read_epoch "$1"; then
    log 4 "ignoring the corrupt $1; the failure window starts again"
    rm -f "$1"
  fi
}

main() {
  local now first_failure last_check streak

  exec 9> "$LOCK_FILE"
  if ! flock -n 9; then
    log 4 "another watchdog run holds ${LOCK_FILE}; skipping this check"
    return 0
  fi

  now="$(date +%s)"
  if ! is_epoch "$now"; then
    log 3 "the clock returned '${now}', not an epoch"
    return 1
  fi
  first_failure="$(read_streak_epoch "$FIRST_FAILURE_FILE")"
  last_check="$(read_streak_epoch "$LAST_CHECK_FILE")"
  write_atomically "$LAST_CHECK_FILE" "$now"

  probe

  if [ "$PROBE_CODE" = 200 ]; then
    if [ -n "$first_failure" ]; then
      log 6 "session healthy again (HTTP 200, ${PROBE_DETAIL}) after $((now - first_failure))s of failures; window cleared"
      rm -f "$FIRST_FAILURE_FILE"
    else
      log 6 "session healthy (HTTP 200, ${PROBE_DETAIL})"
    fi
    return 0
  fi

  if [ -z "$first_failure" ]; then
    write_atomically "$FIRST_FAILURE_FILE" "$now"
    log 4 "session unhealthy (HTTP ${PROBE_CODE}, ${PROBE_DETAIL}); window of ${WINDOW_SECONDS}s starts"
    return 0
  fi

  if [ -z "$last_check" ] || (( now - last_check > MAX_GAP_SECONDS )); then
    local previous="not recorded"
    [ -z "$last_check" ] || previous="$((now - last_check))s ago"
    write_atomically "$FIRST_FAILURE_FILE" "$now"
    log 4 "session unhealthy (HTTP ${PROBE_CODE}, ${PROBE_DETAIL}), but the previous check was ${previous}; the failures are not consecutive, window of ${WINDOW_SECONDS}s starts again"
    return 0
  fi

  streak=$((now - first_failure))
  if (( streak <= WINDOW_SECONDS )); then
    log 6 "session unhealthy for ${streak}s (HTTP ${PROBE_CODE}, ${PROBE_DETAIL}); restart only after ${WINDOW_SECONDS}s"
    return 0
  fi

  restart_agent "$now" "$streak"
}

main "$@"
