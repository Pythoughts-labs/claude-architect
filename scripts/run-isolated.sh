#!/usr/bin/env bash

set -euo pipefail

if (( $# == 0 )); then
  printf 'command required\n' >&2
  exit 64
fi

# Delegated program identity for the run record. Only the basename and argument
# count are retained — never argv values, which for some lanes (e.g. pythinker's
# --prompt, or codex specs) contain the full prompt and must not reach a log.
DELEGATE_PROG=${1##*/}
DELEGATE_ARGC=$#

# Durable run logging is enabled when RUN_ISOLATED_LOG_DIR is set, or by default
# whenever the logging utilities are reachable. Under the restricted PATH used by
# the isolation tests these lookups fail, so logging is skipped and behaviour is
# unchanged.
RUN_LOG_DIR=${RUN_ISOLATED_LOG_DIR:-}
if [[ -z "$RUN_LOG_DIR" ]] \
  && command -v date >/dev/null 2>&1 \
  && command -v mkdir >/dev/null 2>&1; then
  RUN_LOG_DIR="${TMPDIR:-/tmp}/claude-architect-runs"
fi

TIMEOUT_SECONDS=${RUN_TIMEOUT_SECONDS:-0}
TIMEOUT_PREFIX=()

if [[ "$TIMEOUT_SECONDS" == 0 ]]; then
  :
elif [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  TIMEOUT_BIN=$(command -v gtimeout || command -v timeout || true)
  if [[ -n "$TIMEOUT_BIN" ]]; then
    TIMEOUT_PREFIX=("$TIMEOUT_BIN" --kill-after=2s "$TIMEOUT_SECONDS")
  else
    printf 'RUN_TIMEOUT_SECONDS=%s requires timeout or gtimeout\n' "$TIMEOUT_SECONDS" >&2
    exit 69
  fi
else
  printf 'RUN_TIMEOUT_SECONDS must be 0 or a positive integer\n' >&2
  exit 64
fi

if (( ${#TIMEOUT_PREFIX[@]} )); then
  COMMAND=("${TIMEOUT_PREFIX[@]}" "$@")
else
  COMMAND=("$@")
fi

terminate_process_group() {
  local pid=$1

  if kill -0 "-$pid" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || true
    sleep 0.1
    kill -KILL "-$pid" 2>/dev/null || true
  fi
}

# Append one atomic, single-line run record to the shared log. Best-effort: any
# failure here is swallowed so it can never alter the delegated exit status, and
# it writes only to the log file (the non-codex lanes point fd2 at their result
# file, so stderr diagnostics would corrupt it). Kept short so the lone append
# stays atomic under concurrent lane fan-out.
record_run() {
  [[ -n "$RUN_LOG_DIR" ]] || return 0

  local end dur result
  end=$(date +%s 2>/dev/null) || return 0
  dur=$(( end - ${START_EPOCH:-end} ))
  case "$STATUS" in
    0) result=ok ;;
    124) result=timeout ;;
    *) if (( STATUS > 128 )); then result=signal; else result=failed; fi ;;
  esac

  mkdir -p "$RUN_LOG_DIR" 2>/dev/null || return 0
  chmod 700 "$RUN_LOG_DIR" 2>/dev/null || true
  printf '%s isolated pid=%s prog=%s argc=%s dur=%ss status=%s result=%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" "$$" \
    "$DELEGATE_PROG" "$DELEGATE_ARGC" "$dur" "$STATUS" "$result" \
    >> "$RUN_LOG_DIR/runs.log" 2>/dev/null || true
  return 0
}

if [[ -n "$RUN_LOG_DIR" ]]; then
  START_EPOCH=$(date +%s 2>/dev/null) || START_EPOCH=
fi

if command -v setsid >/dev/null 2>&1; then
  setsid "${COMMAND[@]}" <&0 &
else
  perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' "${COMMAND[@]}" <&0 &
fi
DELEGATED_PID=$!
trap 'terminate_process_group "$DELEGATED_PID"' EXIT INT TERM HUP

set +e
wait "$DELEGATED_PID"
STATUS=$?
set -e

terminate_process_group "$DELEGATED_PID"
trap - EXIT INT TERM HUP
if [[ "$STATUS" -eq 137 ]]; then
  STATUS=124
fi
record_run || true
exit "$STATUS"
