# Vendored Superpowers skills

Upstream: [obra/superpowers](https://github.com/obra/superpowers) — "Core skills
library for Claude Code", © Jesse Vincent, MIT (see `LICENSE`).
Vendored version: **6.2.0**. Snapshot taken 2026-07-26.

## Why these files are here

Claude Architect launches every Producer in an isolated Git worktree under a
per-attempt `HOME`. A superpowers install in the operator's home directory is
therefore unreachable from inside an attempt. These files ship inside the plugin
so the runtime can hand each edit-lane Producer an absolute, always-present path
to the procedures it is expected to follow.

Skill bodies are copied **verbatim and are never edited** — that is upstream's
first porting rule. Everything Claude Architect adds lives in its own bootstrap
text (`src/producers/skill-bootstrap.ts`), never inside a `SKILL.md`.

## What is included

| Skill | Files |
| --- | --- |
| `test-driven-development` | `SKILL.md`, `writing-good-tests.md` |
| `systematic-debugging` | `SKILL.md`, `root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`, `condition-based-waiting-example.ts`, `find-polluter.sh` |
| `verification-before-completion` | `SKILL.md` |

Each skill ships exactly the companion files its own body references. Upstream
authoring artifacts that no shipped body references are omitted:
`systematic-debugging/CREATION-LOG.md`, `test-pressure-1.md`,
`test-pressure-2.md`, `test-pressure-3.md`, `test-academic.md`.

## What is deliberately excluded, and why

A Producer is untrusted and runs one bounded attempt. Skills that assume a human
partner, a reviewer relationship, or the authority to dispatch agents and land
branches contradict Claude Architect's trust invariants, so they are neither
vendored nor offered:

| Upstream skill | Invariant it would break |
| --- | --- |
| `dispatching-parallel-agents`, `subagent-driven-development` | no nested delegation |
| `requesting-code-review`, `receiving-code-review` | implementers never review their own work; review is an independent pipeline role |
| `finishing-a-development-branch` | only a human accepts a candidate; `src/integrate/` owns apply |
| `using-git-worktrees` | the attempt already runs inside a linked worktree |
| `brainstorming` | there is no human in the Producer loop |
| `writing-plans` | a plan-only run with zero edits is a failed run; the Delegation Spec *is* the plan. Used architect-side instead. |
| `executing-plans`, `using-superpowers`, `writing-skills` | host-loop skills, not attempt procedures |

`using-superpowers/SKILL.md` is additionally inapplicable by upstream's own
terms: it opens with `<SUBAGENT-STOP>` — "if you were dispatched as a subagent to
execute a specific task, ignore this skill." A Producer is exactly that subagent.
Claude Architect ships its own task-scoped bootstrap instead of injecting it.

## Re-syncing

1. Clone or update upstream and check out the release you intend to ship.
2. Copy each file listed under "What is included" over the copy here, unedited.
3. Re-run the reference check: no shipped body may name an excluded skill, and
   every file a shipped body references must itself be shipped.
4. Update the version and snapshot date at the top of this file.
5. Run `npx vitest run`, then `bash scripts/validate-release.sh`.
