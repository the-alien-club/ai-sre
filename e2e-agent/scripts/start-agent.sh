#!/usr/bin/env bash
# E2E QA Agent start script
# Mirrors the SRE agent's start pattern: Claude Code in tmux under PM2.

set -euo pipefail
cd "$(dirname "$0")/.."
QA_DIR="$(pwd)"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export PATH="$HOME/.bun/bin:$PATH"

SESSION_NAME="e2e-agent"

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 \
  "cd $QA_DIR && claude --dangerously-skip-permissions --dangerously-load-development-channels server:gitlab-webhook server:slack-qa"

# Auto-accept the dev channels prompt
for i in $(seq 1 30); do
  sleep 1
  PANE=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null || true)
  if echo "$PANE" | grep -q "I am using this for local development"; then
    tmux send-keys -t "$SESSION_NAME" Enter
    echo "[start-agent] Dev channels prompt auto-accepted"
    break
  fi
  if echo "$PANE" | grep -q "Listening for channel messages"; then
    echo "[start-agent] No prompts needed, already running"
    break
  fi
done

# Wait for the GitLab webhook port to bind
GITLAB_PORT="${GITLAB_WEBHOOK_PORT:-8791}"
for i in $(seq 1 30); do
  if ss -tlnp | grep -q ":$GITLAB_PORT"; then
    echo "[start-agent] GitLab webhook port $GITLAB_PORT bound"
    break
  fi
  sleep 1
done

# Initialize test database if needed
mkdir -p "$QA_DIR/data"
if [ ! -f "$QA_DIR/data/tests.db" ]; then
  sqlite3 "$QA_DIR/data/tests.db" < "$QA_DIR/scripts/tests-db-init.sql"
  echo "[start-agent] Test database initialized"
fi

# Generate startup briefing
BRIEFING=$("$QA_DIR/scripts/tests.sh" briefing --days 7 2>/dev/null || echo "No test history yet.")
echo "[start-agent] Briefing generated"

# Load deployment-specific config (project IDs, base URLs, Slack IDs)
DEPLOY_CONFIG=""
if [ -f "$QA_DIR/config/deployment.md" ]; then
  DEPLOY_CONFIG=$(cat "$QA_DIR/config/deployment.md")
  echo "[start-agent] Deployment config loaded"
else
  echo "[start-agent] WARNING: no config/deployment.md — agent will use placeholders from CLAUDE.md"
fi

sleep 2
PROMPT="You are the E2E QA agent. You are now live.

Here is your situational briefing from the test database:

${BRIEFING}

Here is your deployment-specific configuration (real values for this environment):

${DEPLOY_CONFIG}

Use these real values when spawning sub-agents — they override any placeholders in CLAUDE.md.

Follow the runbook in CLAUDE.md. Wait for events from gitlab-webhook (MR pipelines) and messages from the owner via slack-qa. Confirm you are ready by running: ls playbooks/ && playwright --version"

tmux send-keys -t "$SESSION_NAME" "$PROMPT" Enter

echo "[start-agent] Agent started, monitoring tmux session"

while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 10
done

echo "[start-agent] tmux session ended, exiting"
exit 1
