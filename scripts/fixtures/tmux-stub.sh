#!/usr/bin/env bash
# Stub tmux for submit-prompt.test.ts. Parses its flags like tmux, logs send-keys calls to
# $STUB_LOG, and renders a Claude Code input box that holds the typed prompt until
# $STUB_ENTERS_NEEDED Enters arrive. STUB_FAIL_SEND, STUB_FAIL_CAPTURE, STUB_NO_UI and
# STUB_NO_LAND make it fail the way a real session can.
command="$1"; shift
target=""; literal=""; keys=()
while [ $# -gt 0 ]; do
  case "$1" in
    -t) target="$2"; shift 2;;
    -p) shift;;
    -l) literal=1; shift;;
    --) shift; keys+=("$@"); break;;
    *) keys+=("$1"); shift;;
  esac
done
[ "$target" = sre-agent ] || { echo "can't find session: $target" >&2; exit 1; }
case "$command" in
  send-keys)
    [ -n "$STUB_FAIL_SEND" ] && { echo "send-keys failed" >&2; exit 1; }
    if [ -n "$literal" ]; then
      printf 'type:%s\n' "${keys[0]}" >> "$STUB_LOG"
      [ -n "$STUB_NO_LAND" ] || : > "$STUB_DIR/landed"
    else
      printf 'key:%s\n' "${keys[0]}" >> "$STUB_LOG"
      [ "${keys[0]}" = Enter ] && echo $(( $(cat "$STUB_DIR/enters") + 1 )) > "$STUB_DIR/enters"
    fi;;
  capture-pane)
    [ -n "$STUB_FAIL_CAPTURE" ] && { echo "capture-pane failed" >&2; exit 1; }
    echo "  Listening for channel messages from: server:signoz-webhook"
    if [ -n "$STUB_NO_UI" ]; then echo "something else entirely"; exit 0; fi
    echo "────────────────────────────────"
    if [ -f "$STUB_DIR/landed" ] && [ "$(cat "$STUB_DIR/enters")" -lt "$STUB_ENTERS_NEEDED" ]; then
      printf '❯ [Pasted text #1 +48 lines]Lab API for recent MRs:\n  - web-app=70690979\n'
    else
      printf '❯ \n'
    fi
    echo "────────────────────────────────"
    echo "  ⏵⏵ bypass permissions on (shift+tab to cycle)";;
  *) exit 1;;
esac
