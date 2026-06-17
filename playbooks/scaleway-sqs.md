# Playbook: Scaleway Messaging & Queueing — SQS

Covers one alert federated from Cockpit:
- **SQS Oldest Message Age Above 5min** (warning) — `mnq_sqs_queue_messages_duration_since_message_received > 300s`

Queues are typically named after the worker job class (e.g. `alien-tasks`, `worker-jobs`, dead-letter queues). The `queue_name` label identifies the affected queue.

## Investigation steps

1. **Identify the queue** — `queue_name` from the alert.
2. **Is it a DLQ?** — `*-dlq` queues are EXPECTED to accumulate old messages. **Acknowledge and stop investigating** — fix the upstream producer separately. Recommend muting this alert for DLQ queues if it's noisy.
3. **Check queue depth and in-flight counts** — `mnq_sqs_queue_messages_count` (visible) and `mnq_sqs_queue_messages_not_visible_count` (in-flight, locked by a consumer). Distinguish:
   - Depth high, in-flight low → no workers picking up messages
   - Depth low, in-flight high → workers picking up but never ack'ing (probably timing out or dying)
4. **Check worker health** — for the corresponding worker deployment (`workers-deployment` typically): pod count, restart rate, error logs. KEDA autoscales workers based on this queue; if KEDA is broken, depth grows. See `playbooks/pod-crashlooping.md` if pods are restarting.
5. **Check for poison messages** — recent error spans on the worker containing the queue name. A single malformed message can cause repeated consumer crashes → depth grows.

## Decision

**Most of the time: escalate** with the root-cause hypothesis. Auto-fix candidates:

- **If workers are healthy + scaled to max and depth is just temporarily large after a burst**: no action, just acknowledge and watch.
- **If a single worker pod is stuck and KEDA scaling is fine**: safe to `rollout restart` the worker deployment (mirror of pod-crashlooping playbook).
- **DLQ alerts**: acknowledge, do nothing. (The producer failure that fed the DLQ is the real issue and should have a separate alert.)

## Escalation message template

```
:warning: *SQS Oldest Message Age Above 5min* — queue `<queue_name>`

*Depth:* {{visible}} visible, {{in-flight}} in-flight
*Oldest message age:* {{value}}s
*Worker state:* <healthy / restarting / scaling stuck>
*Hypothesis:* <no consumers / poison message / worker crash loop>
*Suggested action:* <restart workers / investigate poison message / acknowledge if DLQ>
```
