# Playbook: ArgoCD App Degraded / Sync Failed (critical)

1. Check app status: `kubectl --context <ctx> get application <name> -n argocd -o yaml`
2. Check sync status and health
3. If stuck operation: recommend `kubectl patch application <name> -n argocd --type merge -p '{"operation":null}'`
4. If out of sync: recommend `kubectl annotate application <name> -n argocd argocd.argoproj.io/refresh=hard --overwrite`
5. If sync failed: check `git log` in the relevant repo for bad commits. Recommend escalate.
6. **NEVER recommend deleting the ArgoCD application** — cascade-deletes all managed resources
