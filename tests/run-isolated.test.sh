#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASH_BIN=$(command -v bash)
CAT_BIN=$(command -v cat)
PERL_BIN=$(command -v perl)
SLEEP_BIN=$(command -v sleep)
SYSTEM_TIMEOUT_BIN=$(command -v gtimeout || command -v timeout || true)

write_command_stub() {
  local bin=$1

  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
printf '%s\0' "\$@" > "\$ISOLATED_TEST_ARGS"
"$CAT_BIN" > "\$ISOLATED_TEST_STDIN"
"$SLEEP_BIN" 30 &
printf '%s\n' "\$!" > "\$ISOLATED_TEST_WORKER_PID"
exit "\${ISOLATED_TEST_STATUS:-0}"
EOF
  chmod +x "$bin/delegated-command"
}

write_setsid_stub() {
  local bin=$1

  cat > "$bin/setsid" <<EOF
#!$BASH_BIN
printf 'called\n' > "\$ISOLATED_TEST_SETSID_CALLED"
exec "$PERL_BIN" -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: \$!"; exec @ARGV or die "exec: \$!"' "\$@"
EOF
  chmod +x "$bin/setsid"
}

assert_runner_branch() {
  local mode=$1
  local bin="$TMP/$mode/bin"
  local state="$TMP/$mode/state"
  local status
  local worker_pid

  mkdir -p "$bin" "$state"
  write_command_stub "$bin"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"
  if [[ "$mode" == setsid ]]; then
    write_setsid_stub "$bin"
  fi

  printf 'first\0--model\0literal value\0-\0' > "$state/expected-args"
  printf 'first line\nsecond line without final newline' > "$state/expected-stdin"

  set +e
  PATH="$bin" \
    RUN_TIMEOUT_SECONDS=0 \
    ISOLATED_TEST_ARGS="$state/actual-args" \
    ISOLATED_TEST_STDIN="$state/actual-stdin" \
    ISOLATED_TEST_WORKER_PID="$state/worker-pid" \
    ISOLATED_TEST_STATUS=23 \
    ISOLATED_TEST_SETSID_CALLED="$state/setsid-called" \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" \
      delegated-command first --model 'literal value' - \
      < "$state/expected-stdin"
  status=$?
  set -e

  if [[ "$status" -ne 23 ]]; then
    printf 'FAIL: %s branch exited %s instead of delegated status 23\n' "$mode" "$status" >&2
    exit 1
  fi
  cmp "$state/expected-args" "$state/actual-args"
  cmp "$state/expected-stdin" "$state/actual-stdin"

  if [[ "$mode" == setsid && ! -e "$state/setsid-called" ]]; then
    printf 'FAIL: external setsid branch did not invoke setsid\n' >&2
    exit 1
  fi
  if [[ "$mode" == perl && -e "$state/setsid-called" ]]; then
    printf 'FAIL: Perl fallback unexpectedly invoked external setsid\n' >&2
    exit 1
  fi

  worker_pid=$(<"$state/worker-pid")
  if kill -0 "$worker_pid" 2>/dev/null; then
    printf 'FAIL: %s branch left delegated worker %s running\n' "$mode" "$worker_pid" >&2
    exit 1
  fi

  printf 'PASS: %s branch preserves argv/stdin/status and cleans descendants.\n' "$mode"
}

assert_pre_start_validation() {
  local bin="$TMP/validation/bin"
  local state="$TMP/validation/state"
  local status
  local value

  mkdir -p "$bin" "$state"
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
touch "$state/command-started"
EOF
  chmod +x "$bin/delegated-command"

  set +e
  PATH="$bin" RUN_TIMEOUT_SECONDS=0 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" \
    > "$state/missing-stdout" 2> "$state/missing-stderr"
  status=$?
  set -e
  if [[ "$status" -ne 64 ]]; then
    printf 'FAIL: missing command exited %s instead of 64\n' "$status" >&2
    exit 1
  fi

  for value in invalid -1 1.5 '10 seconds'; do
    set +e
    PATH="$bin" RUN_TIMEOUT_SECONDS="$value" \
      "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command \
      > "$state/invalid-stdout" 2> "$state/invalid-stderr"
    status=$?
    set -e
    if [[ "$status" -ne 64 ]]; then
      printf 'FAIL: malformed timeout %q exited %s instead of 64\n' "$value" "$status" >&2
      exit 1
    fi
    if [[ "$(<"$state/invalid-stderr")" != 'RUN_TIMEOUT_SECONDS must be 0 or a positive integer' ]]; then
      printf 'FAIL: malformed timeout diagnostic was not exact\n' >&2
      exit 1
    fi
  done

  set +e
  PATH="$bin" RUN_TIMEOUT_SECONDS=9 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command \
    > "$state/no-timeout-stdout" 2> "$state/no-timeout-stderr"
  status=$?
  set -e
  if [[ "$status" -ne 69 ]]; then
    printf 'FAIL: unenforceable timeout exited %s instead of 69\n' "$status" >&2
    exit 1
  fi
  if [[ -e "$state/command-started" ]]; then
    printf 'FAIL: delegated command started before validation completed\n' >&2
    exit 1
  fi

  printf 'PASS: validation failures occur before delegated startup.\n'
}

assert_timeout_wrapper_forwards_command() {
  local bin="$TMP/timeout-wrapper/bin"
  local state="$TMP/timeout-wrapper/state"

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  cat > "$bin/timeout" <<EOF
#!$BASH_BIN
printf '%s\n' "\$1" > "$state/duration"
shift
printf '%s\0' "\$@" > "$state/wrapped-argv"
exec "\$@"
EOF
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
exit 0
EOF
  chmod +x "$bin/timeout" "$bin/delegated-command"

  PATH="$bin" RUN_TIMEOUT_SECONDS=17 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" \
      delegated-command alpha 'two words'

  printf 'delegated-command\0alpha\0two words\0' > "$state/expected-argv"
  grep -Fxq '17' "$state/duration"
  cmp "$state/expected-argv" "$state/wrapped-argv"

  printf 'PASS: timeout duration and command argv are forwarded exactly.\n'
}

assert_real_timeout_cleans_descendants() {
  local bin="$TMP/real-timeout/bin"
  local state="$TMP/real-timeout/state"
  local status
  local worker_pid

  if [[ -z "$SYSTEM_TIMEOUT_BIN" ]]; then
    printf 'SKIP: real timeout integration requires timeout or gtimeout.\n'
    return
  fi

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  ln -s "$SLEEP_BIN" "$bin/sleep"
  ln -s "$SYSTEM_TIMEOUT_BIN" "$bin/timeout"
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
"$SLEEP_BIN" 30 &
printf '%s\n' "\$!" > "$state/worker-pid"
wait
EOF
  chmod +x "$bin/delegated-command"

  set +e
  PATH="$bin" RUN_TIMEOUT_SECONDS=1 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command \
    > "$state/stdout" 2> "$state/stderr"
  status=$?
  set -e
  if [[ "$status" -ne 124 ]]; then
    printf 'FAIL: real timeout exited %s instead of 124\n' "$status" >&2
    exit 1
  fi

  worker_pid=$(<"$state/worker-pid")
  if kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    printf 'FAIL: real timeout left delegated worker %s running\n' "$worker_pid" >&2
    exit 1
  fi

  printf 'PASS: real timeout returns 124 and cleans descendants.\n'
}

assert_run_logging() {
  local bin="$TMP/run-logging/bin"
  local state="$TMP/run-logging/state"
  local logdir="$state/logs"
  local status
  local lines

  mkdir -p "$bin" "$state"
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
printf 'to stderr\n' >&2
exit "\${DC_STATUS:-0}"
EOF
  chmod +x "$bin/delegated-command"

  # Success: one atomic line, result=ok, exit preserved, argv values not leaked.
  PATH="$bin:$PATH" RUN_TIMEOUT_SECONDS=0 RUN_ISOLATED_LOG_DIR="$logdir" \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" \
      delegated-command --model m1 'super-secret-prompt-value' \
    </dev/null >/dev/null 2>&1

  if [[ ! -s "$logdir/runs.log" ]]; then
    printf 'FAIL: run log was not written\n' >&2
    exit 1
  fi
  lines=$(wc -l < "$logdir/runs.log")
  if [[ "$lines" -ne 1 ]]; then
    printf 'FAIL: expected exactly one run-log line, got %s\n' "$lines" >&2
    exit 1
  fi
  if ! grep -Eq 'prog=delegated-command argc=4 dur=[0-9]+s status=0 result=ok' "$logdir/runs.log"; then
    printf 'FAIL: success record malformed: %s\n' "$(cat "$logdir/runs.log")" >&2
    exit 1
  fi
  if grep -Fq 'super-secret-prompt-value' "$logdir/runs.log"; then
    printf 'FAIL: run log leaked an argv value\n' >&2
    exit 1
  fi

  # Failure: exit code preserved, result=failed, appended as a second line.
  set +e
  PATH="$bin:$PATH" RUN_TIMEOUT_SECONDS=0 RUN_ISOLATED_LOG_DIR="$logdir" DC_STATUS=23 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command \
    </dev/null >/dev/null 2>&1
  status=$?
  set -e
  if [[ "$status" -ne 23 ]]; then
    printf 'FAIL: logging altered exit code (%s != 23)\n' "$status" >&2
    exit 1
  fi
  lines=$(wc -l < "$logdir/runs.log")
  if [[ "$lines" -ne 2 ]]; then
    printf 'FAIL: expected two run-log lines after second run, got %s\n' "$lines" >&2
    exit 1
  fi
  if ! grep -Eq 'status=23 result=failed' "$logdir/runs.log"; then
    printf 'FAIL: failure record missing\n' >&2
    exit 1
  fi

  # Deterministic result-category mapping for timeout (124) and signal (>128).
  set +e
  PATH="$bin:$PATH" RUN_TIMEOUT_SECONDS=0 RUN_ISOLATED_LOG_DIR="$logdir" DC_STATUS=124 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command </dev/null >/dev/null 2>&1
  PATH="$bin:$PATH" RUN_TIMEOUT_SECONDS=0 RUN_ISOLATED_LOG_DIR="$logdir" DC_STATUS=137 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command </dev/null >/dev/null 2>&1
  set -e
  if ! grep -Eq 'status=124 result=timeout' "$logdir/runs.log"; then
    printf 'FAIL: timeout category mapping missing\n' >&2
    exit 1
  fi
  if ! grep -Eq 'status=137 result=signal' "$logdir/runs.log"; then
    printf 'FAIL: signal category mapping missing\n' >&2
    exit 1
  fi

  printf 'PASS: run logging records status/result atomically without leaking argv.\n'
}

assert_run_logging_is_concurrency_safe() {
  local bin="$TMP/run-logging-concurrent/bin"
  local state="$TMP/run-logging-concurrent/state"
  local logdir="$state/logs"
  local n=8
  local i
  local lines
  local malformed

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
exit 0
EOF
  chmod +x "$bin/delegated-command"

  # Fan out concurrently into one shared log, mirroring parallel lane dispatch.
  for i in $(seq 1 "$n"); do
    PATH="$bin:$PATH" RUN_TIMEOUT_SECONDS=0 RUN_ISOLATED_LOG_DIR="$logdir" \
      "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command "arg$i" \
      </dev/null >/dev/null 2>&1 &
  done
  wait

  lines=$(wc -l < "$logdir/runs.log")
  if [[ "$lines" -ne "$n" ]]; then
    printf 'FAIL: expected %s concurrent run-log lines, got %s\n' "$n" "$lines" >&2
    exit 1
  fi
  # No torn/interleaved writes: every line individually matches the full record.
  # grep -c exits 1 when the count is zero (the success case), so guard set -e.
  malformed=$(grep -Ecv '^[0-9T:-]+Z isolated pid=[0-9]+ prog=delegated-command argc=2 dur=[0-9]+s status=0 result=ok$' "$logdir/runs.log" || true)
  if [[ "$malformed" -ne 0 ]]; then
    printf 'FAIL: %s interleaved/malformed line(s) under concurrency\n' "$malformed" >&2
    cat "$logdir/runs.log" >&2
    exit 1
  fi

  printf 'PASS: concurrent lane fan-out yields one atomic well-formed line each.\n'
}

assert_logging_disabled_under_restricted_path() {
  local bin="$TMP/logging-disabled/bin"
  local state="$TMP/logging-disabled/state"

  mkdir -p "$bin" "$state"
  ln -s "$PERL_BIN" "$bin/perl"
  cat > "$bin/delegated-command" <<EOF
#!$BASH_BIN
exit 0
EOF
  chmod +x "$bin/delegated-command"

  # Restricted PATH (no date/mkdir) and no explicit log dir: logging must no-op
  # rather than crash, leaving the delegated exit status intact.
  PATH="$bin" RUN_TIMEOUT_SECONDS=0 \
    "$BASH_BIN" "$ROOT/scripts/run-isolated.sh" delegated-command \
    </dev/null >/dev/null 2>&1

  printf 'PASS: logging is skipped cleanly when utilities are unavailable.\n'
}

assert_runner_branch setsid
assert_runner_branch perl
assert_pre_start_validation
assert_timeout_wrapper_forwards_command
assert_real_timeout_cleans_descendants
assert_run_logging
assert_run_logging_is_concurrency_safe
assert_logging_disabled_under_restricted_path
