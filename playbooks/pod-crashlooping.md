# Playbook: Pod CrashLooping (critical)

1. Get pod status: `kubectl --context <ctx> describe pod <pod> -n <ns>`
2. Check logs: `kubectl --context <ctx> logs <pod> -n <ns> --previous` (get logs from crashed container)
3. Check events: `kubectl --context <ctx> get events -n <ns> --sort-by=.lastTimestamp`
4. Check for OOM, image pull failures, config mount errors
5. If OOMKilled: recommend restart (it might recover). If it has crashed repeatedly, recommend escalate.
6. If ImagePullBackOff: recommend escalate (registry or image issue)
7. If config/secret mount failure: recommend escalate
