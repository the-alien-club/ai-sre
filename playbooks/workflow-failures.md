# Playbook: Workflow Step Failures (warning)

1. Check which workflow: `kubectl --context <ctx> get workflows -n <ns>`
2. Check step logs: `kubectl --context <ctx> logs <step-pod> -n <ns>`
3. If transient (network timeout, API 503): the workflow retry mechanism should handle it — log as monitoring
4. If persistent (code error, data issue): recommend escalate
5. Note: workflow steps use a 2Gi PVC mounted at /tmp. If disk errors, check PVC binding.
   Storage class is `sbs-default` (WaitForFirstConsumer) on Scaleway.
