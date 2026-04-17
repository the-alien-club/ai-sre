# Investigate Alert

Spawn a sub-agent to investigate a SigNoz alert. The sub-agent does all diagnostic work
and reports back. You NEVER investigate directly.

## Usage

When an alert arrives via the signoz-webhook channel, extract the metadata and invoke this
skill. Pass the alert details as arguments, or use the channel event content.

## Procedure

1. Parse the alert: name, severity, status, service, cluster, namespace, fingerprint, timestamp
2. Determine the kubectl context from the cluster info
3. Determine the relevant GitLab project ID for MR checking:
   - web-app=70690979, workers=75857737, data-pipelines=75857792
   - data-cluster=75857874, k8s-charts=75858254, data-cluster-helm=77561397
   - data-cluster-operator=77563199, skupper-gateway=77743902
4. Identify the right playbook file in `playbooks/` based on alert name
5. Spawn the sub-agent with this prompt structure:

```
You are a sub-agent investigating an alert. Do the work directly — do NOT delegate further.

FIRST: Check incident history:
  ./scripts/incidents.sh check --alert "<alert_name>" --cluster "<cluster>"
If this alert has been noise multiple times recently, you can short-circuit your investigation.

Alert details:
- Alert: <name>
- Severity: <severity>
- Status: <firing/resolved>
- Service: <service>
- Cluster context: <kubectl context>
- Namespace: <namespace>
- Fingerprint: <fingerprint>
- Started: <timestamp>

Read the playbook for this alert type:
  cat playbooks/<relevant-playbook>.md

Then follow the investigation steps in the playbook.

Also check recent MRs on the relevant repo:
  curl -s "https://gitlab.com/api/v4/projects/<PROJECT_ID>/merge_requests?state=merged&per_page=5&order_by=updated_at" \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" | jq '.[0:3] | .[] | {title, merged_at, web_url}'

LAST: Log the result before returning:
  ./scripts/incidents.sh log --alert "<name>" --severity "<sev>" --status "<status>" \
    --cluster "<cluster>" --service "<service>" \
    --verdict "<real|noise|false_positive|known_issue|flapping>" \
    --action "<auto_fixed|escalated|ignored|monitoring>" \
    --cause "<brief cause>"

Report back:
- Real or false positive?
- Root cause (if identified)
- History: has this fired before? What happened?
- Was a recent MR merged that could have caused this?
- Recommended action (auto-fix / escalate / ignore)
- If auto-fix: exact command to run
- If escalate: summary for the CTO
Be concise.
```

6. Read the sub-agent's report and decide:
   - False positive / noise → done
   - Auto-fixable → run the fix command, then spawn a verification sub-agent
   - Needs escalation → use the `escalate` tool with the sub-agent's findings