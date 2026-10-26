# shellcheck shell=bash
# submit_prompt <tmux-session> <prompt> [attempts]
#
# Types <prompt> into the Claude Code session and makes sure it is actually submitted.
#
# `tmux send-keys "$PROMPT" Enter` sends a multi-line prompt fast enough that Claude Code
# treats it as a paste, and the trailing Enter is swallowed into that paste. The prompt then
# sat unsubmitted in the input box ("❯ [Pasted text #1 +48 lines]…") for the agent's whole
# life, so it never received its briefing or deployment config (SDS-992).
#
# So the text is typed literally, then Enter is sent on its own after a pause, and the input
# box is checked: while it still holds the pasted text, Enter is retried. Succeeds once the
# box is empty; fails after <attempts> tries (default 5).
submit_prompt() {
  local session="$1" prompt="$2" attempts="${3:-5}" attempt
  tmux send-keys -t "$session" -l "$prompt"
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    sleep "${SUBMIT_PROMPT_PAUSE:-2}"
    tmux send-keys -t "$session" Enter
    sleep "${SUBMIT_PROMPT_PAUSE:-2}"
    if ! tmux capture-pane -t "$session" -p | grep -q '^❯ \[Pasted text'; then
      echo "[start-agent] startup prompt submitted (attempt ${attempt})"
      return 0
    fi
  done
  echo "[start-agent] startup prompt still unsubmitted after ${attempts} attempts" >&2
  return 1
}
