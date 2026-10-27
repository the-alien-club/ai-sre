# shellcheck shell=bash
# Posting a notice to the team channel from start-agent.sh, for failures the agent cannot
# report itself.
#
# A start that leaves the agent running degraded (for instance without its briefing) only
# ever reached pm2's error.log, and nobody reads that until something else breaks: the
# briefing went undelivered on every restart from 2026-10-27 03:00 while out.log said
# "Agent started with briefing". The team channel is where the ops team will see it.
#
# Uses the bot token the slack-sre channel already holds (chat:write). The token never
# appears on a command line: curl reads the Authorization header from a file descriptor.

# notify_json_string <text>: <text> as a JSON string literal. The notices are written by
# this script, so escaping the characters they can contain is enough; anything else is
# refused rather than sent malformed.
notify_json_string() {
  local text="$1" others="${1//[$'\n\t']/}"
  if [[ "$others" =~ [[:cntrl:]] ]]; then
    echo "[start-agent] refusing to send a notice containing control characters" >&2
    return 1
  fi
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/\\n}"
  text="${text//$'\t'/\\t}"
  printf '"%s"' "$text"
}

# notify_ops <text>: post <text> to $SRE_SLACK_CHANNEL as the bot. Fails, saying why, when
# Slack is not configured, unreachable within 10 seconds, or refuses the message.
notify_ops() {
  local text="$1" body response

  if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SRE_SLACK_CHANNEL:-}" ]; then
    echo "[start-agent] cannot notify the team channel: SLACK_BOT_TOKEN or SRE_SLACK_CHANNEL is not set" >&2
    return 1
  fi
  if [[ ! "$SRE_SLACK_CHANNEL" =~ ^[A-Z0-9]+$ ]]; then
    echo "[start-agent] cannot notify the team channel: SRE_SLACK_CHANNEL is not a Slack channel ID" >&2
    return 1
  fi
  text="$(notify_json_string "$text")" || return 1
  body="{\"channel\":\"${SRE_SLACK_CHANNEL}\",\"text\":${text}}"

  if ! response="$(curl --silent --show-error --connect-timeout 5 --max-time 10 \
      --header @<(printf 'Authorization: Bearer %s\n' "$SLACK_BOT_TOKEN") \
      --header 'Content-Type: application/json; charset=utf-8' \
      --data-binary @- https://slack.com/api/chat.postMessage <<< "$body")"; then
    echo "[start-agent] could not reach Slack to notify the team channel" >&2
    return 1
  fi
  # Slack answers 200 with "ok":false on refusal (bad token, not in channel, ...)
  if [[ "$response" != *'"ok":true'* ]]; then
    echo "[start-agent] Slack refused the notice: ${response:0:300}" >&2
    return 1
  fi
  echo "[start-agent] team channel notified"
}
