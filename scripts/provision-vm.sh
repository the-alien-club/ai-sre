#!/usr/bin/env bash
set -euo pipefail

# SRE Agent VM Provisioning Script
# Run this on a fresh Ubuntu 22.04+ Scaleway VM
#
# Prerequisites:
#   - SSH access to the VM
#   - A GitLab deploy key (read-only) added to the VM's ~/.ssh/
#   - kubeconfig files for all clusters
#
# Usage:
#   ssh sre-agent@<vm-ip> 'bash -s' < scripts/provision-vm.sh

echo "=== SRE Agent VM Provisioning ==="
echo "Date: $(date -u)"
echo ""

# -- System packages -----------------------------------------------------------

echo ">>> Installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl \
  git \
  unzip \
  jq \
  postgresql-client \
  apt-transport-https \
  ca-certificates \
  gnupg

# -- Node.js 20 (via NodeSource) ----------------------------------------------

echo ">>> Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node --version)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "Node: $(node --version)"
echo "npm: $(npm --version)"

# -- Bun -----------------------------------------------------------------------

echo ">>> Installing Bun..."
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc
  echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
echo "Bun: $(bun --version)"

# -- Claude Code ---------------------------------------------------------------

echo ">>> Installing Claude Code..."
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code
fi
echo "Claude Code: $(claude --version 2>/dev/null || echo 'installed, needs auth')"

# -- kubectl -------------------------------------------------------------------

echo ">>> Installing kubectl..."
if ! command -v kubectl &>/dev/null; then
  curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
  sudo apt-get update -qq
  sudo apt-get install -y -qq kubectl
fi
echo "kubectl: $(kubectl version --client --short 2>/dev/null || kubectl version --client)"

# -- Helm ----------------------------------------------------------------------

echo ">>> Installing Helm..."
if ! command -v helm &>/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
fi
echo "Helm: $(helm version --short)"

# -- ArgoCD CLI ----------------------------------------------------------------

echo ">>> Installing ArgoCD CLI..."
if ! command -v argocd &>/dev/null; then
  curl -sSL -o /tmp/argocd https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
  sudo install -m 555 /tmp/argocd /usr/local/bin/argocd
  rm -f /tmp/argocd
fi
echo "ArgoCD CLI: $(argocd version --client --short 2>/dev/null || echo 'installed')"

# -- pm2 -----------------------------------------------------------------------

echo ">>> Installing pm2..."
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
fi
echo "pm2: $(pm2 --version)"

# -- Log directory -------------------------------------------------------------

echo ">>> Creating log directory..."
sudo mkdir -p /var/log/sre-agent
sudo chown "$(whoami)":"$(whoami)" /var/log/sre-agent

# -- Clone repositories --------------------------------------------------------

REPO_DIR="$HOME/repos"
GITLAB_BASE="git@gitlab.com:alias3/datastreaming"

echo ">>> Cloning repositories into $REPO_DIR..."
mkdir -p "$REPO_DIR"

repos=(
  web-app
  workers
  data-pipelines
  data-cluster
  data-cluster-operator
  data-cluster-helm
  k8s-charts
  MCPs
  skupper-gateway
)

for repo in "${repos[@]}"; do
  if [ -d "$REPO_DIR/$repo" ]; then
    echo "  $repo: already cloned, pulling latest..."
    git -C "$REPO_DIR/$repo" pull --ff-only 2>/dev/null || true
  else
    echo "  $repo: cloning..."
    git clone --depth 1 "$GITLAB_BASE/$repo.git" "$REPO_DIR/$repo" 2>/dev/null || {
      echo "  WARNING: Failed to clone $repo — check SSH key"
    }
  fi
done

# -- SRE Agent project setup --------------------------------------------------

SRE_DIR="$REPO_DIR/sre-agent"
echo ">>> Setting up SRE agent..."

if [ ! -d "$SRE_DIR" ]; then
  echo "  Copying sre-agent from DataStreaming repo or creating fresh..."
  # If running from the DataStreaming repo:
  if [ -d "./sre-agent" ]; then
    cp -r ./sre-agent "$SRE_DIR"
  else
    echo "  WARNING: sre-agent directory not found. Clone it manually."
  fi
fi

if [ -d "$SRE_DIR" ]; then
  cd "$SRE_DIR"
  echo "  Installing dependencies..."
  bun install
fi

# -- Kubeconfig reminder -------------------------------------------------------

echo ""
echo "=== Manual Steps Required ==="
echo ""
echo "1. KUBECONFIG: Copy kubeconfig files to ~/.kube/config (or set KUBECONFIG env var)"
echo "   Clusters needed:"
echo "     - platform-dev"
echo "     - data-cluster-dev"
echo "     - platform-staging / data-cluster-staging (if applicable)"
echo "     - production clusters"
echo ""
echo "2. CLAUDE AUTH: Run 'claude auth login' to authenticate with claude.ai (OAuth)"
echo ""
echo "3. ENV VARS: Copy .env.example to .env and fill in:"
echo "     - SIGNOZ_WEBHOOK_TOKEN (generate: openssl rand -hex 32)"
echo "     - SLACK_BOT_TOKEN (from Slack app settings)"
echo "     - SLACK_APP_TOKEN (from Slack app settings, needs connections:write)"
echo "     - CTO_SLACK_ID (Slack user ID)"
echo ""
echo "4. SIGNOZ WEBHOOK: Add a webhook notification channel in SigNoz:"
echo "     - URL: http://<this-vm-ip>:8788/alert"
echo "     - Add Authorization header: Bearer <SIGNOZ_WEBHOOK_TOKEN>"
echo "     - Add to preferredChannels on each alert rule"
echo ""
echo "5. START: cd $SRE_DIR && pm2 start ecosystem.config.cjs"
echo "   Then: pm2 save && pm2 startup (to survive reboots)"
echo ""
echo "=== Provisioning Complete ==="
