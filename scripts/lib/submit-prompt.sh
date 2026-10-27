# shellcheck shell=bash
# Submitting the startup prompt into the Claude Code session, with proof that it was sent.
#
# `tmux send-keys "$PROMPT" Enter` sends a multi-line prompt fast enough that Claude Code
# treats it as a paste, and the trailing Enter is swallowed into that paste. The prompt then
# sat unsubmitted in the input box for the agent's whole life, so it never received its
# briefing or deployment config (SDS-992).
#
# The prompt is not typed with `send-keys -l` either: tmux carries a send-keys argument in
# one client-to-server message, so a prompt over about 16KB fails with "command too long"
# (the ~50KB prompt did, on every restart from 2026-10-27 03:00). It goes through a paste
# buffer instead: `load-buffer -` streams stdin to the server in chunks, with no size
# limit, and `paste-buffer` writes it into the pane as one paste.
#
# Success is never inferred from something being absent. Every tmux call is checked, the
# input box must be recognised, the prompt must be seen landing in it, and only an input
# box that is then empty again counts as submitted. A session that is gone, a UI this code
# does not recognise, or a prompt that never lands are all failures, never successes.

# The input box as rendered by Claude Code (checked on the VM, Claude Code 2.1.110, tmux
# 3.4): the lines between the last two horizontal rules, the first of them starting with
# "❯" and a no-break space (U+00A0), not an ordinary space.
readonly SUBMIT_PROMPT_CARET=$'❯'
readonly SUBMIT_PROMPT_NBSP=$' '

# input_box <tmux-session>: print the input box's lines from the visible pane, or fail when
# the pane cannot be captured or no input box is recognised in it.
input_box() {
  local pane
  pane="$(tmux capture-pane -t "$1" -p)" || return 1
  printf '%s\n' "$pane" | awk -v caret="$SUBMIT_PROMPT_CARET" '
    /^─+/ { if (count++ > 0) { prev = last }; last = NR; next }
    { line[NR] = $0 }
    END {
      if (count < 2) exit 1
      for (i = prev + 1; i < last; i++) printf "%s\n", line[i]
      if (index(line[prev + 1], caret) != 1) exit 1
    }'
}

# input_box_text <box>: the box's content with the caret and no-break spaces removed.
input_box_text() {
  local text="${1#"$SUBMIT_PROMPT_CARET"}"
  text="${text//"$SUBMIT_PROMPT_NBSP"/ }"
  printf '%s' "$text" | tr -d '[:space:]'
}

# prompt_landed <box> <prompt>: whether the input box holds this prompt. Claude Code shows
# a short prompt as pasted and collapses a long one into "[Pasted text #1 +48 lines]"
# (as seen on the VM), so either the prompt's first line or that placeholder counts;
# any other content, such as text someone else typed, does not.
prompt_landed() {
  local box first_line
  box="$(input_box_text "$1")"
  first_line="$(printf '%s\n' "$2" | head -n 1 | tr -d '[:space:]')"
  [[ -n "$first_line" && "$box" == *"$first_line"* ]] || [[ "$box" == *"[Pastedtext#"* ]]
}

# paste_prompt <tmux-session> <prompt>: paste the prompt into the session's pane, whatever
# its size. -p brackets the paste when the application has enabled bracketed paste, and -r
# keeps newlines as LF, as `send-keys -l` sent them: tmux would otherwise turn each into a
# CR, which is Enter. -d drops the buffer once pasted; on failure it is deleted here, so
# the briefing does not linger in the tmux server.
paste_prompt() {
  local session="$1" prompt="$2" buffer="sre-startup-prompt-$$"

  if ! printf '%s' "$prompt" | tmux load-buffer -b "$buffer" -; then
    echo "[start-agent] could not load the startup prompt into a tmux buffer" >&2
    return 1
  fi
  if ! tmux paste-buffer -b "$buffer" -d -p -r -t "$session"; then
    tmux delete-buffer -b "$buffer" \
      || echo "[start-agent] could not delete tmux buffer ${buffer}, which holds the startup prompt" >&2
    echo "[start-agent] could not paste the startup prompt into tmux session ${session}" >&2
    return 1
  fi
}

# submit_prompt <tmux-session> <prompt> [attempts]
submit_prompt() {
  local session="$1" prompt="$2" attempts="${3:-5}" pause="${SUBMIT_PROMPT_PAUSE:-2}" box attempt

  paste_prompt "$session" "$prompt" || return 1

  # The prompt must be seen in the input box before Enter means anything
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    sleep "$pause"
    if ! box="$(input_box "$session")"; then
      echo "[start-agent] no Claude Code input box recognised in tmux session ${session}" >&2
      return 1
    fi
    prompt_landed "$box" "$prompt" && break
  done
  if ! prompt_landed "$box" "$prompt"; then
    echo "[start-agent] the startup prompt never appeared in the input box" >&2
    return 1
  fi

  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if ! tmux send-keys -t "$session" Enter; then
      echo "[start-agent] could not send Enter to tmux session ${session}" >&2
      return 1
    fi
    sleep "$pause"
    if ! box="$(input_box "$session")"; then
      echo "[start-agent] lost the Claude Code input box in tmux session ${session}" >&2
      return 1
    fi
    if [ -z "$(input_box_text "$box")" ]; then
      echo "[start-agent] startup prompt submitted (attempt ${attempt})"
      return 0
    fi
  done
  echo "[start-agent] startup prompt still unsubmitted after ${attempts} attempts" >&2
  return 1
}

# submit_startup_prompt <tmux-session> <prompt>: submit, and on failure say so loudly with
# the manual fix. Never fails the start: the agent is useful without its briefing (alerts
# and Slack still flow), and a restart loop would take its triage down with it.
submit_startup_prompt() {
  if ! submit_prompt "$1" "$2"; then
    echo "[start-agent] ERROR: the agent is running WITHOUT its briefing and deployment config; submit it by hand: tmux send-keys -t $1 Enter" >&2
  fi
}
