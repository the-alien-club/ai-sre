# Playbook: Scaleway Load Balancer

Covers two alerts federated from Cockpit:
- **Load Balancer Backend Down** (critical) — `load_balancer_lb_backend_status{state='DOWN'} > 0` (count of DOWN backends per backend pool)
- **Load Balancer Connection Saturation Above 80%** (warning) — `load_balancer_lb_connection_usage > 80` (percentage of LB's allocated connection capacity)

LB and backend identifiers in the alert: `resource_name` (the LB), `backend_name` (the backend pool inside it). Backend pools are named with K8s service hashes like `<uuid>_tcp_<nodeport>` — to map back to a service, cross-reference with the LB's owner cluster (each tenant cluster has its own LB).

## Investigation steps

### Backend Down

1. **Identify the LB and backend** — `resource_name` + `backend_name` from the alert.
2. **Confirm the backend pool ↔ K8s service mapping** — the `backend_name` UUID matches a Service in some cluster, exposed via `LoadBalancer` type. Find it by grepping `kubectl --context <ctx> get svc -A -o json | jq` for the UUID, or check ArgoCD app annotations.
3. **Check the backend pods** — once the K8s service is known, check that its pods are Ready (`kubectl get pods -l app=<svc>`). Most common cause: pods are running but health check is failing (wrong path, port, or response).
4. **Check Scaleway LB health-check config** — only via Scaleway console; the metric tells us DOWN, not why. Common misconfig: TCP-mode LB checking a port that's no longer exposed after a deployment.
5. **For tenant cluster LBs**: backend churn during pod restarts is normal during deploys. A 5-min DOWN window during a rolling update is expected — the alert's "all_the_times" matchType should suppress transient flaps, but a fresh rollout with a slow readiness probe may still trigger.

### Connection Saturation

1. **Identify the LB** — `resource_name` from the alert.
2. **Check the LB plan** — query `load_balancer_lb_bandwidth_in_usage` and `_out_usage` for whether bandwidth is also saturated. If both, the LB is undersized.
3. **Check session counts** — `load_balancer_lb_frontend_current_sessions` over time. Sustained spike vs gradual growth tells us "incident" vs "natural traffic growth".

## Decision

- **Backend Down on a tenant cluster during a known deploy window**: acknowledge, do nothing. If it persists past 10 min, escalate.
- **Backend Down on platform LB (production traffic-serving)**: escalate IMMEDIATELY. Loss of any backend pool here is user-visible.
- **Connection Saturation**: escalate. Sizing decision — Scaleway LB plans cap connection counts, and bumping the plan is a console action.

## Escalation message template — Backend Down

```
:rotating_light: *Load Balancer Backend Down* — `<resource_name>` / `<backend_name>`

*Affected service:* <K8s service / cluster context>
*Likely cause:* <pods not ready / health check misconfig / rolling deploy in progress>
*User impact:* <traffic-serving / internal / tenant-specific>
*Suggested action:* <wait if deploy / kubectl rollout status / fix health check>
```

## Escalation message template — Connection Saturation

```
:warning: *LB Connection Saturation Above 80%* — `<resource_name>`

*Current usage:* {{value}}%
*Bandwidth state:* <bandwidth also saturated? Y/N>
*Pattern:* <sustained burst / gradual growth>
*Suggested action:* (a) upgrade LB plan, (b) split traffic across multiple LBs, (c) investigate sudden traffic source
*Cannot auto-fix:* sizing requires Scaleway console action.
```
