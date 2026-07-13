#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

claude plugin validate --strict .
node tests/plugin-manifest.test.mjs
node tests/delegate-routing.test.mjs
bash tests/codex-lifecycle.test.sh
