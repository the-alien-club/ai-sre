# Playbook: High Error Rate (critical)

1. Identify which service: check `service` label
2. Query recent traces: `signoz_search_traces` with `has_error = true AND response_status_code >= '500'`
3. Check pod health: `kubectl --context <ctx> get pods -n <ns>`, look for restarts or pending pods
4. Check recent deployments: `kubectl --context <ctx> rollout history deployment/<service> -n <ns>`
5. **Check recent MRs**: query the GitLab API for recently merged MRs on the affected repo.
   If an MR was merged in the last 30 min-1 hr, it's the prime suspect. Read the MR diff to confirm.
6. If a single pod is erroring: recommend restart
7. If all pods error AND recent MR found: recommend escalate with MR link (needs rollback or fix-forward)
8. If all pods error AND no recent MR: recommend escalate (infrastructure or config issue)
