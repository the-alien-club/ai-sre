#!/usr/bin/env bash
# SRE Agent start script
# Uses tmux to provide a pseudo-TTY so Claude Code runs in interactive mode.
# pm2 monitors the tmux session via this wrapper.
#
# Startup prompts handled:
#   1. Project trust              → bypassed by settings (enableAllProjectMcpServers, isTrusted)
#   2. MCP server approval        → bypassed by settings (enableAllProjectMcpServers)
#   3. Bypass permissions warning  → bypassed by settings (skipDangerousModePermissionPrompt)
#   4. Dev channels warning        → auto-accepted below (Enter on "I am using this for local development")

set -euo pipefail
cd "$(dirname "$0")/.."
SRE_DIR="$(pwd)"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Ensure bun is in PATH
export PATH="$HOME/.bun/bin:$PATH"

SESSION_NAME="sre-agent"

# Kill existing session if any
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# Start Claude Code in a tmux session
tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 \
  "cd $SRE_DIR && claude --dangerously-skip-permissions --dangerously-load-development-channels server:signoz-webhook server:slack-sre"

# Auto-accept the dev channels prompt
# Poll tmux pane until we see the prompt, then send Enter
for i in $(seq 1 30); do
  sleep 1
  PANE=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null || true)
  if echo "$PANE" | grep -q "I am using this for local development"; then
    tmux send-keys -t "$SESSION_NAME" Enter
    echo "[start-agent] Dev channels prompt auto-accepted"
    break
  fi
  # If we see "Listening for channel messages" we're already past all prompts
  if echo "$PANE" | grep -q "Listening for channel messages"; then
    echo "[start-agent] No prompts needed, already running"
    break
  fi
done

# Wait for Claude to fully initialize (MCP servers to start)
for i in $(seq 1 30); do
  if ss -tlnp | grep -q 8788; then
    echo "[start-agent] Webhook port 8788 bound"
    break
  fi
  sleep 1
done

# Initialize incident database if needed
mkdir -p "$SRE_DIR/data"
if [ ! -f "$SRE_DIR/data/incidents.db" ]; then
  sqlite3 "$SRE_DIR/data/incidents.db" < "$SRE_DIR/scripts/incidents-db-init.sql"
  echo "[start-agent] Incident database initialized"
fi

# Generate startup briefing
BRIEFING=$("$SRE_DIR/scripts/incidents.sh" briefing --days 7 2>/dev/null || echo "No incident history yet.")
echo "[start-agent] Briefing generated"

# Load deployment-specific config (real project IDs, Slack IDs, etc.)
DEPLOY_CONFIG=""
if [ -f "$SRE_DIR/config/deployment.md" ]; then
  DEPLOY_CONFIG=$(cat "$SRE_DIR/config/deployment.md")
  echo "[start-agent] Deployment config loaded"
else
  echo "[start-agent] WARNING: no config/deployment.md — agent will use placeholders from CLAUDE.md"
fi

# Send the initial prompt with briefing + deployment config
sleep 2
PROMPT="You are the SRE agent. You are now live.

Here is your situational briefing from the incident database:

${BRIEFING}

Here is your deployment-specific configuration (real values for this environment):

${DEPLOY_CONFIG}

Use these real values when spawning sub-agents — they override any placeholders in CLAUDE.md.

Follow the runbook in CLAUDE.md. Wait for alerts from signoz-webhook and messages from the CTO via slack-sre. Confirm you are ready by listing your kubectl contexts."

tmux send-keys -t "$SESSION_NAME" "$PROMPT" Enter

echo "[start-agent] Agent started with briefing, monitoring tmux session"

# Keep this script alive so pm2 considers the process running.
# Monitor the tmux session — if it dies, this script exits and pm2 restarts.
while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 10
done

echo "[start-agent] tmux session ended, exiting"
exit 1
