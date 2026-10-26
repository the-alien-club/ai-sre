#!/usr/bin/env bash
# Restore the SRE agent's write access after the Rundeck cutover.
#
# The cutover withdraws the agent's safe-op permissions (the sre-agent-write binding),
# its sudo rights, and the "run the fix yourself" section of CLAUDE.md, once the Rundeck
# executor runs those fixes. If the executor fails afterwards, this puts all three back
# exactly as captured in git, then restarts the agent.
#
# Run by an operator from their own machine, with admin kubeconfigs for every context
# and root SSH to the agent VM. Never by the agent: it would be granting itself access.
#
# Usage:
#   scripts/rollback-write-access.sh --vm <host> [--contexts "ctx1 ctx2 ..."] [--dry-run] --yes
#
#   --vm        agent VM hostname or IP (root@ and sre-agent@ are prepended)
#   --contexts  kube contexts to restore; defaults to the 5 the agent monitors
#   --dry-run   print every command instead of running it
#   --yes       required; this changes RBAC on production clusters
#
# Steps, in order, stopping at the first failure:
#   1. re-apply k8s/rbac-write.yaml to every context
#   2. reinstall provision/sudoers.d/sre-agent on the VM (validated with visudo) and
#      re-add the account to the sudo group
#   3. deploy CLAUDE.md as tagged `pre-cutover` to the VM
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

run() {
  echo "+ $*"
  [ "$DRY_RUN" = 1 ] || "$@"
}

echo "=== 1/4 RBAC: re-apply sre-agent-write ==="
for ctx in $CONTEXTS; do
  run kubectl --context "$ctx" apply -f k8s/rbac-write.yaml
done

echo "=== 2/4 sudo: reinstall the drop-in ==="
run scp provision/sudoers.d/sre-agent "root@$VM:/tmp/sre-agent.sudoers"
run ssh "root@$VM" "visudo -c -f /tmp/sre-agent.sudoers \
  && install -m 0440 -o root -g root /tmp/sre-agent.sudoers /etc/sudoers.d/sre-agent \
  && rm /tmp/sre-agent.sudoers \
  && usermod -aG sudo sre-agent"

echo "=== 3/4 CLAUDE.md: restore the $PRE_CUTOVER_TAG version ==="
CLAUDE_MD="$(mktemp)"
trap 'rm -f "$CLAUDE_MD"' EXIT
git show "$PRE_CUTOVER_TAG:CLAUDE.md" > "$CLAUDE_MD"
run scp "$CLAUDE_MD" "sre-agent@$VM:$AGENT_DIR/CLAUDE.md"

echo "=== 4/4 restart the agent ==="
run ssh "sre-agent@$VM" "pm2 restart sre-agent"

echo "Write access restored on: $CONTEXTS"
echo "Verify: kubectl --context <ctx> auth can-i patch deployments --as=system:serviceaccount:kube-system:sre-agent"
