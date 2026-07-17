# Delegation Contract Repair Design

Date: 2026-07-17
Status: Approved design

## Problem

Four dogfood failures make edit delegation unnecessarily difficult or impossible:

1. `skills/delegate/SKILL.md` does not describe the canonical Delegation Spec precisely. It says `argv` instead of `args`, omits accepted network values and the timeout ceiling, and does not show the separate `producerOverrides` object. The review block also has no supported reviewer-only guidance field.
2. The runtime correctly rejects a dirty checkout, but the delegate skill does not warn that tracked planning files such as `tasks/todo.md` must be committed before dispatch.
3. The nested-repository precondition treats every in-scope filesystem symlink as a nested repository. It never inspects the target, so a tracked package file link to a repository-root file is rejected in both primary and linked worktrees.
4. The legacy Codex implementer definitions pass `--sandbox workspace-write` and `--cd`, while `run-codex-isolated.sh` rejects both. If callers omit them, the wrapper ignores user configuration and supplies no authoritative sandbox mode, so Codex can fall back to read-only.

The current source at v0.19.0 retains all four behaviors. The symlink failure is not caused by following the link into the root; it is caused by unconditional symlink rejection.

## Goals

- Make the delegate skill an exact, usable description of the canonical schema.
- Add typed reviewer-only focus guidance to the Delegation Spec.
- Keep the exact clean-checkout identity invariant and document how to satisfy it.
- Accept the common tracked-file symlink pattern without permitting directory aliases or repository escapes.
- Let the legacy Codex implementation lane write inside its current isolated worktree while retaining a least-privileged read-only mode.
- Preserve caller-argument hardening, independent verification, and controlled integration.

## Non-Goals

- No dirty-path exception or special case for `tasks/`.
- No support for directory symlinks, junction aliases, external symlink targets, or broken links in write scope.
- No caller-controlled raw Codex sandbox, cwd, additional-directory, or approval policy.
- No new top-level read-only Delegation Spec execution mode.
- No release or version bump in this change.

## Delegation Spec And Skill

### Reviewer Focus

Add an optional `focus` property to the existing `review` object:

```yaml
review:
  reviewers: [correctness, systems]
  maxRounds: 2
  focus:
    - Verify cancellation cannot leave an updater process alive.
    - Check Windows path and process-tree behavior.
```

`focus` is an array of non-empty strings. It is host-authored guidance, not candidate data. The runtime includes it in correctness and systems reviewer prompts only. Fixer and verifier prompts do not receive it, and pipeline role specs continue to strip the complete `review` block.

This is an additive schema change. Existing specs remain valid and the protocol marker remains `1.1.0`.

### Exact Skill Contract

The delegate skill will document and demonstrate:

- verification command `args`, not `argv`;
- `network: "denied" | "allowed"`;
- per-command timeouts from 1 ms through 1,800,000 ms;
- edit attempt timeouts from 600,000 ms through 1,800,000 ms;
- string-only ordered `producerPreferences`;
- optional `producerOverrides: { model, reasoningEffort }`;
- optional `review.focus` for non-commandable reviewer concerns.

The skill will stop implying that arbitrary undocumented fields belong in `review`.

### Clean Checkout

The runtime keeps rejecting every tracked or unignored checkout change before an attempt and before integration. The skill will tell the architect to commit tracked planning changes before delegation. Git-ignored local planning files remain harmless because they do not appear in the clean-status check.

This avoids weakening base identity, candidate comparison, and controlled integration for a convenience exception.

## Symlink Precondition

The nested-repository scan already receives `git ls-files --stage -z`. It will parse both gitlinks and tracked symlink modes from that output.

When an allowlist-overlapping directory entry is a filesystem symlink, the scan accepts it only when all of these conditions hold:

1. The path is tracked with Git mode `120000`.
2. Resolving the link succeeds.
3. The canonical target is contained by the canonical checkout root.
4. The target is a regular file.
5. The target is neither the checkout's `.git` entry nor a path below it.

The scanner checks the target once and never traverses it. A link to an internal regular file therefore cannot create recursive discovery. A link to the checkout root, `.git`, another directory, an external path, a missing path, or a cycle remains rejected.

Containment uses normal path-boundary comparison on POSIX and case-insensitive normalized comparison on Windows. When Git materializes a symlink blob as an ordinary file because `core.symlinks=false`, the existing ordinary-file behavior remains unchanged.

Unsafe symlinks retain the existing `nested-repository` result so this repair does not expand the external failure vocabulary. Unexpected filesystem errors retain `nested-repository-scan-failed` and fail closed.

The authoritative candidate checks remain unchanged: a Producer cannot use an accepted link to mutate an out-of-allowlist tracked target and still pass structural verification.

## Legacy Codex Wrapper

`run-codex-isolated.sh` gains a wrapper-private leading option:

```text
--lane-mode edit|read-only
```

The default is `read-only` for existing direct callers. The wrapper consumes the option before invoking Codex and maps it as follows:

- `edit` -> `--sandbox workspace-write`
- `read-only` or omitted -> `--sandbox read-only`

The wrapper resolves its physical current directory and injects `--cd` with that value. The lane host must therefore enter the isolated worktree before invoking the wrapper. Callers cannot supply another root.

Raw `--sandbox`, `--cd`, `--add-dir`, approval bypasses, dangerous modes, feature enables, and sandbox/approval config keys remain rejected. The wrapper remains the sole authority for workspace and sandbox selection. Invalid or repeated private mode selectors fail before Codex starts.

The Claude Code and OpenCode legacy implementer definitions will pass `--lane-mode edit` and remove raw `--sandbox` and `--cd` arguments. Read-only direct analysis remains least-privileged by default.

## Testing

Tests are added failing-first at the narrowest public seams:

- Schema validation accepts non-empty `review.focus` and rejects malformed focus values.
- Reviewer prompt tests prove focus reaches both reviewer roles but not fixer or verifier prompts.
- Skill contract tests pin `args`, network tokens, timeout bounds, producer preference and override shapes, reviewer focus, and clean-checkout guidance.
- Real-Git precondition tests accept a tracked link to an internal regular file in a primary checkout and a linked worktree.
- Real-Git precondition tests continue rejecting external links, internal directory links, broken links, and untracked or ignored links in write scope.
- Fake-Codex tests pin default read-only mode, explicit edit mode, physical cwd injection, invalid mode rejection, and continued denial of raw security overrides.
- Lane contract tests pin `--lane-mode edit` and the absence of contradictory raw sandbox/cwd arguments in both implementer definitions.

Source changes under `src/` require regeneration of `runtime/server.mjs`. The change also updates `CHANGELOG.md` under Unreleased and records the dogfood regressions in `scratchpad.md`.

## Verification

Run, in order:

1. Focused Vitest files for schema, role prompts, repository preconditions, isolated scripts, and lane contracts.
2. `npx tsc --noEmit`.
3. `npx vitest run`.
4. `bash scripts/validate-release.sh` to verify generated runtime parity and shell/release gates.

The final review checks the complete diff for schema/runtime parity, symlink escape regressions, caller-controlled sandbox expansion, POSIX and Windows behavior, and stale generated assets.
