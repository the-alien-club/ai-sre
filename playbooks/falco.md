# Playbook: Falco Runtime Security Event

Falco detects suspicious behavior at the kernel level — process execution, file access,
network connections, privilege changes. **All Falco alerts are security-relevant and should
be treated as potential intrusions until proven otherwise.**

## Core principle

**NEVER auto-fix Falco alerts.** Even "obvious" responses like killing the pod can destroy
forensic evidence. Always escalate to the CTO with full context. The CTO decides whether to
contain, investigate, or dismiss.

## Investigation steps

The Falco event arrives as a SigNoz log-based alert. The body contains the Falco JSON output
with fields like `rule`, `priority`, `output`, `output_fields`. Key fields to extract:

- `rule` — the Falco rule that triggered (e.g. "Terminal shell in container", "Write below etc")
- `priority` — Critical, Error, Warning, Notice, Informational, Debug
- `output_fields.k8s.pod.name` — which pod triggered the event
- `output_fields.k8s.ns.name` — namespace
- `output_fields.proc.cmdline` — the command line of the offending process
- `output_fields.proc.pname` — parent process (helps identify how it was spawned)
- `output_fields.user.name` / `output_fields.user.uid` — who ran it
- `output_fields.fd.name` — file path (for file-related rules)
- `output_fields.fd.sip` / `output_fields.fd.sport` — destination IP/port (for network rules)
- `output_fields.container.image.repository` — what image is running

### 1. Identify scope

```bash
# Confirm the pod still exists
kubectl --context <ctx> get pod <pod_name> -n <ns> -o yaml

# What workload owns it?
kubectl --context <ctx> get pod <pod_name> -n <ns> -o jsonpath='{.metadata.ownerReferences}'

# Check recent activity in the same namespace (other Falco events may correlate)
./scripts/incidents.sh check --alert "Falco" --cluster "<ctx>" --days 1
```

### 2. Check if expected

Before assuming malicious intent, rule out legitimate sources:

- **Recent deployment** — a new image rolling out can trigger Falco rules that didn't fire
  before (different binaries, different paths).
  ```bash
  kubectl --context <ctx> rollout history deployment/<deployment> -n <ns>
  curl -s "https://gitlab.com/api/v4/projects/<PROJECT_ID>/merge_requests?state=merged&per_page=5" \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" | jq '.[].title'
  ```
- **CTO debugging session** — if someone exec'd into a pod, the CTO probably knows.
  Check the kubectl audit log if available, otherwise just ask.
- **Known Argo workflow patterns** — Argo Workflow steps often run unusual commands legitimately.
  If the pod name starts with a workflow name (e.g. `entry-xyz-12345`), it's likely a workflow step.
- **Init containers / migration jobs** — these often do unusual filesystem operations as part of
  startup. Check `kubectl describe pod` for the container that triggered.

### 3. Categorize the rule

Some Falco rules are higher signal than others:

**HIGH signal — almost always real, escalate immediately:**
- `Terminal shell in container` — interactive shell spawned (rare in production)
- `Launch Privileged Container` — privileged: true container started
- `Read sensitive file untrusted` — reading /etc/shadow, ssh keys, k8s service account tokens by unexpected processes
- `Modify binary dirs` — writing to /bin, /usr/bin, /usr/sbin
- `Container drift detected` — new binary executed that wasn't in the original image
- `Outbound connection to C2 server` — known bad IPs
- `Mount Launched in Privileged Container`
- `Detect crypto miners` — crypto mining process names

**MEDIUM signal — investigate context:**
- `Write below etc` — common in init scripts and cert renewal, but also tampering
- `Run shell untrusted` — depends on which process spawned it
- `K8s service account TokenRequest` — could be normal in-cluster API usage
- `DB program spawned process` — could be db extension usage or RCE

**LOW signal — probably noise, check pattern:**
- Plenty of `Notice` and `Informational` events fire from normal cluster operations
- If it fires hundreds of times per hour from kube-system, it's noise — propose tuning

### 4. Decide

After investigation, recommend ONE of:

- **Escalate immediately (default for HIGH signal)** — message to CTO with:
  - Rule name and Falco output
  - Affected pod, namespace, image
  - Process command line and parent process
  - Whether the pod is still running
  - Anything you ruled out (e.g. "not a recent deployment, no MR in last 6h")
  - Whether you recommend the CTO **contain** (kill pod, isolate node) or **investigate**
    (preserve evidence first)

- **Escalate with context (MEDIUM signal)** — same as above but include the legitimate-source
  hypotheses you considered

- **Tag as known noise** — only if the same Falco rule has fired as noise repeatedly for the
  same workload. Log via `incidents.sh log --verdict noise --action ignored` and propose alert
  tuning to the CTO via `/noise-report` (e.g. "exclude workload-X from rule-Y", "raise priority
  threshold").

## What you must NEVER do

- **Never `kubectl delete pod`** on a Falco alert — even for "auto-fix" thinking. Destroys evidence.
- **Never `kubectl exec`** into the affected pod — your activity becomes another Falco event and contaminates the investigation.
- **Never assume legitimate** without checking. Even "this is just CI" should be verified.
- **Never wait silently** — if you can't reach the CTO, the agent's nag timer should keep
  escalating. Security alerts get the most aggressive nag interval (10 min for prod critical).
