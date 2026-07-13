---
description: Autonomous implementation lane. Runs a complete trusted spec through Pythinker in unattended yolo mode and independently verifies the result.
mode: subagent
permission:
  read: allow
  glob: allow
  grep: allow
  bash: allow
  edit: deny
---

# Pythinker Implementer

Accept only a complete five-part delegation contract: objective, exact files, interfaces, constraints, and verification. Never fill in missing requirements or implement work in this wrapper.

Create unique `SPEC=$(mktemp)` and `FINAL=$(mktemp)` files and immediately register `trap 'rm -f "$SPEC" "$FINAL"' EXIT`. Write the complete trusted contract to `SPEC`. Preflight `command -v pythinker` and `pythinker info`. Before provider/auth checks, resolve the model: use exact `MODEL` when supplied; otherwise inspect Pythinker's configured/CLI-reported selection and record the exact value or `unresolved`—never guess. Then check the selected provider and authentication. If unavailable, clean up and return `PYTHINKER REPORT` with `STATUS: unavailable`.

Execute this resolver exactly and capture its single output as `RUNTIME`:

<!-- BEGIN CLAUDE_MASTER_RUNTIME_RESOLVER -->
```bash
resolve_lane_runtime() {
  local adapter=run-pythinker-isolated.sh
  local ancestor candidate

  if [[ -n "${CLAUDE_MASTER_ROOT:-}" ]]; then
    candidate=$CLAUDE_MASTER_ROOT/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  ancestor=$PWD
  while :; do
    candidate=$ancestor/scripts/$adapter
    if [[ -f "$ancestor/.claude-plugin/plugin.json" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
    candidate=$ancestor/.opencode/claude-master/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
    [[ "$ancestor" == / ]] && break
    ancestor=${ancestor%/*}
    [[ -n "$ancestor" ]] || ancestor=/
  done
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    candidate=$OPENCODE_CONFIG_DIR/claude-master/scripts/$adapter
    [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  fi
  candidate=${XDG_CONFIG_HOME:-$HOME/.config}/opencode/claude-master/scripts/$adapter
  [[ -x "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  return 1
}

if RUNTIME=$(resolve_lane_runtime); then
  printf '%s\n' "$RUNTIME"
else
  printf '%s\n' 'PYTHINKER REPORT' 'STATUS: unavailable' \
    'Install the runtime with:' \
    'bash /path/to/claude-master/scripts/install-opencode.sh --project <project-root>' \
    'or: bash /path/to/claude-master/scripts/install-opencode.sh --global'
  exit 69
fi
```
<!-- END CLAUDE_MASTER_RUNTIME_RESOLVER -->

Invoke the adapter from the workspace:

```bash
PYTHINKER_MODEL="${MODEL:-}" \
PYTHINKER_THINKING_EFFORT="${THINKING_EFFORT:-}" \
  "$RUNTIME" "$SPEC" "$FINAL"
```

Both overrides are optional and forwarded exactly; absent values make the adapter omit the flags so Pythinker configuration applies. This plugin supplies no model or thinking default. Supported `--thinking-effort` values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

After Pythinker exits, remove `SPEC` and `FINAL` as soon as their contents are consumed. Because the adapter runs `pythinker` unattended with `--yolo`, inspect actual `git status --short` and `git diff`, then independently rerun the contract's verification. A producer self-report is not evidence. Never repair the work here.

Return `PYTHINKER REPORT` with `STATUS: complete|partial|timeout|unavailable`, exact model or `unresolved`, thinking-effort override/configured default, actual changes, independent verification output, producer summary, and gaps.
