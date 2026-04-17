# Playbook: High Latency / Latency Anomaly (warning)

1. Query recent traces: `signoz_search_traces` for p99 latency on the affected service
2. A single slow request doesn't warrant action — check if it's sustained degradation
3. Check pod health: `kubectl --context <ctx> get pods -n <ns>`, look for resource pressure
4. Check node pressure: `kubectl --context <ctx> top nodes`
5. **Known noise patterns**:
   - MCP services create 30s root spans (Istio timeout) — the MCP Latency Anomaly alert monitors outbound HTTP client calls separately
   - openaire-test and tixmltest-operator-test frequently have transient P99 spikes that self-resolve
6. If sustained degradation: check recent MRs, check for resource contention, recommend escalate
7. If transient spike: log as noise
