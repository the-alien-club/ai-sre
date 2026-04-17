# Playbook: Database Errors (critical)

1. Check which queries are failing: `signoz_search_traces` with PostgreSQL spans
2. Check connection counts: are we maxing out the pool?
3. Check pod logs for connection errors: `kubectl --context <ctx> logs -l app=<db-service> -n <ns> --tail=100`
4. **ALWAYS recommend escalate** — never auto-fix database issues
