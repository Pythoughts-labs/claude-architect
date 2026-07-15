# Disable Codex Internal Multi-Agent Delegation

**Date:** 2026-07-14

## Problem

Claude Architect invokes Codex with `--ignore-user-config`, but Codex enables `multi_agent` by default. More importantly, Codex 0.144.4 can select MultiAgent V2 from GPT-5.6 Sol's model metadata even when `codex features list` reports both `multi_agent=false` and `multi_agent_v2=false`. In V2's `explicitRequestOnly` mode, applicable `AGENTS.md` or skill instructions can still trigger internal implementers and reviewers.

## Decision

The shared runner will append two controls after every caller's arguments:

```text
--disable multi_agent
-c features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}
```

The feature flag disables the normal path. The V2 concurrency limit is the hard backstop: V2 counts the root thread, so one total slot leaves zero child capacity and every `spawn_agent` call is rejected. Appending both controls prevents caller arguments from weakening them. Enforcement belongs in `scripts/run-codex-isolated.sh` so Claude Code, OpenCode, and direct runner callers receive identical behavior.

Claude Architect will continue using `--sandbox workspace-write`; it will not add `--yolo` or otherwise weaken approval and sandbox policy.

## Changes

- Extend the lifecycle regression test so both process-isolation paths and the stderr-logging launch branch must receive the enforced feature flag and V2 cap.
- Append the single-agent controls to both `codex exec` branches in the shared runner.
- Update the Claude and OpenCode Codex implementer contracts with the model-selected V2 behavior and hard-cap rationale.

## Verification

Run:

```bash
bash tests/codex-lifecycle.test.sh
bash -n scripts/run-isolated.sh scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
```

If ShellCheck is installed, also run:

```bash
shellcheck scripts/run-isolated.sh scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
```

## Non-goals

- No change to Codex model or reasoning selection.
- No change to timeout, process-group cleanup, stdin forwarding, or stderr logging.
- No use of `--yolo` in the Codex implementer lane.
- No implementation of the future TypeScript `CodexAdapter` in this patch.
