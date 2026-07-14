# Disable Codex Internal Multi-Agent Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure Codex processes launched by Claude Architect cannot spawn internal subagents.

**Architecture:** Append the normal feature disable plus a one-total-thread MultiAgent V2 cap in the shared Codex runner so Claude Code, OpenCode, and direct runner callers behave identically. The V2 cap is required because GPT-5.6 Sol can select V2 through model metadata despite disabled feature flags. Protect both launch branches with the existing real-process lifecycle harness, then synchronize both implementer instruction files with the enforced runtime behavior.

**Tech Stack:** Bash 3.2-compatible shell, Codex CLI, existing shell integration tests.

## Global Constraints

- Keep `--sandbox workspace-write`; never add `--yolo` or `danger-full-access`.
- Preserve stdin forwarding, timeout behavior, process-group cleanup, stderr streaming, and run logging.
- Do not implement the future TypeScript `CodexAdapter` in this patch.
- Do not modify the untracked `tasks/` directory.

---

## Live-verification correction

Tasks 1 and 2 record the initial feature-flag-only implementation. A live GPT-5.6 Sol run later proved that model metadata can force MultiAgent V2 while the feature listing remains false. Task 3 supersedes the earlier invocation details with the hard V2 concurrency cap.

### Task 1: Enforce single-agent Codex execution

**Files:**
- Modify: `tests/codex-lifecycle.test.sh:52-104`
- Modify: `scripts/run-codex-isolated.sh:45-53`

**Interfaces:**
- Consumes: arbitrary Codex `exec` arguments supplied to `scripts/run-codex-isolated.sh`.
- Produces: a Codex argv containing the adjacent pair `--disable`, `multi_agent` before caller-supplied arguments in both stderr-logging and fallback branches.

- [x] **Step 1: Write the failing argv regression check**

Inside `run_case`, add Bash 3.2-compatible state and scan the stub's captured argv:

```bash
  local arg
  local disable_multi_agent_seen=0
  local previous_arg=
```

After the existing `--ephemeral` assertion, add:

```bash
  while IFS= read -r arg; do
    if [[ "$previous_arg" == --disable && "$arg" == multi_agent ]]; then
      disable_multi_agent_seen=1
      break
    fi
    previous_arg=$arg
  done < "$state/args"

  if [[ "$disable_multi_agent_seen" -ne 1 ]]; then
    printf 'FAIL: %s branch did not disable Codex multi_agent\n' "$mode" >&2
    exit 1
  fi
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
bash tests/codex-lifecycle.test.sh
```

Expected: exit 1 with `FAIL: setsid branch did not disable Codex multi_agent`.

- [x] **Step 3: Add the enforced feature flag to both launch branches**

Change both Codex commands in `scripts/run-codex-isolated.sh` to include the exact pair:

```bash
codex exec --ignore-user-config --ephemeral --disable multi_agent "$@"
```

Preserve the existing stderr process substitution in the logging branch.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bash tests/codex-lifecycle.test.sh
```

Expected: exit 0; both `setsid` and `perl` cases report `PASS` and all timeout/stderr cases remain green.

### Task 2: Synchronize implementer contracts

**Files:**
- Modify: `tests/codex-lifecycle.test.sh:14-20`
- Modify: `agents/codex-implementer.md:110-118`
- Modify: `.opencode/agents/codex-implementer.md:69`

**Interfaces:**
- Consumes: the shared runner behavior from Task 1.
- Produces: Claude Code and OpenCode instructions that accurately state internal Codex delegation is disabled.

- [x] **Step 1: Write failing contract assertions**

Add these assertions near the existing implementer contract checks:

```bash
assert_contains "$ROOT/agents/codex-implementer.md" '--disable multi_agent'
assert_contains "$ROOT/.opencode/agents/codex-implementer.md" '--disable multi_agent'
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
bash tests/codex-lifecycle.test.sh
```

Expected: exit 1 because `agents/codex-implementer.md` does not yet document `--disable multi_agent`.

- [x] **Step 3: Update both contracts**

Add this row to the Claude implementer's flag table:

```markdown
| `--disable multi_agent` | Prevents Codex from spawning internal subagents; Claude Architect owns delegation and verification. |
```

Update its isolated-runner row so the listed supplied flags include `--disable multi_agent`.

Change the OpenCode implementer's adapter sentence to:

```markdown
The adapter supplies `--ignore-user-config`, `--ephemeral`, and `--disable multi_agent`; internal Codex subagents are not part of this lane.
```

- [x] **Step 4: Run focused and static verification**

Run:

```bash
bash tests/codex-lifecycle.test.sh
bash -n scripts/run-isolated.sh scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
```

Expected: both commands exit 0.

If available, run:

```bash
shellcheck scripts/run-isolated.sh scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
```

Expected: exit 0.

Execution note: the unsuppressed command reported the pre-existing `SC2034` warning for the intentionally unused polling counter at `tests/codex-lifecycle.test.sh:302`; rerunning with `-e SC2034` produced no findings.

- [x] **Step 5: Review and commit the scoped change**

Run:

```bash
git diff --check
git diff -- scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh agents/codex-implementer.md .opencode/agents/codex-implementer.md
git add scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh agents/codex-implementer.md .opencode/agents/codex-implementer.md docs/superpowers/plans/2026-07-14-disable-codex-multi-agent.md
git commit -m "fix(codex): disable internal multi-agent delegation"
```

Expected: only the five scoped files are committed; the untracked `tasks/` directory remains untouched.

### Task 3: Block model-selected MultiAgent V2

**Files:**
- Modify: `scripts/run-codex-isolated.sh`
- Modify: `tests/codex-lifecycle.test.sh`
- Modify: `agents/codex-implementer.md`
- Modify: `.opencode/agents/codex-implementer.md`
- Modify: `docs/superpowers/specs/2026-07-14-disable-codex-multi-agent-design.md`

**Interfaces:**
- Consumes: caller-provided Codex arguments, including the stdin prompt marker.
- Produces: final enforced arguments `--disable multi_agent` and `-c features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}` after caller arguments.

- [x] **Step 1: Reproduce the forced-V2 failure**

Inspect the live Codex 0.144.4 rollout and confirm `multi_agent_version=v2`, `multi_agent_mode=explicitRequestOnly`, and a successful `spawn_agent` call while feature listing reports false.

- [x] **Step 2: Write and run the failing hard-cap regression test**

Require the exact adjacent `-c` and V2 cap argument pair in both process-isolation cases and the stderr-logging branch. Run `bash tests/codex-lifecycle.test.sh` and expect failure because the cap is absent.

- [x] **Step 3: Append the hard controls after caller arguments**

Use this final suffix in both runner branches:

```bash
"$@" \
  --disable multi_agent \
  -c 'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}'
```

- [x] **Step 4: Synchronize contracts and regression assertions**

Document why `--disable multi_agent` is insufficient for GPT-5.6 Sol and why one V2 slot blocks children. Assert both implementer contracts contain `max_concurrent_threads_per_session=1`.

- [x] **Step 5: Verify the hard cap**

Run the lifecycle test, Bash syntax check, ShellCheck excluding only the documented pre-existing `SC2034`, and a live ephemeral read-only Codex diagnostic that explicitly requests one child. Expected live result: `agent thread limit reached` and no files modified.
