# Playbook: Data-API Request Failures (warning)

1. Check data-api pod health in the tenant namespace:
   `kubectl --context <ctx> get pods -n <ns> -l app=data-api`
2. Check logs: `kubectl --context <ctx> logs -n <ns> -l app=data-api --tail=100`
3. Note: data-api has no OTel tracing — these errors are caught via logging middleware, not traces
4. If pod is unhealthy: recommend restart
5. If code-level error (500s in logs): recommend escalate
