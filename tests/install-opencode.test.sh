#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INSTALLER="$ROOT/scripts/install-opencode.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

AGENTS=(codex-implementer.md claude-advisor.md pi-implementer.md pythinker-implementer.md)
RUNTIMES=(run-isolated.sh run-codex-isolated.sh run-opencode-isolated.sh run-pi-isolated.sh run-pythinker-isolated.sh)

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_managed_layout() {
  local base=$1
  local agent
  local runtime

  for agent in "${AGENTS[@]}"; do
    cmp -s "$ROOT/.opencode/agents/$agent" "$base/agents/$agent" ||
      fail "$base/agents/$agent does not byte-match its source"
  done
  cmp -s "$ROOT/skills/delegate/SKILL.md" "$base/skills/delegate/SKILL.md" ||
    fail "$base/skills/delegate/SKILL.md does not byte-match its source"
  for runtime in "${RUNTIMES[@]}"; do
    cmp -s "$ROOT/scripts/$runtime" "$base/claude-master/scripts/$runtime" ||
      fail "$base/claude-master/scripts/$runtime does not byte-match its source"
    [[ -x "$base/claude-master/scripts/$runtime" ]] ||
      fail "$base/claude-master/scripts/$runtime is not executable"
  done
}

assert_reported_destinations() {
  local base=$1
  local output=$2
  local expected
  local count=0

  while IFS= read -r expected; do
    grep -Fxq "$expected" "$output" || fail "installer did not report $expected"
    count=$((count + 1))
  done < <(
    printf '%s\n' \
      "$base/agents/codex-implementer.md" \
      "$base/agents/claude-advisor.md" \
      "$base/agents/pi-implementer.md" \
      "$base/agents/pythinker-implementer.md" \
      "$base/skills/delegate/SKILL.md" \
      "$base/claude-master/scripts/run-isolated.sh" \
      "$base/claude-master/scripts/run-codex-isolated.sh" \
      "$base/claude-master/scripts/run-opencode-isolated.sh" \
      "$base/claude-master/scripts/run-pi-isolated.sh" \
      "$base/claude-master/scripts/run-pythinker-isolated.sh"
  )
  [[ $(wc -l < "$output" | tr -d ' ') -eq "$count" ]] ||
    fail 'installer reported an unexpected number of destinations'
}

assert_project_install() {
  local project="$TMP/project with spaces"
  local base="$project/.opencode"
  local output="$TMP/project-output"

  (cd "$TMP" && bash "$INSTALLER" --project "$project") > "$output"
  assert_managed_layout "$base"
  assert_reported_destinations "$base" "$output"

  printf 'keep me\n' > "$base/agents/unrelated.md"
  printf '{"keep":true}\n' > "$base/opencode.json"
  printf 'stale\n' > "$base/agents/codex-implementer.md"
  chmod -x "$base/claude-master/scripts/run-codex-isolated.sh"
  bash "$INSTALLER" --project "$project" > "$output"
  assert_managed_layout "$base"
  grep -Fxq 'keep me' "$base/agents/unrelated.md" || fail 'reinstall removed an unrelated agent'
  grep -Fxq '{"keep":true}' "$base/opencode.json" || fail 'reinstall changed unrelated config'

  printf 'PASS: project install is complete, quoted, deterministic, and non-destructive.\n'
}

assert_global_installs() {
  local home="$TMP/home"
  local xdg="$TMP/xdg"
  local configured="$TMP/custom config"
  local default_base="$xdg/opencode"

  HOME="$home" XDG_CONFIG_HOME="$xdg" bash "$INSTALLER" --global > "$TMP/global-output"
  assert_managed_layout "$default_base"
  assert_reported_destinations "$default_base" "$TMP/global-output"

  HOME="$home" XDG_CONFIG_HOME="$xdg" OPENCODE_CONFIG_DIR="$configured" \
    bash "$INSTALLER" --global > "$TMP/custom-output"
  assert_managed_layout "$configured"
  assert_reported_destinations "$configured" "$TMP/custom-output"
  [[ ! -e "$home/.config/opencode" ]] || fail 'global install ignored XDG_CONFIG_HOME'

  printf 'PASS: global install honors XDG and OPENCODE_CONFIG_DIR precedence.\n'
}

assert_invalid_arguments() {
  local case_name=0
  local status
  local target

  while IFS= read -r -d '' arguments; do
    case_name=$((case_name + 1))
    target="$TMP/invalid-$case_name"
    read -r -a argv <<< "$arguments"
    set +e
    HOME="$target/home" XDG_CONFIG_HOME="$target/xdg" OPENCODE_CONFIG_DIR="$target/config" \
      bash "$INSTALLER" ${argv[@]+"${argv[@]}"} > "$target.stdout" 2> "$target.stderr"
    status=$?
    set -e
    [[ "$status" -eq 64 ]] || fail "invalid form $case_name exited $status instead of 64"
    grep -Fxq 'usage: install-opencode.sh --project <project-root> | --global' "$target.stderr" ||
      fail "invalid form $case_name did not fail installer argument validation"
    [[ ! -e "$target/home" && ! -e "$target/xdg" && ! -e "$target/config" ]] ||
      fail "invalid form $case_name created a partial install tree"
    [[ ! -e "$ROOT/--global" ]] || fail "invalid form $case_name wrote relative to the caller's cwd"
  done < <(printf '%s\0' \
    '' \
    '--project' \
    '--project --global' \
    '--global --project nowhere' \
    '--project one --project two' \
    '--global extra' \
    '--project nowhere extra' \
    '--unknown')

  printf 'PASS: invalid, mixed, missing, and extra arguments fail before writes.\n'
}

extract_resolver() {
  local agent=$1
  local output=$2

  awk '
    /<!-- BEGIN CLAUDE_MASTER_RUNTIME_RESOLVER -->/ { inside=1; next }
    /<!-- END CLAUDE_MASTER_RUNTIME_RESOLVER -->/ { inside=0; found=1; next }
    inside && $0 !~ /^```/ { print }
    END { if (!found) exit 1 }
  ' "$agent" > "$output"
}

assert_resolver_case() {
  local agent_name=$1
  local adapter=$2
  local project="$TMP/resolver-$agent_name"
  local nested="$project/work/a/b"
  local block="$TMP/$agent_name-resolver.sh"
  local resolved

  bash "$INSTALLER" --project "$project" > /dev/null
  mkdir -p "$nested"
  extract_resolver "$ROOT/.opencode/agents/$agent_name-implementer.md" "$block"
  resolved=$(cd "$nested" && env -u CLAUDE_MASTER_ROOT -u OPENCODE_CONFIG_DIR bash "$block")
  [[ "$resolved" == "$project/.opencode/claude-master/scripts/$adapter" ]] ||
    fail "$agent_name nested resolver returned $resolved"

  printf 'PASS: %s resolves %s from a nested project directory.\n' "$agent_name" "$adapter"
}

assert_custom_global_resolver_case() {
  local agent_name=$1
  local adapter=$2
  local configured="$TMP/global-resolver-$agent_name"
  local cwd="$TMP/outside-$agent_name/a/b"
  local block="$TMP/$agent_name-global-resolver.sh"
  local resolved

  OPENCODE_CONFIG_DIR="$configured" bash "$INSTALLER" --global > /dev/null
  mkdir -p "$cwd"
  extract_resolver "$ROOT/.opencode/agents/$agent_name-implementer.md" "$block"
  resolved=$(cd "$cwd" && OPENCODE_CONFIG_DIR="$configured" env -u CLAUDE_MASTER_ROOT bash "$block")
  [[ "$resolved" == "$configured/claude-master/scripts/$adapter" ]] ||
    fail "$agent_name custom-global resolver returned $resolved"

  printf 'PASS: %s resolves %s from OPENCODE_CONFIG_DIR.\n' "$agent_name" "$adapter"
}

assert_project_install
assert_global_installs
assert_invalid_arguments
assert_resolver_case codex run-codex-isolated.sh
assert_resolver_case pi run-pi-isolated.sh
assert_resolver_case pythinker run-pythinker-isolated.sh
assert_custom_global_resolver_case codex run-codex-isolated.sh
assert_custom_global_resolver_case pi run-pi-isolated.sh
assert_custom_global_resolver_case pythinker run-pythinker-isolated.sh

printf 'PASS: OpenCode installer and runtime lookup behavior are verified.\n'
