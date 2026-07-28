# PR 23 CI and Review Cleanup Design

Date: 2026-07-27
Status: approved
Pull request: #23 (`feat/vendor-codex-skill`)

## Goal

Finish the existing direct-Codex-skill pull request in place by updating its
cross-platform CI matrix, repairing the macOS bootstrap-test race, and
addressing every unresolved review finding without changing the plugin's
runtime, protocols, release version, or trust model.

## Ground Truth

- The pull request currently has seven unresolved CodeRabbit threads and a
  `CHANGES_REQUESTED` review.
- The current `macos-14` CI leg failed
  `runtime bootstrap > forwards SIGIO to a re-executed server` because the test
  can send `SIGIO` after the child publishes its PID but before the bootstrap
  parent has installed its forwarding handlers. macOS discards an early
  `SIGIO`, so the child remains alive and the test times out.
- The focused bootstrap smoke test passes locally, which is consistent with a
  scheduler-dependent readiness race rather than a deterministic product
  failure.
- GitHub's current hosted-runner contract uses `macos-15` for the standard
  Apple Silicon macOS 15 image. `windows-latest` currently exercises the x64
  Windows Server 2025 image with the MSVC x86/x64 toolchain needed by this
  repository.
- The workflow's existing `actions/checkout@v7`,
  `actions/setup-node@v7`, and `actions/upload-artifact@v7` majors are current.
  The project remains on Node 22.
- Current Codex CLI documentation treats `--full-auto` as deprecated
  compatibility syntax, documents explicit sandbox selection, streams progress
  and diagnostics to stderr, and accepts a positional prompt for both a new
  `exec` run and `exec resume`.

The supporting first-party-source review is recorded in
`docs/research/2026-07-27-github-actions-runner-design.md`.

## Authorized Scope

Repository changes are limited to:

- `.github/workflows/ci.yml`;
- `skills/codex/SKILL.md`;
- `tests/runtime/plugin-wiring.test.mjs`;
- `tests/runtime/bootstrap.smoke.test.ts`;
- the pull request's existing `README.md` and `CHANGELOG.md` additions;
- this design and its supporting research note;
- a test-first implementation plan derived from this design.

The pull request body and review-thread replies may be updated after the
verified branch is pushed so they describe the final bytes accurately.

No `src/`, generated `runtime/`, schema, protocol, dependency, plugin-version,
or release-version change is authorized or required by this design.

## CI Runner Design

Use this three-platform matrix:

```yaml
matrix:
  os: [macos-15, ubuntu-latest, windows-latest]
```

Only `macos-14` changes to `macos-15`.

- Pin macOS 15 because `macos-latest` no longer means macOS 15.
- Preserve the current Apple Silicon architecture rather than add an
  Intel-only compatibility lane with no repository contract behind it.
- Keep `windows-latest` so CI continuously checks GitHub's supported current
  Windows image. Do not pin `windows-2025` or add `windows-2022` without a
  Windows-generation or Visual Studio 2022 compatibility requirement.
- Keep Node 22 and the existing action majors unchanged.

## macOS Bootstrap-Test Repair

Repair the test's readiness protocol rather than adding a sleep or weakening
the timeout.

The re-executed test server will use a harmless first forwarded `SIGIO` as a
readiness acknowledgement while it is unarmed. The test will retry `SIGIO`
until that acknowledgement exists. It will then arm the server through a
separate temporary marker and send the decisive `SIGIO`, which must still be
forwarded, recorded, and reflected as the expected bootstrap exit status.

This establishes both necessary conditions:

1. the bootstrap's forwarding handler is demonstrably installed before the
   decisive assertion; and
2. the decisive signal must traverse the bootstrap-to-server path for the test
   to pass.

Polling is bounded and condition-based. There is no arbitrary delay and no
production-code change. The test must be mutation-checked by temporarily
breaking the forwarding expectation and observing the focused test fail before
the final implementation is restored.

## Review-Finding Resolution

The implementation will account for all seven unresolved threads:

1. Replace the inaccurate phrase "isolated production" with "isolated
   worktree" in both README and changelog text.
2. Remove `--full-auto` from the skill rather than preserve deprecated hidden
   compatibility syntax. Use explicit `--sandbox read-only`,
   `--sandbox workspace-write`, or `--sandbox danger-full-access`.
3. Include `--skip-git-repo-check` consistently in the documented new-run,
   alternate-directory, and resume commands because the skill requires Codex
   to operate in bounded harness and plugin contexts that may not expose the
   checkout as a normal trusted repository.
4. Stop discarding stderr. Host integrations must capture it separately,
   retain failures and warnings, and may summarize progress only after the
   command's exit status and diagnostics are known.
5. Prefer positional prompt arguments for manual new and resumed runs. For
   harnesses that might leave stdin open, require an explicitly closed stdin:
   a process API with stdin ignored is normative, with accurate POSIX,
   PowerShell, and `cmd.exe` shell forms documented.
6. Extend plugin-wiring contract tests so the canonical examples prove explicit
   sandbox selection, the repo-check flag, preserved stderr, positional resume,
   and cross-platform closed-stdin guidance.
7. Strengthen the delegation-boundary test to prove the verified delegation
   lane remains the only reviewed and independently verified path, while the
   direct Codex convenience skill never claims that status.

The pull request description must no longer claim that the final skill is
byte-identical to the older upstream text once these executable-contract fixes
land.

## Error Handling and Cross-Platform Constraints

- A shell example must not imply that POSIX redirection works in PowerShell or
  `cmd.exe`.
- Stdin closure must not also suppress stderr.
- A nonzero Codex exit remains a failure even when stdout contains a final
  message.
- The bootstrap test must fail with a bounded, actionable timeout when its
  readiness acknowledgement never appears.
- Windows CI must still build and upload `native/bin/win32-job-kill-x64.exe`;
  the matrix change must not alter the conditional MSVC or artifact steps.
- No review thread is resolved until its fix exists on the verified remote head
  and its reply identifies the change.

## Test-First Implementation Order

1. Add or strengthen narrow contract assertions for each Codex-skill review
   finding and confirm they fail against the current skill.
2. Add the condition-based bootstrap test protocol and mutation-check that the
   focused test detects broken forwarding.
3. Make the smallest skill, README, changelog, and workflow edits that satisfy
   those tests.
4. Run focused tests, then the repository-wide verification gates.
5. Push one reviewed branch head and require all checks and review surfaces to
   evaluate that exact SHA.

## Verification

Local verification:

```bash
npx tsc --noEmit
npx vitest run
bash scripts/validate-release.sh
claude plugin validate .
```

Also run focused bootstrap and plugin-wiring tests during red/green development,
inspect the complete diff, and confirm `git status` contains only explained
changes.

Remote verification on the final pushed SHA:

- `macos-15` green;
- `ubuntu-latest` green;
- `windows-latest` green, including the x64 helper build and artifact upload;
- substantive CodeRabbit review complete with no unresolved actionable
  findings;
- every review thread replied to and resolved only after its fix is present;
- pull request metadata and description accurately describe the final branch.

The pull request is not merged by this task.

## Acceptance Criteria

- The CI matrix is exactly
  `[macos-15, ubuntu-latest, windows-latest]`.
- The `SIGIO` smoke test waits on observable forwarding readiness and remains
  capable of failing when signal forwarding is broken.
- All seven review findings are fixed and covered at the narrowest appropriate
  layer.
- The direct Codex skill uses current CLI semantics and does not weaken or
  misrepresent the verified delegation boundary.
- All local and remote verification gates pass on one exact commit.
- No unrelated user change is modified or discarded.
