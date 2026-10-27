# shellcheck shell=bash
# Checking, before the running session is stopped, that .env holds every setting a webhook
# or Slack channel refuses to start without.
#
# A channel missing one of them exits before it binds its port. start-agent.sh would only
# see that as a port left unbound 15 to 30 seconds later, after it had already killed the
# working session, with the reason in the channel's MCP log rather than pm2's. Since 0.4.0
# the Trivy channel also needs the Jira credentials, which a VM upgraded in place does not
# have yet. Checked here first, the missing names go to the log and the team channel, and
# the session that is running is left alone.
#
# Presence only: each channel still validates the values itself. channel-settings.test.ts
# keeps this list in step with what the channels require.

REQUIRED_CHANNEL_SETTINGS=(
  # signoz-webhook
  SIGNOZ_WEBHOOK_TOKEN
  # slack-sre; trivy-webhook posts with the same bot, channel and operator roster
  SLACK_BOT_TOKEN
  SLACK_APP_TOKEN
  SRE_SLACK_CHANNEL
  SRE_OPERATORS
  # trivy-webhook
  TRIVY_WEBHOOK_TOKEN
  JIRA_BASE_URL
  JIRA_USER_EMAIL
  JIRA_API_TOKEN
)

# missing_channel_settings: the names in REQUIRED_CHANNEL_SETTINGS that are unset or blank,
# separated by spaces; empty when none is missing.
missing_channel_settings() {
  local name missing=()
  for name in "${REQUIRED_CHANNEL_SETTINGS[@]}"; do
    [[ "${!name:-}" =~ [^[:space:]] ]] || missing+=("$name")
  done
  printf '%s' "${missing[*]}"
}
