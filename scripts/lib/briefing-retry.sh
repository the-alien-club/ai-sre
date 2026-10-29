# shellcheck shell=bash
# How often start-agent.sh may restart the session because its briefing was not delivered.
#
# A session without its briefing still triages alerts and answers Slack, but blind to recent
# incidents and with CLAUDE.md's placeholder project IDs. When the startup prompt cannot be
# proven submitted, start-agent.sh exits so pm2 starts a fresh session, which usually
# delivers it. Unbounded, a cause that does not go away (a Claude Code UI change) would keep
# the agent restarting and take its triage down with it, so this allows BRIEFING_RETRY_MAX
# such restarts per rolling BRIEFING_RETRY_WINDOW_S. Past that the session keeps running
# without its briefing and the team channel is told.
#
# The state file holds the epoch seconds of each restart in the window, one per line. A file
# that does not parse allows nothing (fail closed) and says so, until someone fixes it.

readonly BRIEFING_RETRY_MAX=2
readonly BRIEFING_RETRY_WINDOW_S=3600

# briefing_retry_take <state-file> <now-epoch-s>: when fewer than BRIEFING_RETRY_MAX restarts
# are recorded in the last BRIEFING_RETRY_WINDOW_S, record one at <now> and succeed, printing
# how many that makes. Otherwise fail, printing why.
briefing_retry_take() {
  local file="$1" now="$2" line recent=() tmp
  if [[ ! "$now" =~ ^[0-9]+$ ]]; then
    echo "invalid time '${now}'"
    return 1
  fi
  if [ -e "$file" ]; then
    if [ ! -r "$file" ]; then
      echo "could not read ${file}"
      return 1
    fi
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ ! "$line" =~ ^[0-9]+$ ]]; then
        echo "${file} is corrupt (line '${line}'); no restart until it is fixed or removed"
        return 1
      fi
      if (( now - line < BRIEFING_RETRY_WINDOW_S )); then recent+=("$line"); fi
    done < "$file"
  fi
  if (( ${#recent[@]} >= BRIEFING_RETRY_MAX )); then
    echo "${#recent[@]} restarts for the briefing in the last $(( BRIEFING_RETRY_WINDOW_S / 60 )) min already"
    return 1
  fi
  tmp="${file}.tmp.$$"
  if ! printf '%s\n' "${recent[@]}" "$now" > "$tmp" || ! mv "$tmp" "$file"; then
    rm -f "$tmp"
    echo "could not write ${file}"
    return 1
  fi
  echo "$(( ${#recent[@]} + 1 )) of ${BRIEFING_RETRY_MAX} in the last $(( BRIEFING_RETRY_WINDOW_S / 60 )) min"
}
