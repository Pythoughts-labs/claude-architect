# Disable Codex Internal Multi-Agent Delegation

**Date:** 2026-07-14

## Problem

Claude Architect invokes Codex with `--ignore-user-config`, but Codex enables `multi_agent` by default. A delegated Codex run can therefore spawn internal implementers or reviewers and repeatedly poll them, despite Claude Architect's one-shot Producer contract.

## Decision

The shared Codex runner will pass `--disable multi_agent` on every invocation. Enforcement belongs in `scripts/run-codex-isolated.sh` so Claude Code, OpenCode, and direct adapter callers receive identical behavior.

Claude Architect will continue using `--sandbox workspace-write`; it will not add `--yolo` or otherwise weaken approval and sandbox policy.

## Changes

- Extend the existing lifecycle regression test first so both the `setsid` and Perl isolation paths must forward the exact `--disable` and `multi_agent` arguments.
- Add `--disable multi_agent` to both `codex exec` branches in the shared runner.
- Update the Claude and OpenCode Codex implementer contracts to document that the adapter disables internal Codex delegation.

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
