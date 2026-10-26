# shellcheck shell=bash
# wait_for_port <label> <port> <timeout-seconds>
#
# Succeeds as soon as something listens on TCP <port>, fails once <timeout-seconds> have
# passed. The match is on the exact local port, so 8788 is not satisfied by 18788.
wait_for_port() {
  local label="$1" port="$2" timeout="$3" waited=0
  until ss -Htln "sport = :${port}" | grep -q .; do
    if (( waited >= timeout )); then
      echo "[start-agent] ${label} port ${port} not bound after ${timeout}s" >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "[start-agent] ${label} port ${port} bound"
}
