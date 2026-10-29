# shellcheck shell=bash
# Keeping the Claude session in pm2's cgroup, out of any login's systemd user manager.
#
# tmux 3.4 (Ubuntu builds it with systemd support) moves every new pane into a transient
# scope of the user's systemd manager, user@<uid>.service, whenever it can reach that
# manager's bus. pm2 hands its apps the environment of the shell that last ran `pm2 restart`
# or `pm2 start`, so after an operator restarted the agent over SSH, start-agent.sh carried
# that login's XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, and tmux found the bus. The
# Claude pane then lived in a tmux-spawn-*.scope of user@1001.service. The user has no
# linger, so when the last SSH login ended, systemd stopped user@1001.service and every scope
# in it: the agent died, start-agent.sh saw its tmux session end and exited 1, and pm2
# restarted it ("exited with code [1] via signal [SIGINT]"; pm2 prints SIGINT when no signal
# is known). On 2026-10-29 that happened at 10:29:54, 11:32:02 and 11:52:58: each time the
# last SSH login ended after an operator had restarted the agent from one.
#
# So start-agent.sh starts the session's tmux without those two variables, and then proves
# with same_cgroup that the session is where pm2 can see it: in this script's own cgroup,
# the pm2 service's.

# same_cgroup <pid> [proc-root]: succeed when <pid> is in the same cgroup as this shell.
# Fails, naming both, when it is not or when either cannot be read. proc-root is for tests.
same_cgroup() {
  local pid="$1" proc="${2:-/proc}" mine theirs
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "[start-agent] not a PID: ${pid}" >&2
    return 1
  fi
  if ! mine="$(cat "${proc}/$$/cgroup")"; then
    echo "[start-agent] could not read this script's cgroup" >&2
    return 1
  fi
  if ! theirs="$(cat "${proc}/${pid}/cgroup")"; then
    echo "[start-agent] could not read the cgroup of the session (pid ${pid})" >&2
    return 1
  fi
  if [ "$mine" != "$theirs" ]; then
    echo "[start-agent] the session (pid ${pid}) is in cgroup '${theirs}', not this script's '${mine}':" \
      "it would die with whatever owns that cgroup (a login's systemd user manager stops at logout)" >&2
    return 1
  fi
}
