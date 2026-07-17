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

assert_adjacent_args() {
  local file=$1
  local first=$2
  local second=$3
  local label=$4
  local arg
  local previous_arg=

  while IFS= read -r arg; do
    if [[ "$previous_arg" == "$first" && "$arg" == "$second" ]]; then
      return 0
    fi
    previous_arg=$arg
  done < "$file"

  printf 'FAIL: %s missing adjacent args: %s %s\n' "$label" "$first" "$second" >&2
  exit 1
}

assert_contains "$ROOT/agents/codex-implementer.md" 'run-codex-isolated\.sh'
assert_contains "$ROOT/agents/codex-implementer.md" '--disable multi_agent'
assert_contains "$ROOT/agents/codex-implementer.md" 'max_concurrent_threads_per_session=1'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ignore-user-config'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--ephemeral'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--disable multi_agent'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" 'max_concurrent_threads_per_session=1'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'claude-architect:codex-implementer'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'codex:codex-rescue'
assert_contains "$ROOT/skills/delegate/SKILL.md" 'app-server'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASH_BIN=$(command -v bash)
CAT_BIN=$(command -v cat)
PERL_BIN=$(command -v perl)
SLEEP_BIN=$(command -v sleep)
TIMEOUT_BIN=$(command -v gtimeout || command -v timeout || true)

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
  local CODEX_TIMEOUT_SECONDS
  local worker_pid

  mkdir -p "$bin" "$state"
  write_codex_stub "$bin"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"

  if [[ "$mode" == setsid ]]; then
    write_setsid_stub "$bin"
  fi

  printf 'objective: preserve stdin\nconstraint: keep process isolation\n' > "$expected_stdin"

  if [[ "$mode" == perl ]]; then
    CODEX_TIMEOUT_SECONDS=0
    export CODEX_TIMEOUT_SECONDS
  fi

  PATH="$bin" \
    CODEX_TEST_ARGS="$state/args" \
    CODEX_TEST_STDIN="$actual_stdin" \
    CODEX_TEST_WORKER_PID="$state/worker-pid" \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model - \
    < "$expected_stdin"

  grep -Fxq -- 'exec' "$state/args"
  grep -Fxq -- '--ignore-user-config' "$state/args"
  grep -Fxq -- '--ephemeral' "$state/args"
  assert_adjacent_args "$state/args" --sandbox read-only "$mode default sandbox"
  assert_adjacent_args "$state/args" --cd "$(pwd -P)" "$mode physical cwd"
  assert_adjacent_args "$state/args" --disable multi_agent "$mode branch"
  assert_adjacent_args "$state/args" -c \
    'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}' \
    "$mode branch"

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

assert_invalid_timeouts_rejected() {
  local bin="$TMP/invalid-timeout/bin"
  local state="$TMP/invalid-timeout/state"
  local index=0
  local status
  local value

  mkdir -p "$bin" "$state"
  cat > "$bin/codex" <<EOF
#!$BASH_BIN
touch "$state/codex-started"
EOF
  chmod +x "$bin/codex"

  for value in invalid -1 1.5 '10 seconds'; do
    index=$((index + 1))
    set +e
    PATH="$bin" CODEX_TIMEOUT_SECONDS="$value" \
      "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model \
      > "$state/stdout-$index" 2> "$state/stderr-$index"
    status=$?
    set -e

    if [[ "$status" -ne 64 ]]; then
      printf 'FAIL: invalid timeout %q exited %s instead of 64\n' "$value" "$status" >&2
      exit 1
    fi
    grep -Fq 'CODEX_TIMEOUT_SECONDS must be 0 or a positive integer' "$state/stderr-$index"
  done

  if [[ -e "$state/codex-started" ]]; then
    printf 'FAIL: Codex started with an invalid timeout value\n' >&2
    exit 1
  fi

  printf 'PASS: invalid timeout values fail before Codex starts.\n'
}

assert_requested_timeout_requires_binary() {
  local bin="$TMP/missing-timeout/bin"
  local state="$TMP/missing-timeout/state"
  local status

  mkdir -p "$bin" "$state"
  cat > "$bin/codex" <<EOF
#!$BASH_BIN
touch "$state/codex-started"
EOF
  chmod +x "$bin/codex"

  set +e
  PATH="$bin" CODEX_TIMEOUT_SECONDS=900 \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model \
    > "$state/stdout" 2> "$state/stderr"
  status=$?
  set -e

  if [[ "$status" -ne 69 ]]; then
    printf 'FAIL: unavailable timeout enforcement exited %s instead of 69\n' "$status" >&2
    exit 1
  fi
  grep -Fq 'requires timeout or gtimeout' "$state/stderr"
  if [[ -e "$state/codex-started" ]]; then
    printf 'FAIL: Codex started without the requested timeout enforcement\n' >&2
    exit 1
  fi

  printf 'PASS: an explicit timeout fails closed when no timeout binary is available.\n'
}

assert_requested_timeout_is_enforced() {
  local bin="$TMP/enforced-timeout/bin"
  local state="$TMP/enforced-timeout/state"

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  cat > "$bin/timeout" <<EOF
#!$BASH_BIN
printf '%s\n' "\$1" > "$state/kill-after"
shift
printf '%s\n' "\$1" > "$state/duration"
shift
exec "\$@"
EOF
  cat > "$bin/codex" <<EOF
#!$BASH_BIN
printf 'started\n' > "$state/codex-started"
EOF
  chmod +x "$bin/timeout" "$bin/codex"

  PATH="$bin" CODEX_TIMEOUT_SECONDS=900 \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model \
    > "$state/stdout" 2> "$state/stderr"

  grep -Fxq -- '--kill-after=2s' "$state/kill-after"
  grep -Fxq '900' "$state/duration"
  grep -Fxq 'started' "$state/codex-started"

  printf 'PASS: an explicit positive timeout wraps the Codex process.\n'
}

assert_timeout_expiration_cleans_up_workers() {
  local bin="$TMP/expired-timeout/bin"
  local state="$TMP/expired-timeout/state"
  local status
  local worker_pid

  if [[ -z "$TIMEOUT_BIN" ]]; then
    printf 'SKIP: timeout expiration integration test requires timeout or gtimeout.\n'
    return
  fi

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"
  ln -s "$TIMEOUT_BIN" "$bin/timeout"
  cat > "$bin/codex" <<EOF
#!$BASH_BIN
"$SLEEP_BIN" 30 &
printf '%s\n' "\$!" > "$state/worker-pid"
wait
EOF
  chmod +x "$bin/codex"

  set +e
  PATH="$bin" CODEX_TIMEOUT_SECONDS=1 \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model \
    > "$state/stdout" 2> "$state/stderr"
  status=$?
  set -e

  if [[ "$status" -ne 124 ]]; then
    printf 'FAIL: expired timeout exited %s instead of 124\n' "$status" >&2
    exit 1
  fi
  worker_pid=$(<"$state/worker-pid")
  if kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    printf 'FAIL: timeout left delegated worker %s running\n' "$worker_pid" >&2
    exit 1
  fi

  printf 'PASS: timeout expiration returns 124 and cleans up delegated workers.\n'
}

assert_codex_stderr_capture() {
  local bin="$TMP/codex-stderr/bin"
  local state="$TMP/codex-stderr/state"
  local logdir="$state/logs"
  local status
  local i

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  cat > "$bin/codex" <<EOF
#!$BASH_BIN
printf '%s\n' "\$@" > "$state/args"
printf 'codex-diagnostic-line\n' >&2
exit 5
EOF
  chmod +x "$bin/codex"

  set +e
  PATH="$bin:$PATH" CODEX_TIMEOUT_SECONDS=0 \
    CODEX_LOG_DIR="$logdir" RUN_ISOLATED_LOG_DIR="$logdir" \
    "$BASH_BIN" "$ROOT/scripts/run-codex-isolated.sh" --model test-model \
    </dev/null >"$state/stdout" 2>"$state/stderr"
  status=$?
  set -e

  if [[ "$status" -ne 5 ]]; then
    printf 'FAIL: codex stderr capture altered exit status (%s != 5)\n' "$status" >&2
    exit 1
  fi

  assert_adjacent_args "$state/args" --sandbox read-only 'stderr logging default sandbox'
  assert_adjacent_args "$state/args" --cd "$(pwd -P)" 'stderr logging physical cwd'
  assert_adjacent_args "$state/args" --disable multi_agent 'stderr logging branch'
  assert_adjacent_args "$state/args" -c \
    'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}' \
    'stderr logging branch'

  # stderr must still stream to the caller, and also be persisted per-run.
  # The tee child is orphaned by exec, so poll briefly for its flush.
  for i in $(seq 1 30); do
    grep -Fq 'codex-diagnostic-line' "$state/stderr" 2>/dev/null \
      && grep -Fqr 'codex-diagnostic-line' "$logdir" 2>/dev/null \
      && break
    "$SLEEP_BIN" 0.1
  done

  if ! grep -Fq 'codex-diagnostic-line' "$state/stderr"; then
    printf 'FAIL: codex stderr was not streamed to the caller\n' >&2
    exit 1
  fi
  if ! grep -Fqr 'codex-diagnostic-line' "$logdir"/codex-*.stderr; then
    printf 'FAIL: codex stderr was not persisted to a per-run file\n' >&2
    exit 1
  fi

  printf 'PASS: codex stderr is persisted and still streamed to the caller.\n'
}

run_case setsid
run_case perl
assert_invalid_timeouts_rejected
assert_requested_timeout_requires_binary
assert_requested_timeout_is_enforced
assert_timeout_expiration_cleans_up_workers
assert_codex_stderr_capture
