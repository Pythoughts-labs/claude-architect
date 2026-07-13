#!/usr/bin/env bash

set -euo pipefail

PREFLIGHT_FAILED=0

if ! command -v claude >/dev/null 2>&1; then
  printf "ERROR: missing required command 'claude'; install Claude Code and ensure its CLI is on PATH.\n" >&2
  PREFLIGHT_FAILED=1
fi

if ! command -v node >/dev/null 2>&1; then
  printf "ERROR: missing required command 'node'; install Node.js and ensure its CLI is on PATH.\n" >&2
  PREFLIGHT_FAILED=1
fi

if (( PREFLIGHT_FAILED )); then
  printf 'ERROR: release validation aborted before running any checks.\n' >&2
  exit 127
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

claude plugin validate --strict .
node tests/plugin-manifest.test.mjs
node tests/delegate-routing.test.mjs
"$BASH" tests/codex-lifecycle.test.sh
"$BASH" tests/validate-release.test.sh
