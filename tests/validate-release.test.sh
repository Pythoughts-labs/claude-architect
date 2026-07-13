#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASH_BIN=$(command -v bash)
NODE_BIN=$(command -v node)

assert_missing_dependency() {
  local dependency=$1
  local bin="$TMP/missing-$dependency/bin"
  local check_marker="$TMP/missing-$dependency/check-ran"
  local output="$TMP/missing-$dependency/output"
  local status

  mkdir -p "$bin"
  if [[ "$dependency" == claude ]]; then
    ln -s "$NODE_BIN" "$bin/node"
  else
    cat > "$bin/claude" <<EOF
#!$BASH_BIN
printf 'ran\n' > "$check_marker"
exit 0
EOF
    chmod +x "$bin/claude"
  fi

  set +e
  PATH="$bin" "$BASH_BIN" "$ROOT/scripts/validate-release.sh" > "$output" 2>&1
  status=$?
  set -e

  if [[ "$status" -ne 127 ]]; then
    printf 'FAIL: missing %s exited %s instead of 127\n' "$dependency" "$status" >&2
    exit 1
  fi
  grep -Fq "missing required command '$dependency'" "$output"
  grep -Fq 'release validation aborted before running any checks' "$output"
  if [[ -e "$check_marker" ]]; then
    printf 'FAIL: release checks ran after detecting missing %s\n' "$dependency" >&2
    exit 1
  fi

  printf 'PASS: missing %s fails release preflight with an actionable diagnostic.\n' "$dependency"
}

assert_missing_dependency claude
assert_missing_dependency node
