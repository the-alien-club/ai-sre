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
# input box must be recognised and the prompt must be seen landing in it. Submitted means
# Claude Code wrote the prompt into the session's transcript: the session is started with a
# known --session-id, and the prompt carries a nonce that only it contains. An input box
# that empties is not proof: on 2026-10-29 at 11:53 an alert started a turn 4 s before the
# prompt was pasted, Claude Code queued the prompt (it delivered it 32 s later), and the box
# never showed empty, so the old check pressed Enter five times and reported a briefing
# that had been delivered as lost. A session that is gone, a UI this code does not
# recognise, or a prompt that never reaches the transcript are all failures, never successes.

# shellcheck source=scripts/lib/notify-ops.sh
source "$(dirname "${BASH_SOURCE[0]}")/notify-ops.sh"
# shellcheck source=scripts/lib/briefing-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/briefing-retry.sh"

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

# transcript_has <projects-dir> <session-id> <nonce>: whether Claude Code recorded a message
# carrying the nonce in this session's transcript, <projects-dir>/<project>/<session-id>.jsonl.
# A queued prompt is recorded when it is queued, a submitted one when it is submitted.
transcript_has() {
  local projects="$1" id="$2" nonce="$3" transcript
  transcript="$(find "$projects" -mindepth 2 -maxdepth 2 -type f -name "${id}.jsonl" -print -quit)"
  [ -n "$transcript" ] && grep -qF -- "$nonce" "$transcript"
}

# submit_prompt <tmux-session> <prompt> <nonce> <projects-dir> <session-id> [attempts]
# The prompt must contain the nonce, and the session must have been started with
# `claude --session-id <session-id>`, whose transcript lives under <projects-dir>.
submit_prompt() {
  local session="$1" prompt="$2" nonce="$3" projects="$4" id="$5" attempts="${6:-5}"
  local pause="${SUBMIT_PROMPT_PAUSE:-2}" box attempt

  if [ -z "$nonce" ] || [[ "$prompt" != *"$nonce"* ]]; then
    echo "[start-agent] the startup prompt does not carry its nonce; its submission could not be proven" >&2
    return 1
  fi

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

  # Enter only while the input box still holds the prompt: once it has left the box, Claude
  # Code has it (submitted or queued) and another Enter could submit something else.
  for (( attempt = 1; attempt <= attempts; attempt++ )); do
    if ! box="$(input_box "$session")"; then
      echo "[start-agent] lost the Claude Code input box in tmux session ${session}" >&2
      return 1
    fi
    if prompt_landed "$box" "$prompt" && ! tmux send-keys -t "$session" Enter; then
      echo "[start-agent] could not send Enter to tmux session ${session}" >&2
      return 1
    fi
    sleep "$pause"
    if transcript_has "$projects" "$id" "$nonce"; then
      echo "[start-agent] startup prompt submitted (attempt ${attempt})"
      return 0
    fi
  done
  echo "[start-agent] startup prompt still not in session ${id}'s transcript after ${attempts} attempts" >&2
  return 1
}

# submit_startup_prompt <tmux-session> <prompt> <nonce> <projects-dir> <session-id> <retry-state>
# Submits the prompt (submit_prompt). On failure it decides, through the bounded retry in
# <retry-state> (briefing-retry.sh), what the caller does:
#   0  submitted.
#   2  not submitted; restart the session to try again. Logged; the team channel is not
#      paged for a retry that will most likely deliver it.
#   1  not submitted and no retry left: the session keeps running without its briefing,
#      because it is useful without it (alerts and Slack still flow). Logged, and the team
#      channel is told.
submit_startup_prompt() {
  local session="$1" retry_state="$6" verdict
  submit_prompt "$1" "$2" "$3" "$4" "$5" && return 0

  if verdict="$(briefing_retry_take "$retry_state" "$(date +%s)")"; then
    echo "[start-agent] ERROR: the startup prompt was not delivered; restarting the session to deliver it" \
      "(briefing restart ${verdict})" >&2
    return 2
  fi
  echo "[start-agent] ERROR: the agent is running WITHOUT its briefing and deployment config;" \
    "see the error above. No restart for it: ${verdict}. pm2 restart sre-agent tries again" >&2
  notify_ops ":rotating_light: *SRE Agent Health Alert*

*Startup briefing not delivered:* the agent restarted on ${HOSTNAME} at $(date -u '+%Y-%m-%d %H:%M UTC') and is running WITHOUT its incident briefing and deployment config. Restarting the session did not deliver it either (${verdict}).
*Impact:* alerts and Slack still reach it, but it triages without recent incident history and with the placeholder project IDs from CLAUDE.md.
*Action needed:* read \`pm2 logs sre-agent --err --lines 40\` on the agent VM and \`tmux capture-pane -t ${session} -p\`, then \`pm2 restart sre-agent\`." \
    || echo "[start-agent] ERROR: the team channel could not be told that the briefing was not delivered" >&2
  return 1
}
