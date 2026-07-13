#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

assert_contains() {
  local file=$1
  local pattern=$2

  if ! grep -Eq -- "$pattern" "$file"; then
    printf 'FAIL: %s does not contain %s\n' "$file" "$pattern" >&2
    exit 1
  fi
}

assert_contains "$ROOT/agents/codex-implementer.md" 'run-codex-isolated\.sh'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ignore-user-config'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ephemeral'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'claude-master:codex-implementer'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'codex:codex-rescue'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'app-server'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CODEX_TEST_ARGS"
sleep 30 &
printf '%s\n' "$!" > "$CODEX_TEST_WORKER_PID"
EOF
chmod +x "$TMP/codex"

CODEX_TEST_ARGS="$TMP/args"
CODEX_TEST_WORKER_PID="$TMP/worker-pid"
export CODEX_TEST_ARGS CODEX_TEST_WORKER_PID
PATH="$TMP:$PATH" CODEX_TIMEOUT_SECONDS=0 \
  bash "$ROOT/scripts/run-codex-isolated.sh" --model test-model -

grep -Fxq -- 'exec' "$CODEX_TEST_ARGS"
grep -Fxq -- '--ignore-user-config' "$CODEX_TEST_ARGS"
grep -Fxq -- '--ephemeral' "$CODEX_TEST_ARGS"
grep -Fxq -- '--model' "$CODEX_TEST_ARGS"
grep -Fxq -- 'test-model' "$CODEX_TEST_ARGS"

WORKER_PID=$(<"$CODEX_TEST_WORKER_PID")
if kill -0 "$WORKER_PID" 2>/dev/null; then
  printf 'FAIL: delegated worker %s survived Codex completion\n' "$WORKER_PID" >&2
  exit 1
fi

printf 'PASS: Codex delegation is isolated from persistent user MCP workers.\n'
