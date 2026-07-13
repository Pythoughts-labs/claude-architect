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

BASH_BIN=$(command -v bash)
CAT_BIN=$(command -v cat)
PERL_BIN=$(command -v perl)
SLEEP_BIN=$(command -v sleep)

write_codex_stub() {
  local bin=$1

  cat > "$bin/codex" <<EOF
#!$BASH_BIN
printf '%s\n' "\$@" > "\$CODEX_TEST_ARGS"
"$CAT_BIN" > "\$CODEX_TEST_STDIN"
"$SLEEP_BIN" 30 &
printf '%s\n' "\$!" > "\$CODEX_TEST_WORKER_PID"
EOF
  chmod +x "$bin/codex"
}

write_setsid_stub() {
  local bin=$1

  cat > "$bin/setsid" <<EOF
#!$BASH_BIN
exec "$PERL_BIN" -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: \$!"; exec @ARGV or die "exec: \$!"' "\$@"
EOF
  chmod +x "$bin/setsid"
}

run_case() {
  local mode=$1
  local bin="$TMP/$mode/bin"
  local state="$TMP/$mode/state"
  local expected_stdin="$state/expected-stdin"
  local actual_stdin="$state/actual-stdin"
  local worker_pid

  mkdir -p "$bin" "$state"
  write_codex_stub "$bin"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"

  if [[ "$mode" == setsid ]]; then
    write_setsid_stub "$bin"
  fi

  printf 'objective: preserve stdin\nconstraint: keep process isolation\n' > "$expected_stdin"

  PATH="$bin" \
    CODEX_TIMEOUT_SECONDS=0 \
    CODEX_TEST_ARGS="$state/args" \
    CODEX_TEST_STDIN="$actual_stdin" \
    CODEX_TEST_WORKER_PID="$state/worker-pid" \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model - \
    < "$expected_stdin"

  grep -Fxq -- 'exec' "$state/args"
  grep -Fxq -- '--ignore-user-config' "$state/args"
  grep -Fxq -- '--ephemeral' "$state/args"
  grep -Fxq -- '--model' "$state/args"
  grep -Fxq -- 'test-model' "$state/args"

  if ! cmp -s "$expected_stdin" "$actual_stdin"; then
    printf 'FAIL: %s branch did not preserve runner stdin\n' "$mode" >&2
    diff -u "$expected_stdin" "$actual_stdin" >&2 || true
    exit 1
  fi

  worker_pid=$(<"$state/worker-pid")
  if kill -0 "$worker_pid" 2>/dev/null; then
    printf 'FAIL: %s branch left delegated worker %s running\n' "$mode" "$worker_pid" >&2
    exit 1
  fi

  printf 'PASS: %s branch preserves stdin and cleans up workers.\n' "$mode"
}

run_case setsid
run_case perl
