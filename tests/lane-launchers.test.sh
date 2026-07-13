#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASH_BIN=$(command -v bash)
CAT_BIN=$(command -v cat)
ENV_BIN=$(command -v env)
PERL_BIN=$(command -v perl)
PWD_BIN=$(command -v pwd)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_status() {
  local expected=$1
  local actual=$2
  local context=$3

  if [[ "$actual" -ne "$expected" ]]; then
    fail "$context exited $actual instead of $expected"
  fi
}

assert_file_equals() {
  local expected=$1
  local actual=$2
  local context=$3

  if ! cmp -s "$expected" "$actual"; then
    diff -u "$expected" "$actual" >&2 || true
    fail "$context did not match"
  fi
}

assert_count() {
  local expected=$1
  local needle=$2
  local file=$3
  local context=$4
  local actual=0

  while IFS= read -r -d '' argument; do
    if [[ "$argument" == "$needle" ]]; then
      actual=$((actual + 1))
    fi
  done < "$file"

  if [[ "$actual" -ne "$expected" ]]; then
    fail "$context found $actual occurrences of $needle instead of $expected"
  fi
}

write_lane_stub() {
  local bin=$1
  local lane=$2

  cat > "$bin/$lane" <<EOF
#!$BASH_BIN
printf '%s\0' "\$@" > "\$LANE_TEST_ARGS"
"$CAT_BIN" > "\$LANE_TEST_STDIN"
"$PWD_BIN" > "\$LANE_TEST_CWD"
printf '%s stdout\n' '$lane'
printf '%s stderr\n' '$lane' >&2
EOF
  chmod +x "$bin/$lane"
}

write_timeout_stub() {
  local bin=$1

  cat > "$bin/timeout" <<EOF
#!$BASH_BIN
printf '%s\n' "\$1" > "\$LANE_TEST_TIMEOUT"
shift
printf '%s\0' "\$@" > "\$LANE_TEST_WRAPPED_ARGS"
exec "\$@"
EOF
  chmod +x "$bin/timeout"
}

prepare_case() {
  local name=$1
  local lane=$2
  local case_dir="$TMP/$name"

  mkdir -p "$case_dir/bin" "$case_dir/work" "$case_dir/state"
  write_lane_stub "$case_dir/bin" "$lane"
  write_timeout_stub "$case_dir/bin"
  ln -s "$PERL_BIN" "$case_dir/bin/perl"
  printf 'first line\nsecond line without final newline' > "$case_dir/spec"
}

run_adapter() {
  local name=$1
  local adapter=$2
  shift 2
  local case_dir="$TMP/$name"

  (
    cd "$case_dir/work"
    PATH="$case_dir/bin" \
      LANE_TEST_ARGS="$case_dir/state/args" \
      LANE_TEST_STDIN="$case_dir/state/stdin" \
      LANE_TEST_CWD="$case_dir/state/cwd" \
      LANE_TEST_TIMEOUT="$case_dir/state/timeout" \
      LANE_TEST_WRAPPED_ARGS="$case_dir/state/wrapped-args" \
      "$@" "$BASH_BIN" "$ROOT/scripts/$adapter" \
        "$case_dir/spec" "$case_dir/final"
  )
}

assert_common_success() {
  local name=$1
  local lane=$2
  local expected_timeout=$3
  local case_dir="$TMP/$name"

  printf '%s stdout\n%s stderr\n' "$lane" "$lane" > "$case_dir/expected-final"
  assert_file_equals "$case_dir/expected-final" "$case_dir/final" "$lane final output"
  grep -Fxq "$case_dir/work" "$case_dir/state/cwd" || fail "$lane did not preserve cwd"
  grep -Fxq "$expected_timeout" "$case_dir/state/timeout" || fail "$lane timeout was not mapped"
  assert_count 1 "$lane" "$case_dir/state/wrapped-args" "$lane wrapped command"
}

assert_invalid_arguments() {
  local adapter=$1
  local lane=$2
  local variable=$3
  local case_dir="$TMP/invalid-$lane"
  local status

  mkdir -p "$case_dir/bin" "$case_dir/state"
  write_lane_stub "$case_dir/bin" "$lane"
  printf 'spec' > "$case_dir/spec"
  printf 'unreadable' > "$case_dir/unreadable"
  chmod 000 "$case_dir/unreadable"

  local -a cases=(
    ""
    "$case_dir/spec"
    "$case_dir/missing $case_dir/final"
    "$case_dir/unreadable $case_dir/final"
    "$case_dir/spec $case_dir/final extra"
  )
  local arguments
  for arguments in "${cases[@]}"; do
    local -a argv=()
    if [[ -n "$arguments" ]]; then
      read -r -a argv <<< "$arguments"
    fi
    rm -f "$case_dir/state/args"
    set +e
    env PATH="$case_dir/bin" "$variable=0" \
      LANE_TEST_ARGS="$case_dir/state/args" \
      LANE_TEST_STDIN="$case_dir/state/stdin" \
      LANE_TEST_CWD="$case_dir/state/cwd" \
      "$BASH_BIN" "$ROOT/scripts/$adapter" ${argv[@]+"${argv[@]}"} \
      > "$case_dir/state/stdout" 2> "$case_dir/state/stderr"
    status=$?
    set -e
    assert_status 64 "$status" "$adapter invalid arguments"
    [[ ! -e "$case_dir/state/args" ]] || fail "$lane started before argument validation"
  done

  printf 'PASS: %s rejects invalid arguments before CLI startup.\n' "$lane"
}

assert_timeout_policy() {
  local adapter=$1
  local lane=$2
  local variable=$3
  local case_dir="$TMP/timeout-$lane"
  local status

  mkdir -p "$case_dir/bin" "$case_dir/state"
  write_lane_stub "$case_dir/bin" "$lane"
  ln -s "$PERL_BIN" "$case_dir/bin/perl"
  printf 'spec' > "$case_dir/spec"

  set +e
  env PATH="$case_dir/bin" \
    LANE_TEST_ARGS="$case_dir/state/args" \
    LANE_TEST_STDIN="$case_dir/state/stdin" \
    LANE_TEST_CWD="$case_dir/state/cwd" \
    "$BASH_BIN" "$ROOT/scripts/$adapter" "$case_dir/spec" "$case_dir/final" \
    > "$case_dir/state/default-stdout" 2> "$case_dir/state/default-stderr"
  status=$?
  set -e
  assert_status 69 "$status" "$adapter default timeout without timeout binary"
  [[ ! -e "$case_dir/state/args" ]] || fail "$lane started without default timeout enforcement"

  env PATH="$case_dir/bin" "$variable=0" \
    LANE_TEST_ARGS="$case_dir/state/args" \
    LANE_TEST_STDIN="$case_dir/state/stdin" \
    LANE_TEST_CWD="$case_dir/state/cwd" \
    "$BASH_BIN" "$ROOT/scripts/$adapter" "$case_dir/spec" "$case_dir/final"
  [[ -e "$case_dir/state/args" ]] || fail "$lane timeout 0 did not disable the cap"

  printf 'PASS: %s defaults fail closed and timeout 0 disables the cap.\n' "$lane"
}

for adapter in run-pi-isolated.sh run-pythinker-isolated.sh run-opencode-isolated.sh; do
  [[ -x "$ROOT/scripts/$adapter" ]] || fail "missing executable scripts/$adapter"
done

assert_invalid_arguments run-pi-isolated.sh pi PI_TIMEOUT_SECONDS
assert_invalid_arguments run-pythinker-isolated.sh pythinker PYTHINKER_TIMEOUT_SECONDS
assert_invalid_arguments run-opencode-isolated.sh opencode OPENCODE_TIMEOUT_SECONDS

assert_timeout_policy run-pi-isolated.sh pi PI_TIMEOUT_SECONDS
assert_timeout_policy run-pythinker-isolated.sh pythinker PYTHINKER_TIMEOUT_SECONDS
assert_timeout_policy run-opencode-isolated.sh opencode OPENCODE_TIMEOUT_SECONDS

prepare_case pi-default pi
run_adapter pi-default run-pi-isolated.sh "$ENV_BIN" PI_TIMEOUT_SECONDS=17
printf '%s\0' -p --no-session --no-skills --tools read,bash,edit,write,grep,find,ls \
  "@$TMP/pi-default/spec" \
  'Implement the attached spec, verify the work, and report the final result.' \
  > "$TMP/pi-default/expected-args"
assert_file_equals "$TMP/pi-default/expected-args" "$TMP/pi-default/state/args" 'Pi default argv'
[[ ! -s "$TMP/pi-default/state/stdin" ]] || fail 'Pi stdin was not empty'
assert_count 0 - "$TMP/pi-default/state/args" 'Pi bare prompt argument'
assert_count 0 --model "$TMP/pi-default/state/args" 'Pi default model flag'
assert_count 0 --thinking "$TMP/pi-default/state/args" 'Pi default thinking flag'
assert_common_success pi-default pi 17

prepare_case pi-default-cap pi
run_adapter pi-default-cap run-pi-isolated.sh "$ENV_BIN" -u PI_TIMEOUT_SECONDS
assert_common_success pi-default-cap pi 900

prepare_case pi-model pi
run_adapter pi-model run-pi-isolated.sh "$ENV_BIN" PI_MODEL=local/model PI_TIMEOUT_SECONDS=18
assert_count 1 --model "$TMP/pi-model/state/args" 'Pi model flag'
assert_count 1 local/model "$TMP/pi-model/state/args" 'Pi model value'
assert_count 0 --thinking "$TMP/pi-model/state/args" 'Pi independent thinking omission'

prepare_case pi-thinking pi
run_adapter pi-thinking run-pi-isolated.sh "$ENV_BIN" PI_THINKING=high PI_TIMEOUT_SECONDS=19
assert_count 0 --model "$TMP/pi-thinking/state/args" 'Pi independent model omission'
assert_count 1 --thinking "$TMP/pi-thinking/state/args" 'Pi thinking flag'
assert_count 1 high "$TMP/pi-thinking/state/args" 'Pi thinking value'

prepare_case pythinker-default pythinker
run_adapter pythinker-default run-pythinker-isolated.sh "$ENV_BIN" PYTHINKER_TIMEOUT_SECONDS=27
printf '%s\0' --quiet --prompt "$(<"$TMP/pythinker-default/spec")" \
  --work-dir "$TMP/pythinker-default/work" --yolo \
  > "$TMP/pythinker-default/expected-args"
assert_file_equals "$TMP/pythinker-default/expected-args" "$TMP/pythinker-default/state/args" 'Pythinker default argv'
[[ ! -s "$TMP/pythinker-default/state/stdin" ]] || fail 'Pythinker stdin was not empty'
assert_count 0 --model "$TMP/pythinker-default/state/args" 'Pythinker default model flag'
assert_count 0 --thinking-effort "$TMP/pythinker-default/state/args" 'Pythinker default thinking flag'
assert_common_success pythinker-default pythinker 27

prepare_case pythinker-default-cap pythinker
run_adapter pythinker-default-cap run-pythinker-isolated.sh "$ENV_BIN" -u PYTHINKER_TIMEOUT_SECONDS
assert_common_success pythinker-default-cap pythinker 900

prepare_case pythinker-model pythinker
run_adapter pythinker-model run-pythinker-isolated.sh "$ENV_BIN" PYTHINKER_MODEL=provider/model PYTHINKER_TIMEOUT_SECONDS=28
assert_count 1 --model "$TMP/pythinker-model/state/args" 'Pythinker model flag'
assert_count 1 provider/model "$TMP/pythinker-model/state/args" 'Pythinker model value'
assert_count 0 --thinking-effort "$TMP/pythinker-model/state/args" 'Pythinker independent thinking omission'

prepare_case pythinker-thinking pythinker
run_adapter pythinker-thinking run-pythinker-isolated.sh "$ENV_BIN" PYTHINKER_THINKING_EFFORT=max PYTHINKER_TIMEOUT_SECONDS=29
assert_count 0 --model "$TMP/pythinker-thinking/state/args" 'Pythinker independent model omission'
assert_count 1 --thinking-effort "$TMP/pythinker-thinking/state/args" 'Pythinker thinking flag'
assert_count 1 max "$TMP/pythinker-thinking/state/args" 'Pythinker thinking value'

prepare_case opencode-default opencode
run_adapter opencode-default run-opencode-isolated.sh "$ENV_BIN" OPENCODE_TIMEOUT_SECONDS=37
printf '%s\0' run --dir "$TMP/opencode-default/work" --agent build --auto --log-level ERROR \
  > "$TMP/opencode-default/expected-args"
assert_file_equals "$TMP/opencode-default/expected-args" "$TMP/opencode-default/state/args" 'OpenCode default argv'
assert_file_equals "$TMP/opencode-default/spec" "$TMP/opencode-default/state/stdin" 'OpenCode spec stdin'
assert_count 0 --model "$TMP/opencode-default/state/args" 'OpenCode default model flag'
assert_count 0 --variant "$TMP/opencode-default/state/args" 'OpenCode default variant flag'
assert_common_success opencode-default opencode 37

prepare_case opencode-default-cap opencode
run_adapter opencode-default-cap run-opencode-isolated.sh "$ENV_BIN" -u OPENCODE_TIMEOUT_SECONDS
assert_common_success opencode-default-cap opencode 900

prepare_case opencode-model opencode
run_adapter opencode-model run-opencode-isolated.sh "$ENV_BIN" OPENCODE_MODEL=provider/model OPENCODE_TIMEOUT_SECONDS=38
assert_count 1 --model "$TMP/opencode-model/state/args" 'OpenCode model flag'
assert_count 1 provider/model "$TMP/opencode-model/state/args" 'OpenCode model value'
assert_count 0 --variant "$TMP/opencode-model/state/args" 'OpenCode independent variant omission'

prepare_case opencode-variant opencode
run_adapter opencode-variant run-opencode-isolated.sh "$ENV_BIN" OPENCODE_VARIANT=high OPENCODE_TIMEOUT_SECONDS=39
assert_count 0 --model "$TMP/opencode-variant/state/args" 'OpenCode independent model omission'
assert_count 1 --variant "$TMP/opencode-variant/state/args" 'OpenCode variant flag'
assert_count 1 high "$TMP/opencode-variant/state/args" 'OpenCode variant value'

printf 'PASS: lane adapters preserve CLI-specific argv, stdin, cwd, output, and overrides.\n'
