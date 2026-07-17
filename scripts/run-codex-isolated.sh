#!/usr/bin/env bash

set -euo pipefail

config_key_is_unsafe() {
  local key=${1%%=*}

  while [[ "$key" == [[:space:]\"\']* ]]; do key=${key:1}; done
  while [[ "$key" == *[[:space:]\"\'] ]]; do key=${key:0:${#key}-1}; done

  case "$key" in
    sandbox*|features*|approval*|ask_for_approval*) return 0 ;;
    *) return 1 ;;
  esac
}

reject_unsafe_args() {
  local arg value
  local -a argv=("$@")
  local i

  for ((i = 0; i < ${#argv[@]}; i++)); do
    arg=${argv[$i]}
    case "$arg" in
      --sandbox|--sandbox=*|-s|-s=*|-s?*| \
      --add-dir|--add-dir=*|--disable-sandbox|--disable-sandbox=*| \
      --cd|--cd=*|-C|-C=*|-C?*| \
      --ask-for-approval|--ask-for-approval=*|-a|-a=*|-a?*| \
      --dangerously*|--full-auto|--full-auto=*|--yolo|--yolo=*| \
      --enable|--enable=*)
        printf 'ERROR: unsafe Codex option rejected: %s\n' "${arg%%=*}" >&2
        return 65
        ;;
      -c|--config)
        if ((i + 1 < ${#argv[@]})) && config_key_is_unsafe "${argv[$((i + 1))]}"; then
          printf 'ERROR: unsafe Codex config key rejected\n' >&2
          return 65
        fi
        i=$((i + 1))
        ;;
      -c=*|-c?*)
        value=${arg#-c}
        value=${value#=}
        if config_key_is_unsafe "$value"; then
          printf 'ERROR: unsafe Codex config key rejected\n' >&2
          return 65
        fi
        ;;
      --config=*)
        value=${arg#--config=}
        if config_key_is_unsafe "$value"; then
          printf 'ERROR: unsafe Codex config key rejected\n' >&2
          return 65
        fi
        ;;
    esac
  done
}

reject_unsafe_args "$@" || exit $?

TIMEOUT_SECONDS=${CODEX_TIMEOUT_SECONDS:-600}
TIMEOUT_IS_DEFAULT=$([[ -z "${CODEX_TIMEOUT_SECONDS:-}" ]] && echo 1 || echo 0)

if [[ "$TIMEOUT_SECONDS" == 0 ]]; then
  :
elif [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  if ! command -v gtimeout >/dev/null 2>&1 && ! command -v timeout >/dev/null 2>&1; then
    if [[ "$TIMEOUT_IS_DEFAULT" == 1 ]]; then
      # The 600s cap is only a default; without coreutils, degrade to uncapped
      # (the caller's Bash-tool timeout remains the enforced outer bound).
      printf 'WARNING: no timeout/gtimeout found; running without the default 600s internal cap.\n' >&2
      TIMEOUT_SECONDS=0
    else
      printf 'ERROR: CODEX_TIMEOUT_SECONDS=%s requires timeout or gtimeout; install coreutils or set CODEX_TIMEOUT_SECONDS=0.\n' "$TIMEOUT_SECONDS" >&2
      exit 69
    fi
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
