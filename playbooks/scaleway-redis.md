# Playbook: Scaleway Managed Redis (RKV)

Covers one alert federated from Cockpit:
- **Redis Memory Above 85%** (warning) — `rkv_cluster_redis_memory_used_bytes / rkv_cluster_redis_memory_max_bytes >= 0.85`

Instances known to platform: `redis-data-streaming` (platform Redis), `redis-demos`, and any per-tenant instances. Used primarily by Langfuse, BullMQ-style workers, and rate-limiting.

## Investigation steps

1. **Identify the instance** — `resource_name` from the alert.
2. **Check key count and TTL distribution** — query `rkv_cluster_redis_db_keys`, `rkv_cluster_redis_db_keys_expiring`. If `db_keys >> db_keys_expiring`, the cache is being used without TTLs and will grow forever.
3. **Check eviction policy and recent evictions** — query `rkv_cluster_redis_evicted_keys_total` and `_expired_keys_total` rates. If `evicted_keys` is rising, the instance is at max memory and silently dropping data.
4. **Check connected clients** — `rkv_cluster_redis_connected_clients` for which service is the heaviest consumer. Cross-reference with Langfuse / workers deployments.
5. **For `redis-demos` specifically** — demo data leaks are common. Lower priority than `redis-data-streaming`.

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
*Suggested action:* (a) identify TTL leak, (b) plan resize, (c) flush demos if safe
*Cannot auto-fix:* managed RKV, requires Scaleway console for resize.
```
