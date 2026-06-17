# Playbook: Scaleway Managed Postgres (RDB)

Covers three alerts on Scaleway-managed Postgres instances federated from Cockpit:
- **Postgres Connections Near Limit** (critical) — `pg_stat_activity_count / pg_settings_max_connections >= 0.95`
- **Postgres Replication Lag** (critical) — `pg_replication_lag > 60s`
- **Postgres Disk Above 85%** (warning) — `1 - (filesystem_avail / filesystem_size) > 0.85`

The alert label `resource_name` is the Scaleway DB cluster name (e.g. `production-database`, `authentik`, `dev-database`). These are managed instances — Scaleway owns the underlying VM. We cannot ssh, restart Postgres, or grow disks directly.

## Investigation steps

1. **Identify which Postgres instance** — from the alert annotation `resource_name`. Confirm in SigNoz Metrics Explorer with `rdb_instance_postgresql_*` filtered by `resource_name`.
2. **For connection saturation** — query `rdb_instance_postgresql_pg_stat_activity_count` grouped by `state` for that `resource_name`. If `idle in transaction` is dominant, a client is leaking transactions (most common cause). Identify the client via the app's DB metric/log: long-running transaction logs from the affected service.
3. **For replication lag** — check the Scaleway console for incidents in fr-par. Recent maintenance windows are the second-most-common cause. Also check `rdb_instance_postgresql_node_disk_writes_completed_total` rate — sustained write spike can lag standby.
4. **For disk** — query `rdb_instance_postgresql_node_filesystem_size_bytes` and `_avail_bytes` history over 7d to distinguish "leaked WAL / bloat" from "natural growth".

## Decision

**ALWAYS recommend escalate** for all three alert types. None can be safely auto-fixed:

- **Connection saturation**: requires identifying and restarting the leaking client (app-level decision). The agent should escalate with the candidate client identified, NOT auto-restart pods that talk to the DB.
- **Replication lag**: needs Scaleway intervention (check status page) or capacity decision. Do not auto-anything.
- **Disk pressure**: cannot expand RDB disk programmatically without a Scaleway console action (which causes brief downtime). Escalate with growth-rate forecast (days-to-full).

## Escalation message template

```
:warning: *<alert name>* — Postgres `<resource_name>`

*Diagnosis:* <one-line root cause guess: leaking client / disk growth rate / standby lag>
*Affected service(s):* <who connects to this DB>
*Suggested action:* <restart client X / contact Scaleway / plan disk expansion>
*Cannot auto-fix:* managed RDB, requires manual action.
```
