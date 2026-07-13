#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s --project <project-root> | --global\n' "${0##*/}" >&2
  exit 64
}

if (( $# == 2 )) && [[ "$1" == --project ]] && [[ -n "$2" && "$2" != --* ]]; then
  BASE=$2/.opencode
elif (( $# == 1 )) && [[ "$1" == --global ]]; then
  BASE=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
else
  usage
fi

if [[ "$0" == */* ]]; then
  SCRIPT_DIR=${0%/*}
else
  SCRIPT_DIR=.
fi
ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

SOURCES=(
  "$ROOT/.opencode/agents/codex-implementer.md"
  "$ROOT/.opencode/agents/claude-advisor.md"
  "$ROOT/.opencode/agents/pi-implementer.md"
  "$ROOT/.opencode/agents/pythinker-implementer.md"
  "$ROOT/skills/delegate/SKILL.md"
  "$ROOT/scripts/run-isolated.sh"
  "$ROOT/scripts/run-codex-isolated.sh"
  "$ROOT/scripts/run-opencode-isolated.sh"
  "$ROOT/scripts/run-pi-isolated.sh"
  "$ROOT/scripts/run-pythinker-isolated.sh"
)
DESTINATIONS=(
  "$BASE/agents/codex-implementer.md"
  "$BASE/agents/claude-advisor.md"
  "$BASE/agents/pi-implementer.md"
  "$BASE/agents/pythinker-implementer.md"
  "$BASE/skills/delegate/SKILL.md"
  "$BASE/claude-master/scripts/run-isolated.sh"
  "$BASE/claude-master/scripts/run-codex-isolated.sh"
  "$BASE/claude-master/scripts/run-opencode-isolated.sh"
  "$BASE/claude-master/scripts/run-pi-isolated.sh"
  "$BASE/claude-master/scripts/run-pythinker-isolated.sh"
)

mkdir -p "$BASE/agents" "$BASE/skills/delegate" "$BASE/claude-master/scripts"

for index in "${!SOURCES[@]}"; do
  cp -p "${SOURCES[$index]}" "${DESTINATIONS[$index]}"
  printf '%s\n' "${DESTINATIONS[$index]}"
done
