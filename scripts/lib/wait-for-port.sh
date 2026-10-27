# shellcheck shell=bash
# Waiting for the webhook channels' ports, and proving the listener is the new session's.
#
# "Something listens on 8788" is not "this session's channel listens on 8788". A channel
# from the session being replaced, or one orphaned by an earlier crash, can still hold the
# port while the new session starts. The new channel then dies with EADDRINUSE, and a
# check on the port alone passes on the old listener, whose events go to a dead session.
# So start-agent.sh first waits for the ports to be released, and then accepts only a
# listener running under the new session's process tree. Matches are on the exact local
# port, so 8788 is not satisfied by 18788.

# port_listener_pids <port>: the PIDs of the processes listening on TCP <port>, one per
# line. A listener owned by another user shows no PID, and so never counts as ours.
port_listener_pids() {
  ss -Htlnp "sport = :$1" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}

# port_has_listener <port>: whether anything at all listens on TCP <port>.
port_has_listener() {
  ss -Htln "sport = :$1" | grep -q .
}

# parent_pid <pid>: the parent of <pid>, read from /proc so it needs no procps. The
# command name in /proc/<pid>/stat is in parentheses and may itself contain spaces or
# parentheses, so the fields are read after its last ")".
parent_pid() {
  local stat state ppid
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  read -r state ppid _ <<< "${stat##*) }"
  [ -n "$state" ] && printf '%s' "$ppid"
}

# is_descendant <pid> <ancestor-pid>: whether <pid> is <ancestor-pid> or runs under it.
is_descendant() {
  local pid="$1" ancestor="$2"
  while [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )); do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(parent_pid "$pid")" || return 1
  done
  return 1
}

# describe_port_holders <port>: who holds TCP <port>, for an error message.
describe_port_holders() {
  local pid command holders=""
  for pid in $(port_listener_pids "$1"); do
    command="$(tr '\0' ' ' 2>/dev/null < "/proc/${pid}/cmdline" | cut -c1-80)"
    holders+=" pid ${pid} (${command:-exited})"
  done
  printf '%s' "${holders:- a process this user cannot see}"
}

# wait_for_port <label> <port> <timeout-seconds> <session-pid>
#
# Succeeds as soon as a process under <session-pid> listens on TCP <port>; fails once
# <timeout-seconds> have passed, naming the listener when one exists that is not ours.
wait_for_port() {
  local label="$1" port="$2" timeout="$3" session_pid="$4" waited=0 pid
  if [[ ! "$session_pid" =~ ^[0-9]+$ ]]; then
    echo "[start-agent] wait_for_port ${label}: session PID '${session_pid}' is not a PID" >&2
    return 1
  fi
  while true; do
    for pid in $(port_listener_pids "$port"); do
      if is_descendant "$pid" "$session_pid"; then
        echo "[start-agent] ${label} port ${port} bound (pid ${pid})"
        return 0
      fi
    done
    if (( waited >= timeout )); then
      if port_has_listener "$port"; then
        echo "[start-agent] ${label} port ${port} is held by$(describe_port_holders "$port"), not by this session (pid ${session_pid}); its channel could not bind" >&2
      else
        echo "[start-agent] ${label} port ${port} not bound after ${timeout}s" >&2
      fi
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# wait_for_port_free <label> <port> <timeout-seconds>
#
# Succeeds once nothing listens on TCP <port>; fails after <timeout-seconds>, naming the
# process still holding it.
wait_for_port_free() {
  local label="$1" port="$2" timeout="$3" waited=0
  while port_has_listener "$port"; do
    if (( waited >= timeout )); then
      echo "[start-agent] ${label} port ${port} still held by$(describe_port_holders "$port") ${timeout}s after the old session was stopped" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}
