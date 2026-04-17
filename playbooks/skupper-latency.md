# Playbook: Skupper Network Latency (warning)

1. Check Skupper router pod: `kubectl --context <ctx> get pods -n infrastructure | grep skupper`
2. Check if the known port drift issue is happening:
   `kubectl --context <ctx> get endpointslice -n infrastructure | grep skupper` and compare ports
3. If port drift (EndpointSlice port differs from actual router tcpListener port):
   Recommend: `kubectl --context platform-dev rollout restart deployment/skupper-controller -n infrastructure`
4. If not port drift: recommend escalate — cross-cluster networking is complex
