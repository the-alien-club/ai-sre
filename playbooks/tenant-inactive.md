# Playbook: Tenant Inactive (info)

1. Check if namespace starts with `tenant-test-` → known issue (401 heartbeats), log as known_issue and ignore
2. If real tenant: check if data-api pods are running in the tenant namespace
3. Check Skupper connectivity (if cross-cluster): `kubectl --context <ctx> get pods -n infrastructure | grep skupper`
4. If pods are down: recommend restart
5. If Skupper is broken: recommend escalate
