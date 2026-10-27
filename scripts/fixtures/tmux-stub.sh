#!/usr/bin/env bash
# Stub tmux for submit-prompt.test.ts. Parses its flags like tmux, logs send-keys and
# paste-buffer calls to $STUB_LOG, and renders a Claude Code input box that holds the
# pasted prompt until $STUB_ENTERS_NEEDED Enters arrive, shown as Claude Code's paste
# placeholder, or as the pasted first line with STUB_SHOW_LITERAL. STUB_FAIL_LOAD,
# STUB_FAIL_PASTE, STUB_FAIL_SEND, STUB_FAIL_CAPTURE, STUB_NO_UI, STUB_NO_LAND and
# STUB_SHOW_OTHER make it fail the way a real session can. Unknown flags are rejected, as
# real tmux does, and so is a send-keys argument over tmux's message size, so typing a
# large prompt instead of pasting it shows up in the tests.
command="$1"; shift
target=""; buffer=""; literal=""; keys=()
while [ $# -gt 0 ]; do
  case "$1" in
    -t) target="$2"; shift 2;;
    -b) buffer="$2"; shift 2;;
    -p|-d|-r) shift;;
    -l) literal=1; shift;;
    --) shift; keys+=("$@"); break;;
    -) keys+=("-"); shift;;
    -*) echo "unknown flag: $1" >&2; exit 2;;
    *) keys+=("$1"); shift;;
  esac
done

require_session() {
  [ "$target" = sre-agent ] || { echo "can't find session: $target" >&2; exit 1; }
}

case "$command" in
  load-buffer)
    if [ -z "$buffer" ] || [ "${keys[0]}" != - ]; then
      echo "stub: load-buffer expects -b NAME -" >&2; exit 2
    fi
    [ -n "$STUB_FAIL_LOAD" ] && { echo "load-buffer failed" >&2; exit 1; }
    cat > "$STUB_DIR/buffer-$buffer";;
  paste-buffer)
    require_session
    [ -f "$STUB_DIR/buffer-$buffer" ] || { echo "no buffer $buffer" >&2; exit 1; }
    [ -n "$STUB_FAIL_PASTE" ] && { echo "paste-buffer failed" >&2; exit 1; }
    printf 'paste:%s\n' "$buffer" >> "$STUB_LOG"
    mv "$STUB_DIR/buffer-$buffer" "$STUB_DIR/typed"
    [ -n "$STUB_NO_LAND" ] || : > "$STUB_DIR/landed";;
  delete-buffer)
    printf 'delete:%s\n' "$buffer" >> "$STUB_LOG"
    rm -f "$STUB_DIR/buffer-$buffer";;
  send-keys)
    require_session
    # tmux sends the whole command in one message of at most 16KB
    [ "${#keys[0]}" -gt 16000 ] && { echo "command too long" >&2; exit 1; }
    [ -n "$STUB_FAIL_SEND" ] && { echo "send-keys failed" >&2; exit 1; }
    if [ -n "$literal" ]; then
      printf 'type:%s\n' "${keys[0]}" >> "$STUB_LOG"
    else
      printf 'key:%s\n' "${keys[0]}" >> "$STUB_LOG"
      [ "${keys[0]}" = Enter ] && echo $(( $(cat "$STUB_DIR/enters") + 1 )) > "$STUB_DIR/enters"
    fi;;
  capture-pane)
    require_session
    [ -n "$STUB_FAIL_CAPTURE" ] && { echo "capture-pane failed" >&2; exit 1; }
    echo "  Listening for channel messages from: server:signoz-webhook"
    if [ -n "$STUB_NO_UI" ]; then echo "something else entirely"; exit 0; fi
    echo "────────────────────────────────"
    if [ -f "$STUB_DIR/landed" ] && [ "$(cat "$STUB_DIR/enters")" -lt "$STUB_ENTERS_NEEDED" ]; then
      if [ -n "$STUB_SHOW_OTHER" ]; then
        printf '❯ someone else was typing here\n'
      elif [ -n "$STUB_SHOW_LITERAL" ]; then
        printf '❯ %s\n' "$(head -n 1 "$STUB_DIR/typed")"
      else
        printf '❯ [Pasted text #1 +48 lines]Lab API for recent MRs:\n  - web-app=70690979\n'
      fi
    else
      printf '❯ \n'
    fi
    echo "────────────────────────────────"
    echo "  ⏵⏵ bypass permissions on (shift+tab to cycle)";;
  *) exit 1;;
esac
