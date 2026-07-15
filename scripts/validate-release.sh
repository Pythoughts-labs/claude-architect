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

for artifact in runtime/bootstrap.mjs runtime/server.mjs; do
  if [[ ! -f "$artifact" ]]; then
    printf 'ERROR: missing required runtime artifact %s.\n' "$artifact" >&2
    exit 1
  fi
done

if [[ ! -s native/bin/win32-job-kill-x64.exe ]]; then
  printf 'ERROR: missing or empty native helper native/bin/win32-job-kill-x64.exe.\n' >&2
  exit 1
fi

PLUGIN_VERSION=$(node -p 'JSON.parse(require("node:fs").readFileSync(".claude-plugin/plugin.json", "utf8")).version')
MARKETPLACE_VERSION=$(node -p 'JSON.parse(require("node:fs").readFileSync(".claude-plugin/marketplace.json", "utf8")).plugins[0].version')
README_VERSION=$(sed -nE 's/.*badge\/version-([0-9]+\.[0-9]+\.[0-9]+)-.*/\1/p' README.md | head -n 1)
CHANGELOG_VERSION=$(sed -nE 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/p' CHANGELOG.md | head -n 1)
RUNTIME_VERSION=$(sed -nE 's/^export const RUNTIME_VERSION = "([^"]+)".*/\1/p' src/protocol/versions.ts)

for version_pin in \
  "marketplace.json:$MARKETPLACE_VERSION" \
  "README.md badge:$README_VERSION" \
  "CHANGELOG.md first released heading:$CHANGELOG_VERSION" \
  "src/protocol/versions.ts RUNTIME_VERSION:$RUNTIME_VERSION"; do
  version_name=${version_pin%%:*}
  version_value=${version_pin#*:}
  if [[ "$version_value" != "$PLUGIN_VERSION" ]]; then
    printf 'ERROR: %s version (%s) does not match plugin.json version (%s).\n' \
      "$version_name" "${version_value:-missing}" "$PLUGIN_VERSION" >&2
    exit 1
  fi
done

node -e 'JSON.parse(require("node:fs").readFileSync(".mcp.json", "utf8"))'

RUNTIME_PROTOCOL=$(sed -nE 's/^export const PROTOCOL_VERSION = "([^"]+)".*/\1/p' src/protocol/versions.ts)
SKILL_PROTOCOL=$(sed -nE 's/^PROTOCOL_VERSION:[[:space:]]*([^[:space:]]+).*/\1/p' skills/delegate/SKILL.md)
if [[ -z "$RUNTIME_PROTOCOL" || "$SKILL_PROTOCOL" != "$RUNTIME_PROTOCOL" ]]; then
  printf 'ERROR: delegate skill PROTOCOL_VERSION (%s) does not match runtime (%s).\n' \
    "${SKILL_PROTOCOL:-missing}" "${RUNTIME_PROTOCOL:-missing}" >&2
  exit 1
fi

BUNDLE_SNAPSHOT=$(mktemp)
trap 'rm -f "$BUNDLE_SNAPSHOT"' EXIT
cp runtime/server.mjs "$BUNDLE_SNAPSHOT"
"$BASH" scripts/build-runtime.sh >/dev/null
if ! cmp -s "$BUNDLE_SNAPSHOT" runtime/server.mjs; then
  printf 'ERROR: runtime/server.mjs was stale; run scripts/build-runtime.sh and commit it.\n' >&2
  exit 1
fi
if ! git diff --exit-code -- runtime/server.mjs runtime/bootstrap.mjs; then
  printf 'ERROR: runtime artifacts differ from the committed release state.\n' >&2
  exit 1
fi

claude plugin validate --strict .
node tests/plugin-manifest.test.mjs
npx vitest run tests/runtime/plugin-wiring.test.mjs
node tests/delegate-routing.test.mjs
"$BASH" tests/codex-lifecycle.test.sh
"$BASH" tests/validate-release.test.sh
"$BASH" tests/run-isolated.test.sh
"$BASH" tests/lane-launchers.test.sh
"$BASH" tests/install-opencode.test.sh
"$BASH" tests/claude-runtime-resolver.test.sh
node tests/lane-contract.test.mjs
node tests/lane-model-fallback.test.mjs
node tests/lane-roster.test.mjs
