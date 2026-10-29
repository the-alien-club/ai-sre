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

SIGNOZ_PORT="${SIGNOZ_WEBHOOK_PORT:-8788}"
TRIVY_PORT="${TRIVY_WEBHOOK_PORT:-8790}"
# shellcheck source=scripts/lib/wait-for-port.sh
source "$SRE_DIR/scripts/lib/wait-for-port.sh"
# shellcheck source=scripts/lib/channel-settings.sh
source "$SRE_DIR/scripts/lib/channel-settings.sh"
# shellcheck source=scripts/lib/notify-ops.sh
source "$SRE_DIR/scripts/lib/notify-ops.sh"
# shellcheck source=scripts/lib/session-cgroup.sh
source "$SRE_DIR/scripts/lib/session-cgroup.sh"

# A channel without its settings never binds its port, so the new session could not take
# alert ingestion over. Refuse before stopping the running session (see
# channel-settings.sh), and say which settings are missing.
MISSING_SETTINGS="$(missing_channel_settings)"
if [ -n "$MISSING_SETTINGS" ]; then
  if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    RUNNING="The session already running was left as it is, on the code it started with."
  else
    RUNNING="No agent session is running: alerts and Slack are not being handled."
  fi
  echo "[start-agent] not restarting: .env does not set ${MISSING_SETTINGS}, which the channels need to start. ${RUNNING}" >&2
  notify_ops ":rotating_light: *SRE Agent Health Alert*

*Restart refused:* the agent on ${HOSTNAME} did not restart at $(date -u '+%Y-%m-%d %H:%M UTC'): its \`.env\` does not set ${MISSING_SETTINGS}, which the channels need to start.
*Impact:* ${RUNNING}
*Action needed:* add them to \`.env\` on the agent VM (see \`.env.example\`), then \`pm2 restart sre-agent\`." \
    || echo "[start-agent] ERROR: the team channel could not be told that the restart was refused" >&2
  exit 1
fi

# Kill existing session if any
tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

# The old session's channels take a moment to exit after it is killed. A new channel
# started while one of them still holds its port dies with EADDRINUSE, so wait for the
# ports to be released; one that stays held (an orphaned channel) is a failed start.
if ! wait_for_port_free "SigNoz webhook" "$SIGNOZ_PORT" 20 \
  || ! wait_for_port_free "Trivy webhook" "$TRIVY_PORT" 20; then
  echo "[start-agent] a webhook port is still held; stop the process named above before restarting" >&2
  exit 1
fi

# Start Claude Code in a tmux session. Without the user bus variables an SSH login may have
# left in pm2's environment: with them, tmux puts the pane under that login's systemd user
# manager, which kills it when the login ends (see session-cgroup.sh).
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR \
  tmux new-session -d -s "$SESSION_NAME" -x 200 -y 50 \
  "cd $SRE_DIR && claude --dangerously-skip-permissions --dangerously-load-development-channels server:signoz-webhook server:slack-sre server:trivy-webhook"
# The channels run under this process; only a listener below it is this session's
if ! SESSION_PID="$(tmux display-message -p -t "$SESSION_NAME" '#{pane_pid}')" \
  || [[ ! "$SESSION_PID" =~ ^[0-9]+$ ]]; then
  echo "[start-agent] could not read the PID of tmux session ${SESSION_NAME}" >&2
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  exit 1
fi

# Auto-accept the dev channels prompt
# Poll tmux pane until we see the prompt, then send Enter
for _ in $(seq 1 30); do
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

# Wait for this session's webhook channels to bind. A channel that never binds (missing
# secret, crash on start) means the agent would go live with no alert ingestion, which is
# worse than not starting: stop the session and exit non-zero so pm2 restarts and the
# failure shows up in its logs instead of passing silently. A listener outside the session
# does not count (see wait-for-port.sh).
if ! wait_for_port "SigNoz webhook" "$SIGNOZ_PORT" 30 "$SESSION_PID" \
  || ! wait_for_port "Trivy webhook" "$TRIVY_PORT" 15 "$SESSION_PID"; then
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  echo "[start-agent] a webhook channel did not start; check the channel's stderr in the tmux log" >&2
  exit 1
fi

# The session must live and die with this script, in pm2's cgroup. The check runs once Claude
# Code is up: tmux moves a pane into a scope between fork and exec.
if ! same_cgroup "$SESSION_PID"; then
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
  echo "[start-agent] the session was not started in pm2's cgroup; a tmux server started by another login" \
    "(tmux ls) would cause this: stop it, then pm2 restart sre-agent" >&2
  exit 1
fi

# Initialize incident database if needed
mkdir -p "$SRE_DIR/data"
if [ ! -f "$SRE_DIR/data/incidents.db" ]; then
  sqlite3 "$SRE_DIR/data/incidents.db" < "$SRE_DIR/scripts/incidents-db-init.sql"
  echo "[start-agent] Incident database initialized"
fi

# Generate startup briefing
BRIEFING=$("$SRE_DIR/scripts/incidents.sh" briefing --days 7 2>/dev/null || echo "Incident briefing unavailable: incidents.sh briefing failed, check data/incidents.db.")
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

Follow the runbook in CLAUDE.md. Wait for alerts from signoz-webhook and messages from the ops team via slack-sre. Remember you are in a shared team channel, not a private DM — see \"Talking to the Ops Team\" in CLAUDE.md. Confirm you are ready by listing your kubectl contexts."

# Submit the prompt and prove it was sent. A failure is reported in the log and the team
# channel, and the agent keeps running without its briefing (see submit-prompt.sh).
# shellcheck source=scripts/lib/submit-prompt.sh
source "$SRE_DIR/scripts/lib/submit-prompt.sh"
if submit_startup_prompt "$SESSION_NAME" "$PROMPT"; then
  echo "[start-agent] Agent started with briefing, monitoring tmux session"
else
  echo "[start-agent] Agent started WITHOUT its briefing, monitoring tmux session" >&2
fi

# Keep this script alive so pm2 considers the process running.
# Monitor the tmux session — if it dies, this script exits and pm2 restarts.
while tmux has-session -t "$SESSION_NAME" 2>/dev/null; do
  sleep 10
done

echo "[start-agent] tmux session ended, exiting"
exit 1
