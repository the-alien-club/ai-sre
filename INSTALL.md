# SRE Agent — Installation Guide

Complete guide to deploy the SRE agent from scratch on a new Scaleway VM.

## Prerequisites

- Scaleway account with CLI configured (`scw`)
- GitLab access to `alias3/datastreaming` group
- Slack workspace admin access (to create the bot app)
- SigNoz cloud access (to create webhook channel)
- Claude AI enterprise/team account with `channelsEnabled: true` in admin settings

## 1. Create the VM

```bash
# DEV1-S: 2 vCPU, 2GB RAM, 20GB storage (~€6.50/month)
scw instance server create type=DEV1-S image=ubuntu_noble name=sre-agent zone=fr-par-1 ip=new

# Note the public IP from the output
SRE_IP=<public-ip>

# Boot if not auto-started
scw instance server action server-id=<server-id> action=poweron zone=fr-par-1
```

## 2. Create the `sre-agent` user

```bash
scp provision/sudoers.d/sre-agent root@$SRE_IP:/tmp/sre-agent.sudoers
ssh root@$SRE_IP

useradd -m -s /bin/bash sre-agent
usermod -aG sudo sre-agent
visudo -c -f /tmp/sre-agent.sudoers
install -m 0440 -o root -g root /tmp/sre-agent.sudoers /etc/sudoers.d/sre-agent
rm /tmp/sre-agent.sudoers

mkdir -p /home/sre-agent/.ssh
cp /root/.ssh/authorized_keys /home/sre-agent/.ssh/
chown -R sre-agent:sre-agent /home/sre-agent/.ssh
chmod 700 /home/sre-agent/.ssh
chmod 600 /home/sre-agent/.ssh/authorized_keys
exit
```

## 3. Install system dependencies

```bash
ssh sre-agent@$SRE_IP

# Wait for any cloud-init apt to finish
while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 2; done

# System packages
sudo apt-get update -qq
sudo apt-get install -y -qq curl git unzip jq postgresql-client ca-certificates gnupg tmux

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y -qq nodejs

# Bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc

# kubectl
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update -qq && sudo apt-get install -y -qq kubectl

# Helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# ArgoCD CLI
curl -sSL -o /tmp/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
sudo install -m 555 /tmp/argocd /usr/local/bin/argocd && rm /tmp/argocd

# glab (GitLab CLI) — get latest .deb from https://gitlab.com/gitlab-org/cli/-/releases
curl -sL "https://gitlab.com/gitlab-org/cli/-/releases/v1.51.0/downloads/glab_1.51.0_linux_amd64.deb" -o /tmp/glab.deb
sudo dpkg -i /tmp/glab.deb && rm /tmp/glab.deb

# pm2
sudo npm install -g pm2

# Claude Code
sudo npm install -g @anthropic-ai/claude-code

# Log directory
sudo mkdir -p /var/log/sre-agent
sudo chown sre-agent:sre-agent /var/log/sre-agent
```

## 4. Clone the SRE agent repo

```bash
# Generate SSH key (if not already done)
ssh-keygen -t ed25519 -C "sre-agent@alien" -f ~/.ssh/id_ed25519 -N ""

# Configure SSH for GitLab
cat > ~/.ssh/config <<'EOF'
Host gitlab.com
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
EOF

# Display the public key — add it as a deploy key to GitLab projects (see step 5)
cat ~/.ssh/id_ed25519.pub
```

Add the public key as a **read-only deploy key** to these GitLab projects
(or use the API — see "Adding deploy keys via API" below):
- `alias3/datastreaming/tooling/claude-sre`
- `alias3/datastreaming/web-app`
- `alias3/datastreaming/workers`
- `alias3/datastreaming/data-pipelines`
- `alias3/datastreaming/data-cluster`
- `alias3/datastreaming/k8s-charts`
- `alias3/datastreaming/data-cluster-helm`
- `alias3/datastreaming/data-cluster-operator`
- `alias3/datastreaming/skupper-gateway`
- `alias3/datastreaming/mcp/mcp-base`
- `alias3/datastreaming/mcp/mcp-datacluster`
- `alias3/datastreaming/mcp/mcp-openaire`
- `alias3/datastreaming/mcp/mcp-k8s-charts`

Then clone:

```bash
# SRE agent
git clone git@gitlab.com:alias3/datastreaming/tooling/claude-sre.git ~/sre-agent
cd ~/sre-agent && npm install

# All DataStreaming repos (read-only, for git log/blame during investigations)
mkdir -p ~/repos
GITLAB="git@gitlab.com:alias3/datastreaming"
for repo in web-app workers data-pipelines data-cluster k8s-charts data-cluster-helm data-cluster-operator skupper-gateway; do
  git clone --depth 1 "$GITLAB/$repo.git" ~/repos/$repo
done
mkdir -p ~/repos/MCPs
for repo in mcp-base mcp-datacluster mcp-openaire mcp-k8s-charts; do
  git clone --depth 1 "$GITLAB/mcp/$repo.git" ~/repos/MCPs/$repo
done
```

### Adding deploy keys via API

From a machine with `glab` authenticated as an owner:

```bash
PUB_KEY="$(ssh sre-agent@$SRE_IP 'cat ~/.ssh/id_ed25519.pub')"
for PID in 81385797 70690979 75857737 75857792 75857874 75858254 77561397 77563199 77743902 76863365 76864163 77145663 77191805; do
  glab api -X POST "projects/$PID/deploy_keys" --raw-field "title=sre-agent-vm" --raw-field "key=$PUB_KEY" --raw-field "can_push=false"
done
```

## 4b. Clone the KEDB (sre-kedb)

The Known Error Database is its own GitLab project, `alias3/datastreaming/tooling/sre-kedb`,
cloned outside `~/sre-agent` so that no deploy of the agent can overwrite it. The
signoz-webhook channel reads it at `SRE_KEDB_DIR` (default `/home/sre-agent/kedb`) and matches
every alert against it. If the checkout is missing or broken, alerts still go out, with
`kedb_match=none`, and the channel logs `[kedb] unavailable` once.

It has its **own key**, never `id_ed25519`. That key is a **write** deploy key on sre-kedb
only, for the Slack approval loop (plan P2, since 0.9.0): when an approver answers `yes` to a
runbook proposal, the slack-sre channel commits that one entry and pushes it to `main`. The
private key never leaves the VM.

On the VM, as `sre-agent`:

```bash
ssh-keygen -t ed25519 -C "sre-agent@alien kedb" -f ~/.ssh/kedb_ed25519 -N ""

# Its own host alias. IdentitiesOnly matters: if ssh also offered id_ed25519, GitLab would
# authenticate as that read-only key and refuse sre-kedb.
cat >> ~/.ssh/config <<'EOF'

Host gitlab-kedb
  HostName gitlab.com
  User git
  IdentityFile ~/.ssh/kedb_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF

cat ~/.ssh/kedb_ed25519.pub
```

From a machine with `glab` authenticated as an owner of the project, add the public key as
a deploy key **on sre-kedb only** (project id 88247659):

```bash
PUB_KEY="$(ssh sre-agent@$SRE_IP 'cat ~/.ssh/kedb_ed25519.pub')"
glab api -X POST "projects/88247659/deploy_keys" --raw-field "title=sre-agent-vm-kedb (write, sre-kedb only)" \
  --raw-field "key=$PUB_KEY" --raw-field "can_push=true"
```

GitLab can take a minute to accept a new deploy key. Then, on the VM:

```bash
git ls-remote gitlab-kedb:alias3/datastreaming/tooling/sre-kedb.git   # lists refs/heads/main
git clone gitlab-kedb:alias3/datastreaming/tooling/sre-kedb.git ~/kedb
```

Set `SRE_KEDB_DIR` in `.env` only for a different path.

### The learning loop (0.9.0)

The checkout belongs to the slack-sre channel from now on: before every proposal and every
apply it runs `git fetch` and `git reset --hard origin/main`, so never edit it by hand. A
merged sre-kedb MR reaches it at the next proposal or apply; to pick it up sooner, run
`git -C ~/kedb pull --ff-only`. The channel picks up the new revision on the next alert.

Four things must be in place, or the loop refuses (it never half-works):

1. **The deploy key may push to `main`.** `main` is protected for Maintainers only. A project
   owner adds the key in sre-kedb → Settings → Repository → Protected branches → `main` →
   *Allowed to push and merge* → the `sre-agent-vm-kedb (write, sre-kedb only)` deploy key
   (id 21924441), keeping Maintainers. Without it, applying fails with `git push failed`, the
   thread says so, and nothing changes.
2. **The lint's dependencies** (the loop runs sre-kedb's own `ci/lint.ts` before posting and
   before committing): `cd ~/kedb && npm ci --no-audit --no-fund`. `node_modules` is untracked,
   so the resets keep it; re-run it when sre-kedb's `package-lock.json` changes.
3. **`SRE_KEDB_APPROVERS`** in `.env`: the Slack user IDs whose `yes` applies a proposal
   (`U054PDMV69X`, Leo). Each must be in `SRE_OPERATORS`. Required: the Slack channel refuses
   to start without it, and `start-agent.sh` checks it before stopping the running session.
4. **A read-only sentinel clone**, which an entry's `auto_fix` is checked against
   (`catalog/actions.yaml`, on sentinel's `dev` branch). Add `id_ed25519` as a read deploy key
   on sentinel (project 88114219) like the repositories of §4, then:

   ```bash
   git clone --branch dev git@gitlab.com:alias3/datastreaming/tooling/sentinel.git ~/repos/sentinel
   ```

   Missing, only proposals that set an `auto_fix` are refused. `SRE_SENTINEL_DIR` overrides
   the path.

What the loop writes on the VM: `data/kedb-proposals.json` (the proposals, written atomically;
if it is ever unreadable the loop turns itself off and the briefing says why, rather than
reusing `KB-<n>` numbers) and `data/kedb-stage/` (scratch copies for diffs and lint runs).

Since 0.9.1 the loop also reads `data/incidents.db` (read-only, through `sqlite3`): a
proposal's `fingerprint` must be the one its incident was logged with. A proposal whose
fingerprint has no kept raw payload (older than 7 days, or than 0.8.0) is refused unless an
approver asked for it in its thread; it is then posted and committed with the statement that
the injection check did not run (`Injection-Check:` trailer). sre-kedb's verify-approvals
passes such a commit with or without its Injection-Check support; with it, it also proves from
Slack that an approver asked in the proposal's thread and that the post showed the warning.

## 5. Create RBAC-scoped kubeconfigs

The agent should NOT have cluster-admin access. Create a scoped ServiceAccount on each cluster.

```bash
# From a machine with admin kubeconfigs, apply the RBAC manifests to each cluster.
# k8s/rbac.yaml (read) and k8s/rbac-write.yaml (safe-op writes) in this repo are the
# source of truth for the agent's permissions. Edit them there, commit, then re-apply
# to all clusters. Apply the write side first so the agent never loses its safe ops.

CLUSTERS=(
  "14c4e1e4-...:platform-dev"
  "e61e319b-...:platform-prod"
  "e9f0dc51-...:data-cluster-dev"
  "ec7eb2db-...:data-cluster-biorxiv"
  "b993f63c-...:data-cluster-alien-hosted"
)

for entry in "${CLUSTERS[@]}"; do
  ID="${entry%%:*}"; NAME="${entry##*:}"
  KUBECONFIG_PATH="/tmp/$NAME.yaml"
  scw k8s kubeconfig get "$ID" region=fr-par > "$KUBECONFIG_PATH"
  KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f k8s/rbac-write.yaml
  KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f k8s/rbac.yaml
done
```

The read manifest ([k8s/rbac.yaml](k8s/rbac.yaml)) creates:
- ServiceAccount `sre-agent` in `kube-system`
- ClusterRole `sre-agent` — an **explicit read allowlist**, NOT "read all". It covers core
  resources, workloads, HPAs, KEDA, Argo Workflows, ArgoCD Applications, batch, networking,
  policy, storage classes, cert-manager, metrics, external-secrets, and Skupper. Secrets are
  list-only (metadata, never values). It grants no write verbs.
  If the agent reports "my ServiceAccount doesn't have RBAC to read X", the resource is missing
  from the allowlist — add it to k8s/rbac.yaml and re-apply to all 5 clusters.
- ClusterRoleBinding
- Long-lived token Secret (`sre-agent-token`)

The write manifest ([k8s/rbac-write.yaml](k8s/rbac-write.yaml)) creates ClusterRole and
ClusterRoleBinding `sre-agent-write`, limited to: patch deployments (rollout restart), delete
pods, delete workflows, patch ArgoCD Applications (refresh / clear stuck op). It is kept
separate so it can be withdrawn once the Rundeck executor runs the safe ops, and restored with
`make rollback-write-access`.

Then generate scoped kubeconfigs using each SA token, merge them, and copy to the VM:

```bash
# For each cluster, extract token and build a scoped kubeconfig entry
# Then merge: KUBECONFIG="file1:file2:..." kubectl config view --flatten > merged.yaml
scp merged.yaml sre-agent@$SRE_IP:~/.kube/config
```


## 6. Create the Slack app

The agent lives in a shared team channel, so it needs channel scopes — not just DM scopes.

1. Go to https://api.slack.com/apps → **Create New App**
2. **Socket Mode**: Enable (Settings → Socket Mode → toggle on)
3. **App-Level Token**: Create one with `connections:write` scope → this is `SLACK_APP_TOKEN`
4. **Bot Token Scopes** (OAuth & Permissions):
   `chat:write`, `chat:write.public`, `channels:history`, `channels:read`,
   `channels:join`, `im:history`, `im:read`, `im:write`
   (add `groups:history`, `groups:read` instead of the `channels:*` ones if the
   team channel is private — a private channel also needs a manual `/invite`)
5. **Event Subscriptions**: Enable → Subscribe to bot events → add `message.channels`
   and `message.im`.
   **Do not also add `app_mention`**: a mention already arrives as a `message.channels`
   event, and subscribing to both makes the channel handle every mention twice.
6. **App Home**: Enable Messages Tab + "Allow users to send Slash commands and messages"
7. **Install to Workspace** → copy the Bot User OAuth Token → this is `SLACK_BOT_TOKEN`

> Changing scopes on an existing app requires a **reinstall**, which issues a **new
> bot token**. Update `SLACK_BOT_TOKEN` in `.env` afterwards or the channel will fail
> startup validation with `invalid_auth`.

8. Collect the channel ID (channel → View channel details → bottom of the About tab)
   → this is `SRE_SLACK_CHANNEL`
9. Collect the Slack user ID of each operator (profile → three dots → Copy member ID)
   → these make up `SRE_OPERATORS`

The channel's startup validation joins a public channel automatically. For a private
channel, invite the bot by hand: `/invite @claude_sre` in the channel.

## 7. Create the `.env` file

```bash
cd ~/sre-agent
cp .env.example .env
# Edit with real values:
# SIGNOZ_WEBHOOK_TOKEN: generate with `openssl rand -hex 32` (required, the channel will not start without it)
# TRIVY_WEBHOOK_TOKEN: generate with `openssl rand -hex 32` (required, same rule)
# SIGNOZ_URL / SIGNOZ_TOKEN: SigNoz cloud URL and API key for the SigNoz MCP server.
#   .mcp.json references them as ${SIGNOZ_URL} / ${SIGNOZ_TOKEN}; do not edit .mcp.json.
# SLACK_BOT_TOKEN: from step 6
# SLACK_APP_TOKEN: from step 6
# SRE_SLACK_CHANNEL: from step 6 — the channel the agent lives in
# SRE_OPERATORS: from step 6 — "U123:Leo,U456:Adrien,U789:Ghislain"
# GITLAB_TOKEN: group access token with read_api scope (Reporter level)
# JIRA_BASE_URL / JIRA_USER_EMAIL / JIRA_API_TOKEN: an Atlassian API token for an account
#   that can create and comment on SDS issues (the Trivy channel files one ticket per image)
# TRIVY_DIGEST_HOUR_UTC: hour of the daily Trivy digest, 0-23 (default 7)
# ACK_DELAY_MS / OPERATOR_FOLLOWUP_MS: when the channel posts "On it" for a quiet agent (default
#   20000), and when after that it says there is still no answer (default 300000); see .env.example
# RUNDECK_URL / RUNDECK_API_TOKEN: VM-A's Rundeck over WireGuard and the `sre-agent` token
#   (required by the SigNoz channel; see "Sentinel remediation" below)
```

`SRE_SLACK_CHANNEL` and `SRE_OPERATORS` are required — the channel refuses to start
without them rather than running against the wrong channel or with no allowlist.

The Trivy channel posts to Slack and Jira itself, so it also requires `SLACK_BOT_TOKEN`,
`SRE_SLACK_CHANNEL`, `SRE_OPERATORS` and the three `JIRA_*` variables. Without any of them it
refuses to start. `start-agent.sh` checks every setting the channels require before it stops
the running session: if one is missing it names it in pm2's error log and the team channel,
leaves the running session as it is, and exits non-zero. **Add the `JIRA_*` variables to an
existing VM's `.env` before deploying 0.4.0**, or the restart is refused and the session
already running, if any, stays on the old code until they are added.

### Sentinel remediation (Rundeck on VM-A)

Sentinel's stage-1 alerts for a hop that can be remediated (`sentinel_class=remediable`, see
sentinel `signoz/README.md` D-8) arrive on the SigNoz channel's `/alert` from AM-S. The
channel handles them in code and never hands them to Claude:

- A **firing** alert runs Rundeck job `actions/<sentinel_action>` in project `sentinel` with
  exactly `target=<sentinel_target>`, `fingerprint=<Alertmanager fingerprint>` and
  `incident=none`. Nothing else is chosen: not the action, the target or a node.
- `sentinel_action` must be in `channels/sentinel-remediation.json` (today
  `restart_otel_agent_pod` and `restart_otel_collector`); changing that list is a reviewed
  MR. `sentinel_target` must be lowercase `/`-separated DNS-label-like segments, and one of
  the values the live job definition enforces for `target`. Anything else is logged and skipped.
- It runs **once per firing episode** (fingerprint and `startsAt`), whatever the outcome:
  started, refused (cooldown, breaker, preconditions, an invalid option) or Rundeck
  unreachable. AM-S's hourly repeat is ignored. The record is kept in
  `data/sentinel-remediations.json`, so a restart does not run it again. Resolved
  notifications are ignored.
- The job posts its own outcome to #alerts-ops. If it does not fix the problem, sentinel's
  stage 2 (`Hop down: <hop>`) escalates to a human; the agent does nothing more.
- Each call to Rundeck times out after 10 s. The execution id is logged to pm2's error log
  (`[sentinel-remediation] started actions/... execution <id>`) and kept in the record.

What ops must provide:

| Item | Value |
|---|---|
| `RUNDECK_API_TOKEN` | The static token of Rundeck user `sre-agent` (Bitwarden `vm-a-rundeck-sentinel`, property `TOKEN_SRE_AGENT`; rendered into Rundeck's `tokens.properties` by VM-A's ExternalSecret). Role `sre-agent`: read project `sentinel`; list, read and run jobs in `actions` and `actions/**`; read their executions. No other scope is needed, and none should be granted. |
| `RUNDECK_URL` | `http://10.66.0.1:30440`: VM-A's WireGuard address and Rundeck's k3s NodePort. Rundeck has no TLS; the channel accepts plain http only to a private address. |
| Network path | Agent VM `wg0` (10.66.0.2) → VM-A `wg0` (10.66.0.1, UDP 51820, `vm-a.internal.alien.club`) → NodePort 30440. The agent VM's side is sentinel `deploy/vm-a/wireguard/agent-vm.conf.tpl`, and VM-A adds the agent as a peer with `AGENT_PUBLIC_KEY=<key> deploy/vm-a/wireguard/setup-vm-a.sh`. VM-A's security group never opens 30440. |

**Until that WireGuard link is up on the agent VM, Rundeck is not reachable from it.** The
template is not applied on the live VM (sentinel gates that on Leo). Without the link, every
remediable alert is logged as `failed` (connection timeout) and stage 2 escalates as designed.
Check it from the agent VM with
`curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://10.66.0.1:30440/user/login` (200 when reachable).

**Add `RUNDECK_URL` and `RUNDECK_API_TOKEN` to an existing VM's `.env` before deploying
0.5.0**, or `start-agent.sh` refuses the restart, as for the `JIRA_*` variables above.

### Creating the GitLab access token

From a machine with owner access:

```bash
curl -s -X POST "https://gitlab.com/api/v4/groups/118473869/access_tokens" \
  -H "PRIVATE-TOKEN: <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"sre-agent-readonly","scopes":["read_api"],"access_level":20,"expires_at":"2027-04-16"}'
```

Add the returned token to `.env` as `GITLAB_TOKEN`.

## 8. Configure Claude Code settings

These settings ensure fully unattended startup (no interactive prompts):

```bash
# User-level settings
cat > ~/.claude/settings.json <<'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "env": {
    "DISABLE_AUTOUPDATER": "1"
  }
}
EOF

# Project-level settings
mkdir -p ~/sre-agent/.claude
cat > ~/sre-agent/.claude/settings.json <<'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "enableAllProjectMcpServers": true,
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
EOF

# Project local settings (not committed to git)
mkdir -p ~/.claude/projects/-home-sre-agent-sre-agent
cat > ~/.claude/projects/-home-sre-agent-sre-agent/settings.local.json <<'EOF'
{
  "skipDangerousModePermissionPrompt": true,
  "enableAllProjectMcpServers": true,
  "isTrusted": true,
  "hasTrustDialogAccepted": true
}
EOF
```

## 9. Authenticate Claude Code

```bash
claude auth login
# Follow the OAuth flow in browser
```

## 9b. Put TLS in front of the webhooks (Caddy)

The webhook channels must not be reachable in cleartext: the shared secret and every
alert payload travel in each request. Caddy terminates TLS for the agent's hostname and
forwards `/alert` and `/trivy` to the channels, which listen on loopback only. It also
forwards `GET /health` and `GET /health/session` of the SigNoz channel, unauthenticated:
sentinel's `sre_agent` hop probes `/health/session` (200 while the Claude session answered a
heartbeat in the last 12 min, 503 otherwise, including for about a minute after every start).
Everything else answers 404.

```bash
# DNS first: an A record for the hostname pointing at the VM (prod: sre-agent.internal.alien.club)
export SRE_AGENT_HOSTNAME=sre-agent.internal.alien.club

# Install Caddy from its official apt repository
sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq && sudo apt-get install -y -qq caddy

# Config from this repo; the hostname comes from the service environment
sudo install -m 0644 provision/caddy/Caddyfile /etc/caddy/Caddyfile
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=SRE_AGENT_HOSTNAME=%s\n' "$SRE_AGENT_HOSTNAME" \
  | sudo tee /etc/systemd/system/caddy.service.d/hostname.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
SRE_AGENT_HOSTNAME=$SRE_AGENT_HOSTNAME caddy validate --config /etc/caddy/Caddyfile
```

The channels bind to loopback by default (`SIGNOZ_WEBHOOK_HOST` / `TRIVY_WEBHOOK_HOST`
default to `127.0.0.1`), so once the agent restarts they are reachable only through Caddy.
They **refuse to start** if either variable is set to anything other than `127.0.0.1`,
`::1` or `localhost`, including an empty value, and `start-agent.sh` then exits non-zero.

**Migrating an existing VM:** a `.env` copied from the old example sets
`SIGNOZ_WEBHOOK_HOST=0.0.0.0` and `TRIVY_WEBHOOK_HOST=0.0.0.0` explicitly. Before deploying
this version, change both to `127.0.0.1` or delete the two lines:

```bash
sed -i -E 's/^(SIGNOZ|TRIVY)_WEBHOOK_HOST=.*/\1_WEBHOOK_HOST=127.0.0.1/' ~/sre-agent/.env
grep -E '^(SIGNOZ|TRIVY)_WEBHOOK_HOST=' ~/sre-agent/.env
```

**Updating the Caddyfile on an existing VM:** Caddy does not reread it on its own. Install
the new file, validate it, then reload (no dropped connections, no certificate reissue):

```bash
sudo install -m 0644 provision/caddy/Caddyfile /etc/caddy/Caddyfile
SRE_AGENT_HOSTNAME=$SRE_AGENT_HOSTNAME caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

In the Scaleway security group, allow 80 (ACME challenge) and 443 inbound, and remove
8788 and 8790. Point SigNoz at `https://$SRE_AGENT_HOSTNAME/alert` (§10) and the Trivy
operator at `https://$SRE_AGENT_HOSTNAME/trivy`.

## 10. Create SigNoz webhook channel

```bash
SIGNOZ_URL="https://uncommon-macaque.eu2.signoz.cloud"
SIGNOZ_API_KEY="<your-signoz-api-key>"
WEBHOOK_TOKEN="<from .env SIGNOZ_WEBHOOK_TOKEN>"

# Create the webhook notification channel
curl -s "$SIGNOZ_URL/api/v1/channels" \
  -H "SIGNOZ-API-KEY: $SIGNOZ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SRE Agent",
    "webhook_configs": [{
      "send_resolved": true,
      "url": "https://'"$SRE_AGENT_HOSTNAME"'/alert",
      "http_config": {
        "basic_auth": {
          "password": "'"$WEBHOOK_TOKEN"'"
        }
      }
    }]
  }'

# Add "SRE Agent" to all alert rules' preferredChannels
# Script: fetch each rule, append "SRE Agent" to preferredChannels, PUT back
# See provisioning session logs for the full batch script
```

## 11. Start the agent

```bash
cd ~/sre-agent
pm2 start ecosystem.config.cjs
pm2 save
sudo env PATH=$PATH:/home/sre-agent/.local/share/npm-global/bin pm2 startup systemd -u sre-agent --hp /home/sre-agent
```

The start script (`scripts/start-agent.sh`) handles:
- Loading `.env`
- Refusing to restart, before stopping the running session, when `.env` lacks a setting a
  channel requires (named in the log and the team channel)
- Waiting for the previous session's webhook ports to be released
- Starting Claude Code in a tmux session with channels, without the systemd user-bus variables
  (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`) an SSH login leaves in pm2's environment, and
  refusing a session that is not in pm2's cgroup. With them, tmux put the session under the
  login's systemd user manager, which killed it when the operator logged out (2026-10-29)
- Auto-accepting the dev channels prompt
- Waiting for this session's webhook channels to bind their ports
- Pasting the initial prompt (briefing and `config/deployment.md`) and proving it was
  submitted: Claude Code is started with a known `--session-id`, and the prompt counts as
  submitted only once its nonce is in that session's transcript
  (`~/.claude/projects/<project>/<session id>.jsonl`), queued or not
- When it cannot be proven, stopping the session so pm2 starts a fresh one to deliver it, at
  most twice an hour (`data/briefing-restarts`); past that the agent keeps running without
  its briefing, and the failure is logged and posted to the team channel (`SLACK_BOT_TOKEN`,
  `SRE_SLACK_CHANNEL`)

## 12. Set up daily restart cron

```bash
(crontab -l 2>/dev/null; echo "0 4 * * * /usr/local/bin/pm2 restart sre-agent >> /var/log/sre-agent/cron-restart.log 2>&1") | crontab -
```

## 12b. Install the session watchdog

`GET /health/session` goes 503 when the Claude session stops answering heartbeats (wedged,
rate-limited, stuck compacting, waiting on a prompt). A systemd timer checks it every minute
from the VM itself and runs `pm2 restart sre-agent` once it has been non-200 for more than 5
consecutive minutes. The rules, all in `scripts/session-watchdog.sh`:

- A restart ends the failure window: the new session answers 503 `never_acked` for about 2 min
  after it starts, and the next restart needs another full 5 min of failures after that.
- A gap of more than 3 min between two checks (the timer did not run, the VM rebooted) starts
  the window again; an old first failure never counts.
- **At most 2 restarts per rolling hour.** Past that it logs the refusal on every check and does
  nothing else: a session that two restarts did not fix needs a human, and sentinel's
  `sre_agent` hop pages one. Every attempt counts, including one pm2 reported as failed.
- A corrupt restart history refuses every restart (and fails the unit) until it is fixed.

The units run as `sre-agent`, with state in `/var/lib/sre-agent-watchdog` (created by systemd,
`0750 sre-agent:sre-agent`). They run the script from the checkout, so `git pull` updates it.

```bash
cd ~/sre-agent
sudo install -m 0644 provision/systemd/sre-agent-session-watchdog.service /etc/systemd/system/
sudo install -m 0644 provision/systemd/sre-agent-session-watchdog.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/sre-agent-session-watchdog.{service,timer}
sudo systemctl daemon-reload
sudo systemctl enable --now sre-agent-session-watchdog.timer

# The unit's PATH must find pm2 (npm-global, /usr/local/bin or /usr/bin), else every restart fails
sudo -u sre-agent env PATH=/home/sre-agent/.local/share/npm-global/bin:/usr/local/bin:/usr/bin:/bin sh -c 'command -v pm2'

# One check now, rather than waiting for the timer
sudo systemctl start sre-agent-session-watchdog.service
journalctl -u sre-agent-session-watchdog -n 5 --no-pager
```

The unit expects the checkout at `/home/sre-agent/sre-agent` and the SigNoz channel on
`127.0.0.1:8788`. If `SIGNOZ_WEBHOOK_PORT` is changed in `.env`, change `SRE_WATCHDOG_URL` in
the unit with `sudo systemctl edit sre-agent-session-watchdog.service`.

**Inspecting it:**

```bash
systemctl list-timers sre-agent-session-watchdog.timer      # last and next run
journalctl -u sre-agent-session-watchdog --since -1h        # one line per check
journalctl -u sre-agent-session-watchdog -p warning         # failures, restarts and refusals only
sudo ls -l /var/lib/sre-agent-watchdog/
sudo cat /var/lib/sre-agent-watchdog/last_restart           # {"last_restart_at":...,"restarts_last_hour":N,"restarts":[...]}
sudo cat /var/lib/sre-agent-watchdog/restart_history        # epoch seconds of the restarts of the last hour
sudo cat /var/lib/sre-agent-watchdog/first_failure          # epoch of the current failure streak; absent while healthy
curl -s http://127.0.0.1:8788/health/session                # also reports last_restart_at and restarts_last_hour
```

`/health/session` reads `last_restart` on each request and adds `last_restart_at` (null when
none is recorded) and `restarts_last_hour` (0 when none; null when the record cannot be read,
which the channel logs). Its status and other fields still come only from the heartbeat. Set
`SRE_WATCHDOG_LAST_RESTART_PATH` in `.env` only if the state directory moves.

To stop it, for maintenance that keeps the session down on purpose:
`sudo systemctl stop sre-agent-session-watchdog.timer` (and `start` it afterwards). A
`pm2 stop sre-agent` alone is not enough: the watchdog would restart it after 5 min.

## 13. Verify

```bash
# Check agent is running
pm2 ls
ss -tlnp | grep 8788

# Check tmux screen
tmux capture-pane -t sre-agent -p | tail -20

# The session answers heartbeats: 503 never_acked for ~1 min after a start, then 200 ok
curl -s "https://$SRE_AGENT_HOSTNAME/health/session"

# The session watchdog's timer is active and its checks see the session healthy
systemctl list-timers sre-agent-session-watchdog.timer
journalctl -u sre-agent-session-watchdog -n 3 --no-pager

# Send a test alert
curl -s -X POST "https://$SRE_AGENT_HOSTNAME/alert" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(printf ':%s' "$WEBHOOK_TOKEN" | base64 -w0)" \
  -d '{"status":"firing","receiver":"test","alerts":[{"status":"firing","labels":{"alertname":"Test","severity":"info"},"annotations":{"summary":"install verification"},"startsAt":"2026-01-01T00:00:00Z","endsAt":"0001-01-01T00:00:00Z","fingerprint":"install-test"}],"groupLabels":{},"commonLabels":{},"commonAnnotations":{},"version":"4"}'

# DM the bot on Slack to test two-way comms
```

## Operations

```bash
# SSH to the VM
ssh sre-agent@163.172.138.203

# Check logs
pm2 logs sre-agent --lines 50

# View agent screen
tmux attach -t sre-agent   # Ctrl+B D to detach

# Restart agent (fresh context)
pm2 restart sre-agent

# What the session watchdog decided, and its restarts (§12b)
journalctl -u sre-agent-session-watchdog --since -1h
sudo cat /var/lib/sre-agent-watchdog/last_restart

# Which alerts were pushed and which duplicates were dropped (one line each)
grep -E '\[signoz-webhook\] (pushed alert|dropped duplicate alert)' /var/log/sre-agent/error.log | tail -20

# Update CLAUDE.md from local
cd /path/to/sre-agent && git push
ssh sre-agent@$SRE_IP 'cd ~/sre-agent && git pull'
pm2 restart sre-agent

# Update channel code
# Same as above — git push, git pull, pm2 restart
```

## Current Deployment

- **VM**: Scaleway DEV1-S, `163.172.138.203`, fr-par-1
- **User**: `sre-agent`
- **Clusters**: platform-dev, platform-prod, data-cluster-dev, data-cluster-biorxiv, data-cluster-alien-hosted
- **SigNoz channel**: "SRE Agent" (webhook, all 20 alert rules)
- **Slack bot**: "Claude SRE" (Socket Mode, DM with CTO)
- **Daily restart**: 4:00 UTC via cron
- **Session watchdog**: systemd timer `sre-agent-session-watchdog.timer`, every minute (§12b)
