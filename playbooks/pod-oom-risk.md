# Playbook: Pod OOM Risk (critical)

1. Check which pod: `kubectl --context <ctx> top pods -n <ns> --sort-by=memory`
2. Check if it's mmap-based (Qdrant uses mmap — high working_set may be normal, NOT real OOM risk)
3. Meilisearch is already excluded from this alert
4. Check memory limit: `kubectl --context <ctx> describe pod <pod> -n <ns>` → resources.limits.memory
5. If genuine OOM risk (not mmap): recommend restart the pod
6. If it keeps hitting OOM after restart: recommend escalate (needs limit increase or optimization)
