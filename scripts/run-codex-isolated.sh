#!/usr/bin/env bash

set -euo pipefail

TIMEOUT_SECONDS=${CODEX_TIMEOUT_SECONDS:-0}

if [[ "$TIMEOUT_SECONDS" == 0 ]]; then
  :
elif [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  if ! command -v gtimeout >/dev/null 2>&1 && ! command -v timeout >/dev/null 2>&1; then
    printf 'ERROR: CODEX_TIMEOUT_SECONDS=%s requires timeout or gtimeout; install coreutils or set CODEX_TIMEOUT_SECONDS=0.\n' "$TIMEOUT_SECONDS" >&2
    exit 69
  fi
else
  printf 'ERROR: CODEX_TIMEOUT_SECONDS must be 0 or a positive integer; got %q\n' "$TIMEOUT_SECONDS" >&2
  exit 64
fi

if [[ "$0" == */* ]]; then
  SCRIPT_DIR=${0%/*}
else
  SCRIPT_DIR=.
fi

# Codex is the only lane whose stderr streams to the caller rather than into a
# result file (opencode/pi/pythinker redirect the delegate's stderr into their
# FINAL file via `2>&1`). A failed or aborted codex run — e.g. one that exits
# without writing --output-last-message — would otherwise leave no diagnostic.
# Persist stderr to a per-run file while still streaming it to the caller.
#
# Gated on the logging utilities being reachable, so the isolation tests'
# restricted PATH fall through to the unchanged exec fast-path. Honour an
# explicit CODEX_LOG_DIR; otherwise default to the shared run-log directory.
ERR_DIR=${CODEX_LOG_DIR:-}
if [[ -z "$ERR_DIR" ]] \
  && command -v date >/dev/null 2>&1 \
  && command -v mkdir >/dev/null 2>&1 \
  && command -v tee >/dev/null 2>&1; then
  ERR_DIR="${TMPDIR:-/tmp}/claude-architect-runs"
fi

# GPT-5.6 Sol can force MultiAgent V2 even when `multi_agent` is disabled.
# V2 counts the root in this limit, so one slot leaves no capacity for children.
# Keep these overrides after caller arguments so callers cannot raise the limit.
if [[ -n "$ERR_DIR" ]] && mkdir -p "$ERR_DIR" 2>/dev/null; then
  chmod 700 "$ERR_DIR" 2>/dev/null || true
  ERR_FILE="$ERR_DIR/codex-$(date +%Y%m%d-%H%M%S)-$$.stderr"
  RUN_TIMEOUT_SECONDS=$TIMEOUT_SECONDS \
    exec "$BASH" "$SCRIPT_DIR/run-isolated.sh" \
      codex exec --ignore-user-config --ephemeral "$@" \
      --disable multi_agent \
      -c 'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}' \
      2> >(tee -a "$ERR_FILE" >&2)
fi

RUN_TIMEOUT_SECONDS=$TIMEOUT_SECONDS \
  exec "$BASH" "$SCRIPT_DIR/run-isolated.sh" \
    codex exec --ignore-user-config --ephemeral "$@" \
    --disable multi_agent \
    -c 'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}'
