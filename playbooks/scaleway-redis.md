# Playbook: Scaleway Managed Redis (RKV)

Covers:
- **Redis Memory Above 85%** (warning, federated from Cockpit) — `rkv_cluster_redis_memory_used_bytes / rkv_cluster_redis_memory_max_bytes >= 0.85`
- **Redis unreachable** (no dedicated alert yet) — clients log `ECONNRESET`, `Error 104 ... Connection reset by peer` or Istio `UF,URX` on `51.15.232.25:6379`. It tends to surface as Proxy Timeout, SQS backlog or workflow failures.

Instance: `redis-demos` (`225b1236-d26a-452e-a311-457af99233af`, fr-par-1, single node, RED1-2XS since 2026-10-26) is the only Scaleway Redis. Despite its name it is **production**: platform-prod and platform-dev both use it (backend `agent-stream:` streams, workers streaming bridge, rate limits). There is no `redis-data-streaming`. Treat any `redis-demos` problem as a prod incident.

## Investigation steps (memory)

1. **Identify the instance** — `resource_name` from the alert.
2. **Check key count and TTL distribution** — query `rkv_cluster_redis_db_keys`, `rkv_cluster_redis_db_keys_expiring`. If `db_keys >> db_keys_expiring`, the cache is being used without TTLs and will grow forever.
3. **Check eviction policy and recent evictions** — query `rkv_cluster_redis_evicted_keys_total` and `_expired_keys_total` rates. If `evicted_keys` is rising, the instance is at max memory and silently dropping data.
4. **Check connected clients** — `rkv_cluster_redis_connected_clients` for which service is the heaviest consumer. Cross-reference with backend / workers deployments.

## Investigation steps (unreachable)

1. **Confirm it is server-side** — if errors start in the same minute on prod and dev, on pods of every age, it is not a client or credentials problem.
2. **Check the server metrics** — `rkv_cluster_redis_db_keys` and `rkv_cluster_redis_connected_clients` (5-min scrape). A drop to 0 keys and ~4 clients means the node restarted empty and stopped accepting external connections (2026-10-26, 10:18–11:49 UTC).
3. **Rule out a secret rotation properly** — an ExternalSecret's `refreshTime` moves every `refreshInterval` (1h) even when nothing changed. A real change makes Reloader restart backend and workers. Check pod ages and the Secret's data before claiming a rotation.
4. **Check the instance** — `scw redis cluster get <id>`. `status: ready` does not prove it serves clients.

Escalate immediately (critical). Fix used on 2026-10-26: `scw redis cluster migrate <id> node-type=<next size>` rebuilt the node in ~6 min, same IP and TLS cert, keys came back, clients reconnected on their own. Human decision only, never run it yourself.

## Decision

**ALWAYS recommend escalate**. Can't safely:
- Flush the instance (data loss)
- Resize the plan (Scaleway console action, brief restart)
- Change eviction policy (semantic change, app-level decision)

Possible safe pre-escalation diagnostic: query SigNoz logs for any service that recently started a large cache-write pattern (look for `SET` / `HSET` rate spikes in tracing data on Redis client spans).

## Escalation message template

```
:warning: *Redis Memory Above 85%* — `<resource_name>`

*Memory usage:* {{value}} of max
*Eviction policy active:* {{yes/no, based on evicted_keys_total rate}}
*Top client(s):* <service.name from traces>
*Suggested action:* (a) identify TTL leak, (b) plan resize. Never flush: `redis-demos` holds prod data
*Cannot auto-fix:* managed RKV, requires Scaleway console for resize.
```
