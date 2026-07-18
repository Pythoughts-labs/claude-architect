## Dogfood regressions - 2026-07-17 (v0.18.0 delegate lifecycle report)

- Delegation Spec prose must be tested against the closed schema: `args`, `network: denied|allowed`, both timeout ceilings, string Producer preferences, `producerOverrides`, and reviewer focus must remain executable examples.
- Clean-checkout failures must name tracked planning files and the delegate skill must require committing them; no skip-worktree workaround is permitted.
- A tracked package-file symlink to a contained repository file must pass preflight in primary and linked worktrees, while external, directory, broken, ignored, and `.git` targets remain rejected.
- The legacy Codex implementer command must execute through a wrapper-owned `workspace-write` mode; fake argv tests must fail if the wrapper reverts to an implicit read-only sandbox or accepts raw sandbox/cwd overrides.

## Dogfood regressions - 2026-07-17 (delegation contract repair session)

- Lane-owned dependency materialization must not enter candidate scope or discard otherwise valid Producer edits; a Pi implementation lane completed Task 1 with focused tests, typecheck, and the full suite green, but its adapter discarded the verified candidate after classifying its own temporary `node_modules` symlink as Producer output.
- Git index path normalization must preserve literal POSIX backslashes; otherwise tracked `a\\b` can collide with ignored or untracked `a/b`.
- Only resolution-time `ENOENT`, `ENOTDIR`, and `ELOOP` symlink errors may downgrade to unsafe-link; post-`realpath` target failures and races must remain scan failures.
- Split `-c`/`--config` parsing must validate the would-be value before advancing so forbidden lane, sandbox, or cwd options cannot hide behind a config flag.
