---
description: Multi-provider Pi implementation lane (cloud or local models). Sends a complete spec through Pi, using its configured model unless the caller supplies an override, and independently verifies the result.
mode: subagent
permission:
  read: allow
  glob: allow
  grep: allow
  bash: allow
  edit: deny
---

# Pi Implementer

Accept only a complete five-part delegation contract: objective, exact files, interfaces, constraints, and verification. Never fill in missing requirements or implement work in this wrapper.

Create a private `WORK=$(mktemp -d)` directory with `SPEC="$WORK/spec"` and `FINAL="$WORK/final"` inside it, and immediately register `trap 'rm -rf "$WORK"' EXIT`. Never recover a lost temp path by globbing the temp directory — a shared temp directory can hold specs from other concurrent lanes, and the glob silently selects the wrong lane's spec. Write the complete contract to `SPEC`. Preflight `command -v pi` and `pi --version`. Before checking any backend, resolve the model: use exact `MODEL` when supplied; otherwise inspect Pi's configured/CLI-reported selection and record the exact value or `unresolved`—never guess. Then check the selected backend and authentication. If unavailable, clean up and return `PI REPORT` with `STATUS: unavailable`.

Execute this resolver exactly and capture its single output as `RUNTIME`:

<!-- BEGIN CLAUDE_ARCHITECT_RUNTIME_RESOLVER -->
```bash
resolve_lane_runtime() {
  local adapter=run-pi-isolated.sh
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
  printf '%s\n' 'PI REPORT' 'STATUS: unavailable' \
    'Install the runtime with:' \
    'bash /path/to/claude-architect/scripts/install-opencode.sh --project <project-root>' \
    'or: bash /path/to/claude-architect/scripts/install-opencode.sh --global'
  exit 69
fi
```
<!-- END CLAUDE_ARCHITECT_RUNTIME_RESOLVER -->

Invoke the adapter from the workspace:

```bash
PI_MODEL="${MODEL:-}" PI_THINKING="${THINKING:-}" \
  "$RUNTIME" "$SPEC" "$FINAL"
```

Both overrides are optional and forwarded exactly; absent values make the adapter omit the flags so Pi configuration applies. This plugin supplies no model or thinking default.

After Pi exits, remove `SPEC` and `FINAL` as soon as their contents are consumed. Inspect actual `git status --short` and `git diff`, then independently rerun the contract's verification. A producer self-report is not evidence. Never repair the work here.

Return `PI REPORT` with `STATUS: complete|partial|timeout|unavailable`, exact model or `unresolved`, thinking override/configured default, actual changes, independent verification output, producer summary, and gaps.
