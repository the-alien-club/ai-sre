#!/usr/bin/env bash
# Restore the SRE agent's write access after the Rundeck cutover.
#
# The cutover withdraws the agent's safe-op permissions (the sre-agent-write binding),
# its sudo rights, and the "run the fix yourself" section of CLAUDE.md, once the Rundeck
# executor runs those fixes. If the executor fails afterwards, this puts all three back
# exactly as they were at the `pre-cutover` tag, then restarts the agent. Every restored
# file is read from the tag, never from the working tree, so local edits cannot leak in.
#
# Run by an operator from their own machine, with admin kubeconfigs for every context
# and root SSH to the agent VM. Never by the agent: it would be granting itself access.
#
# Usage:
#   scripts/rollback-write-access.sh --vm <host> [--contexts "ctx1 ctx2 ..."] [--dry-run] --yes
#
#   --vm        agent VM hostname or IP (root@ and sre-agent@ are prepended)
#   --contexts  kube contexts to restore; defaults to the 5 the agent monitors
#   --dry-run   run the read-only preflight, print every write instead of running it
#   --yes       required; this changes RBAC on production clusters
#
# Steps, in order, stopping at the first failure:
#   0. preflight, read-only: every context must hold the agent's ServiceAccount and the
#      VM must host the agent, so a wrong context or host fails before anything changes
#   1. re-apply k8s/rbac-write.yaml to every context
#   2. reinstall provision/sudoers.d/sre-agent on the VM (validated with visudo) and
#      re-add the account to the sudo group
#   3. deploy CLAUDE.md to the VM
#   4. restart the agent under pm2

set -euo pipefail
cd "$(dirname "$0")/.."

CONTEXTS="platform-dev platform-prod data-cluster-dev data-cluster-biorxiv data-cluster-alien-hosted"
VM=""
DRY_RUN=0
CONFIRMED=0
PRE_CUTOVER_TAG="pre-cutover"
AGENT_DIR="/home/sre-agent/sre-agent"

usage() {
  sed -n '12,19p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm) VM="$2"; shift 2;;
    --contexts) CONTEXTS="$2"; shift 2;;
    --dry-run) DRY_RUN=1; shift;;
    --yes) CONFIRMED=1; shift;;
    *) echo "Unknown argument: $1" >&2; usage;;
  esac
done

[ -n "$VM" ] || { echo "Required: --vm <host>" >&2; usage; }
[ "$CONFIRMED" = 1 ] || { echo "Refusing to run without --yes: this changes RBAC on production clusters" >&2; exit 1; }

if [ "$(id -un)" = "sre-agent" ]; then
  echo "Refusing to run as sre-agent: the agent must not restore its own access" >&2
  exit 1
fi

if ! git rev-parse -q --verify "refs/tags/$PRE_CUTOVER_TAG" >/dev/null; then
  echo "Tag $PRE_CUTOVER_TAG not found; it is created at cutover and is what this restores" >&2
  exit 1
fi

# check: a read-only command, run even under --dry-run so a dry run proves the targets
check() {
  echo "? $*"
  "$@"
}

# run: a write, printed instead of executed under --dry-run
run() {
  echo "+ $*"
  [ "$DRY_RUN" = 1 ] || "$@"
}

# run_with_input <file> <command...>: same as run, with <file> on stdin
run_with_input() {
  local input="$1"; shift
  echo "+ $* < $(basename "$input")"
  [ "$DRY_RUN" = 1 ] || "$@" < "$input"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for file in k8s/rbac-write.yaml provision/sudoers.d/sre-agent CLAUDE.md; do
  mkdir -p "$WORK/$(dirname "$file")"
  git show "$PRE_CUTOVER_TAG:$file" > "$WORK/$file"
done

echo "=== 0/4 preflight (read-only) ==="
for ctx in $CONTEXTS; do
  check kubectl --context "$ctx" get serviceaccount sre-agent -n kube-system -o name
done
check ssh "root@$VM" "id -u sre-agent >/dev/null && test -d $AGENT_DIR"

echo "=== 1/4 RBAC: re-apply sre-agent-write ==="
for ctx in $CONTEXTS; do
  run kubectl --context "$ctx" apply -f "$WORK/k8s/rbac-write.yaml"
done

echo "=== 2/4 sudo: reinstall the drop-in ==="
# Streamed into a fresh mktemp file on the VM: a fixed /tmp path could be pre-planted
# by the agent's own account between the copy and the install.
run_with_input "$WORK/provision/sudoers.d/sre-agent" ssh "root@$VM" 'set -e
f="$(mktemp)"; trap '"'"'rm -f "$f"'"'"' EXIT
cat > "$f"
visudo -c -f "$f"
install -m 0440 -o root -g root "$f" /etc/sudoers.d/sre-agent
usermod -aG sudo sre-agent'

echo "=== 3/4 CLAUDE.md: restore the $PRE_CUTOVER_TAG version ==="
run scp "$WORK/CLAUDE.md" "sre-agent@$VM:$AGENT_DIR/CLAUDE.md"

echo "=== 4/4 restart the agent ==="
run ssh "sre-agent@$VM" "pm2 restart sre-agent"

echo "Write access restored on: $CONTEXTS"
echo "Verify: kubectl --context <ctx> auth can-i patch deployments --as=system:serviceaccount:kube-system:sre-agent"
