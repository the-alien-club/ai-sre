# Playbook: PVC Nearing Capacity (critical)

1. Check actual usage: `kubectl --context <ctx> exec <pod> -n <ns> -- df -h`
2. Identify what's consuming space
3. Check if it's a workflow temp PVC (2Gi, mounted at /tmp) or a data PVC
4. **ALWAYS recommend escalate** — can't auto-expand PVCs safely, needs capacity planning
