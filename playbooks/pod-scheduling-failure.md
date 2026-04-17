# Playbook: Pod Scheduling Failure (critical)

1. Check events: `kubectl --context <ctx> get events --field-selector reason=FailedScheduling -n <ns>`
2. Check node capacity: `kubectl --context <ctx> top nodes`
3. Check allocatable: `kubectl --context <ctx> describe nodes | grep -A5 Allocatable`
4. **ALWAYS recommend escalate** — needs cluster scaling decision
