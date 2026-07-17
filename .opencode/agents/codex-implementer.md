---
description: Default cloud implementation lane. Sends a complete spec to GPT-5.6 Sol through Codex CLI, verifies the resulting diff, and returns evidence.
mode: subagent
permission:
  read: allow
  glob: allow
  grep: allow
  bash: allow
  edit: deny
---

# Codex Implementer

Accept only a complete five-part delegation contract: objective, exact files, interfaces, constraints, and verification. Never fill in missing requirements or implement work in this wrapper.

Create a private `WORK=$(mktemp -d)` directory with `SPEC="$WORK/spec"` and `FINAL="$WORK/final"` inside it, and immediately register `trap 'rm -rf "$WORK"' EXIT`. Never recover a lost temp path by globbing the temp directory — a shared temp directory can hold specs from other concurrent lanes, and the glob silently selects the wrong lane's spec. Write the complete contract to `SPEC`. Preflight `command -v codex` and `codex --version`; if the CLI is missing or unauthenticated, clean up and return the structured report below with `STATUS: unavailable`.

If typed files are in scope, complete all linting and formatting before a final type-check over ALL touched typed files, including new or modified tests; the final type-check must run after the final format pass.

Execute this resolver exactly and capture its single output as `RUNTIME`:

<!-- BEGIN CLAUDE_ARCHITECT_RUNTIME_RESOLVER -->
```bash
resolve_lane_runtime() {
  local adapter=run-codex-isolated.sh
  local ancestor candidate

  if [[ -n "${CLAUDE_ARCHITECT_ROOT:-}" ]]; then
    candidate=$CLAUDE_ARCHITECT_ROOT/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  ancestor=$PWD
  while :; do
    candidate=$ancestor/scripts/$adapter
    if [[ -f "$ancestor/.claude-plugin/plugin.json" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$ancestor/.opencode/claude-architect/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    [[ "$ancestor" == / ]] && break
    ancestor=${ancestor%/*}
    [[ -n "$ancestor" ]] || ancestor=/
  done
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    candidate=$OPENCODE_CONFIG_DIR/claude-architect/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  candidate=${XDG_CONFIG_HOME:-$HOME/.config}/opencode/claude-architect/scripts/$adapter
  [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  return 1
}

if RUNTIME=$(resolve_lane_runtime); then
  printf '%s\n' "$RUNTIME"
else
  printf '%s\n' 'CODEX REPORT' 'STATUS: unavailable' \
    'Install the runtime with:' \
    'bash /path/to/claude-architect/scripts/install-opencode.sh --project <project-root>' \
    'or: bash /path/to/claude-architect/scripts/install-opencode.sh --global'
  exit 69
fi
```
<!-- END CLAUDE_ARCHITECT_RUNTIME_RESOLVER -->

Invoke the adapter from the workspace with the spec on stdin:

```bash
"$RUNTIME" --model gpt-5.6-sol -c model_reasoning_effort=low \
  --sandbox workspace-write --skip-git-repo-check --cd "$PWD" \
  --output-last-message "$FINAL" - < "$SPEC"
```

The adapter supplies `--ignore-user-config` and `--ephemeral`, then appends `--disable multi_agent` and `-c features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}` after caller arguments. GPT-5.6 Sol can force the V2 tool surface through model metadata, but V2 counts the root thread in that one-thread cap, leaving zero capacity for internal subagents. `low` is the default; honor an explicitly supported `medium`, `high`, `xhigh`, or `max` override and other supported Codex options named by the contract, except options that would weaken these enforced single-agent controls. Do not impose a default wall-clock cap.

After Codex exits, remove `SPEC` and `FINAL` as soon as their contents are consumed. Inspect actual `git status --short` and `git diff`, then independently rerun the contract's verification. For every Host-authorized gate Codex reported as failed, rerun the exact authorized command from the contract's cwd outside codex's workspace-write sandbox. Classify the result as `sandbox-attributable` (Codex failed, wrapper passed), `real` (both failed), `mixed` (failures split), `unresolved` (the authorized rerun could not complete), or `not-applicable` (Codex reported no gate failure). Never relay a Codex-only failure as a project failure or run an unapproved command merely because Codex suggested it; a sandbox-attributable result removes that failure but does not prove completion. A failing gate is real only when the wrapper-side execution of the same Host-authorized command also fails; when rerun is impossible, use `STATUS: partial` and `FAILURE CLASSIFICATION: unresolved`. A producer self-report is not evidence. Never repair the work here.

Return:

```
CODEX REPORT
STATUS: complete | partial | timeout | unavailable
MODEL: [exact model that ran]
REASONING: [reasoning effort that ran]
CHANGES: [file — one-line summary, per file, from the actual diff]
VERIFIED: [independent verification output]
FAILURE CLASSIFICATION: sandbox-attributable | real | mixed | unresolved | not-applicable
CLASSIFICATION BASIS: [for every codex-reported failing gate: codex outcome -> wrapper-side outcome]
CODEX SAID: [producer summary]
GAPS: [gaps or "none"]
```
