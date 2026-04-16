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
ssh root@$SRE_IP

useradd -m -s /bin/bash sre-agent
usermod -aG sudo sre-agent
echo "sre-agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/sre-agent

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

## 5. Create RBAC-scoped kubeconfigs

The agent should NOT have cluster-admin access. Create a scoped ServiceAccount on each cluster.

```bash
# From a machine with admin kubeconfigs, apply the RBAC manifest to each cluster:
# (The RBAC YAML is in this repo — see below)

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
  KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f /tmp/sre-agent-rbac.yaml
done
```

The RBAC manifest creates:
- ServiceAccount `sre-agent` in `kube-system`
- ClusterRole with: read all, patch deployments (rollout restart), delete pods + workflows
- ClusterRoleBinding
- Long-lived token Secret

Then generate scoped kubeconfigs using each SA token, merge them, and copy to the VM:

```bash
# For each cluster, extract token and build a scoped kubeconfig entry
# Then merge: KUBECONFIG="file1:file2:..." kubectl config view --flatten > merged.yaml
scp merged.yaml sre-agent@$SRE_IP:~/.kube/config
```

See the provisioning session logs for the full script.

## 6. Create the Slack app

1. Go to https://api.slack.com/apps → **Create New App**
2. **Socket Mode**: Enable (Settings → Socket Mode → toggle on)
3. **App-Level Token**: Create one with `connections:write` scope → this is `SLACK_APP_TOKEN`
4. **Bot Token Scopes** (OAuth & Permissions): `chat:write`, `im:read`, `im:write`, `im:history`
5. **Event Subscriptions**: Enable → Subscribe to bot events → add `message.im`
6. **App Home**: Enable Messages Tab + "Allow users to send Slash commands and messages"
7. **Install to Workspace** → copy the Bot User OAuth Token → this is `SLACK_BOT_TOKEN`
8. Find your Slack user ID (your profile → three dots → Copy member ID) → this is `CTO_SLACK_ID`

## 7. Create the `.env` file

```bash
cd ~/sre-agent
cp .env.example .env
# Edit with real values:
# SIGNOZ_WEBHOOK_TOKEN: generate with `openssl rand -hex 32`
# SLACK_BOT_TOKEN: from step 6
# SLACK_APP_TOKEN: from step 6
# CTO_SLACK_ID: from step 6
# GITLAB_TOKEN: group access token with read_api scope (Reporter level)
```

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
      "url": "http://'"$SRE_IP"':8788/alert",
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
- Starting Claude Code in a tmux session with channels
- Auto-accepting the dev channels prompt
- Waiting for the webhook port to bind
- Sending the initial prompt

## 12. Set up daily restart cron

```bash
(crontab -l 2>/dev/null; echo "0 4 * * * /usr/local/bin/pm2 restart sre-agent >> /var/log/sre-agent/cron-restart.log 2>&1") | crontab -
```

## 13. Verify

```bash
# Check agent is running
pm2 ls
ss -tlnp | grep 8788

# Check tmux screen
tmux capture-pane -t sre-agent -p | tail -20

# Send a test alert
curl -s -X POST "http://$SRE_IP:8788/alert" \
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
