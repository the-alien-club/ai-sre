#!/usr/bin/env bash
# Stub curl for the Slack notice tests. Records its arguments to $CURL_DIR/args (one per
# line), the request body (stdin) to $CURL_DIR/body and the headers read from any
# `--header @file` to $CURL_DIR/headers, then prints $CURL_RESPONSE and exits $CURL_EXIT.
printf '%s\n' "$@" > "$CURL_DIR/args"
: > "$CURL_DIR/headers"
previous=""
for arg in "$@"; do
  if [ "$previous" = --header ] && [ "${arg#@}" != "$arg" ]; then
    cat "${arg#@}" >> "$CURL_DIR/headers"
  fi
  previous="$arg"
done
cat > "$CURL_DIR/body"
printf '%s' "$CURL_RESPONSE"
exit "$CURL_EXIT"
