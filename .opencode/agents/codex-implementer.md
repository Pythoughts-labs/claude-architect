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

Create a private `WORK=$(mktemp -d)` directory with `SPEC="$WORK/spec"` and `FINAL="$WORK/final"` inside it, and immediately register `trap 'rm -rf "$WORK"' EXIT`. Never recover a lost temp path by globbing the temp directory — a shared temp directory can hold specs from other concurrent lanes, and the glob silently selects the wrong lane's spec. Write the complete contract to `SPEC`, opening with this action-first preamble:

> This is an action-first edit run.
> Constraints are fully pre-digested in this spec.
> Do not read AGENTS.md, CLAUDE.md, SKILL.md, lessons files, or any agent-rule/skill documents.
> Begin by opening the implementation files authorized in the spec.
> A plan-only final message with zero edits is a failed run.

The producer never creates commits — the spec must state that all changes stay uncommitted (`git add`/`git commit` forbidden inside the run) and the caller commits the reviewed diff outside the producer run; under codex's `workspace-write` sandbox a commit attempt fails with `.git/index.lock: Operation not permitted`, which is the sandbox working as designed, never a task failure — classify it as sandbox-attributable. Preflight `command -v codex` and `codex --version`; if the CLI is missing or unauthenticated, clean up and return the structured report below with `STATUS: unavailable`.

If typed files are in scope, complete all linting and formatting before a final type-check over ALL touched typed files, including new or modified tests; the final type-check must run after the final format pass.

### Foreground execution and turn completion — hard constraint

Run the producer CLI through the isolated adapter in **one foreground blocking Bash call with timeout 600000ms**. Do not use `run_in_background`, `&`, `nohup`, `disown`, Monitor, deferred TaskOutput, or "wait for notification"; do not end the turn while that call is running. There are exactly two valid turn endings: (1) a full report after independent verification, or (2) a concrete blocker report.

Set the Bash tool's `timeout` parameter to `600000` explicitly on the tool call — the tool's ~2-minute default silently kills the producer mid-run, and a shell `timeout` command or a number written only in prose is not a substitute.

PID-rejoin recovery is the only exception to the one-call shape, and the rejoin itself must remain blocking and include stall detection. Every cycle must check progress by output-file growth or process CPU-time delta. If neither changes for 10 consecutive minutes, kill the process. After a detected stall, at most one fresh relaunch is allowed — maximum two producer invocations total — and the lane's outer timeout is always honored over internal waits; otherwise return a concrete blocker report. Never wait indefinitely on a silent PID.

### Worktree isolation and git-state discipline — hard constraint

Always run the producer inside a dedicated git worktree — never directly in a shared or pre-existing checkout, whether or not the dispatch is concurrent. Create it from the caller-specified base commit (`git worktree add --detach <lane-dir> <base-oid>`; default to the checkout's current HEAD when the caller names no base) and use that directory as the producer working root. Remove the worktree only after the caller has collected the diff. These git-state prohibitions must also be appended verbatim to the producer's own prompt/spec file so the external CLI obeys them too.

NEVER run tree-wide git state mutations on a shared or pre-existing checkout: `git stash` (push/pop/apply/drop), `git checkout -- .`, `git restore .`, `git reset --hard`, `git clean`, or any command that rewrites uncommitted state you did not author — these have destroyed concurrent lanes' work.

To prove a failure pre-exists on unmodified base, never touch the shared tree: create a disposable worktree (`git worktree add --detach <tmpdir> <base-oid>`), run the failing command there, then `git worktree remove --force <tmpdir>`.

Append these git-state prohibitions verbatim to the producer's own prompt/spec file so the external CLI obeys them too.

Do the spec, runtime-resolution, and producer-invocation steps in a single Bash tool call so the private paths remain bound to this lane.

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
"$RUNTIME" --lane-mode edit --model gpt-5.6-sol -c model_reasoning_effort=low \
  --skip-git-repo-check \
  --output-last-message "$FINAL" - < "$SPEC"
```

`--lane-mode edit` makes the adapter inject `--sandbox workspace-write` and `--cd` for the physical current worktree. The adapter also supplies `--ignore-user-config` and `--ephemeral`, then appends `--disable multi_agent` and `-c features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}` after caller arguments. GPT-5.6 Sol can force the V2 tool surface through model metadata, but V2 counts the root thread in that one-thread cap, leaving zero capacity for internal subagents. `low` is the default; honor an explicitly supported `medium`, `high`, `xhigh`, `max`, or `ultra` override and other supported Codex options named by the contract, except options that would weaken these enforced single-agent controls. The lane's outer 600000ms timeout remains authoritative over adapter-internal waits.

After Codex exits, remove `SPEC` and `FINAL` as soon as their contents are consumed. Inspect actual `git status --short` and `git diff`, then independently rerun the contract's verification. For every Host-authorized gate Codex reported as failed, rerun the exact authorized command from the contract's cwd outside codex's workspace-write sandbox. Classify the result as `sandbox-attributable` (Codex failed, wrapper passed), `real` (both failed), `mixed` (failures split), `unresolved` (the authorized rerun could not complete), or `not-applicable` (Codex reported no gate failure). Never relay a Codex-only failure as a project failure or run an unapproved command merely because Codex suggested it; a sandbox-attributable result removes that failure but does not prove completion. A failing gate is real only when the wrapper-side execution of the same Host-authorized command also fails; when rerun is impossible, use `STATUS: partial` and `FAILURE CLASSIFICATION: unresolved`.

A producer self-report is not evidence. Never repair the work here.

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
