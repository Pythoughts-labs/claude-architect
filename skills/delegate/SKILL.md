---
name: delegate
description: Let Claude Architect author an Autopilot Spec and drive the trusted runtime through isolated implementation, whole-branch review, policy-gated promotion, and a pull request ready for human review. Use for implementation delegation, Producer selection, or commitment-boundary review.
---

# Delegate

```claude-architect-protocol
PROTOCOL_VERSION: 2.0.0
```

The current session is the architect. It owns requirements, the Autopilot Spec, and Producer selection. Producers are untrusted: their output is only a candidate until the runtime freezes and independently verifies it. During autopilot, the trusted runtime alone evaluates hash-bound eligibility, records an `accepted` Candidate Decision with authority `autopilot-policy`, promotes eligible bytes to the workflow-owned feature branch, reviews the cumulative branch, and ships it to a pull request ready for human review. Only a human may merge or otherwise advance `main`.

Always present this skill as `/claude-architect:delegate`. Never show a shorter command.

## Agent selection

The delegated CLIs are the architect's **implementation agents** — the same subagent idiom Claude Code uses, except each agent launches an *untrusted Producer* through the trusted MCP runtime inside an isolated Git worktree. Present them as a selectable agent roster: the human picks one `subagent_type`, exactly one agent runs per attempt, and no agent may review or accept its own work.

| Agent (`subagent_type`) | Producer / model | Reasoning control |
| --- | --- | --- |
| `codex-implementer` | GPT-5.6 Sol (OpenAI Codex CLI) | `low` by default |
| `opencode-implementer` | OpenCode provider/model | optional `--variant` |
| `pi-implementer` | Pi configured model | optional `--thinking` |
| `pythinker-implementer` | Pythinker provider/model | optional `--thinking-effort` |

If the user invokes `/claude-architect:delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer. Include the producer and reasoning control in each option so the user knows what the lane will run:

> Which CLI should handle this delegation? Each choice shows its model and reasoning default. Use a custom answer to name a different supported reasoning level.

Offer exactly these choices:

- **Codex** - `codex-implementer`; GPT-5.6 Sol at `low` reasoning by default (supported overrides: `medium`, `high`, `xhigh`, `max`, `ultra`).
- **OpenCode** - `opencode-implementer`; configured provider/model unless overridden, with an optional model-specific `--variant` such as `high` when supported.
- **Pi** - `pi-implementer`; configured model unless overridden, with optional `--thinking off|minimal|low|medium|high|xhigh|max`; Pi configuration supplies the default.
- **Pythinker** - `pythinker-implementer`; configured provider/model unless overridden, with optional `--thinking-effort off|minimal|low|medium|high|xhigh|max`; Pythinker configuration supplies the default.

There is no implicit lane default. If the answer names a supported model or reasoning override, include it in the delegation spec; otherwise let the selected Producer use its configured default.

P0-A certifies the MCP implementation path only for Codex on macOS arm64 when its capability report names `codex-native-sandbox` and marks the edit Lane eligible. Eligible Linux Codex editing is tested; native Windows runtime supervision exists, but native Windows Codex editing is not certified. Other Producer/platform/backend combinations remain specific to their capability report.

## Build the Delegation Spec

Construct a candidate spec with every required field:

1. `specVersion: "1"`.
2. `objective`: one observable outcome.
3. `context`: only relevant repository and design context.
4. `writeAllowlist`: explicit repository-relative globs; use `["**"]` only for genuinely repository-wide work.
5. Optional `allowedTestDeletions`: repository-relative globs for test files the architect explicitly authorizes deleting; slices inherit this value unless they define their own.
6. `forbiddenScope`: explicit paths the Producer must never change.
7. `successCriteria`: reviewable conditions.
8. `verification`: Host-authorized command objects. Each verification command uses `args`, not `argv`; `network` is exactly `"denied"` or `"allowed"`; command `timeoutMs` must be 1..1800000; include a repository-relative `cwd`, expected exit codes, and optional platform filters. Verification runs in a disposable worktree, so writes to git-ignored paths (build caches, virtualenvs, `__pycache__`, `.pytest_cache`) are permitted by default and never fail a command; set the optional `allowedMutations: "none"` only when a command must be proven to write nothing at all.
9. `executionMode: "edit"`; attempt `timeoutMs` must be 600000..1800000; `producerPreferences` is an ordered array of Producer id strings; use optional `producerOverrides: { model?, reasoningEffort? }`; and set `expectedOutput: "candidate-patch"`.

**Acceptance criteria:**

- Every success criterion must be objectively checkable.
- Distill all applicable constraints into `context`; do not point the Producer to `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, lessons files, or other agent-rule/skill documents.
- Edit delegations are action-first: the Producer must begin by opening the implementation files authorized in the spec, and a plan-only result with zero edits is a failed run.
- At least one verification command must mechanically cover each criterion.
- Order verification commands exactly as the Host must execute them. When linting/formatting and type checking both apply, all lint and format gates must precede the final type-check gate, and verification formatters must use a non-mutating check mode (for example, `--check`); formatting rewrites belong in the Producer attempt before candidate freeze.
- The final type-check must cover ALL touched typed files, including every added or modified test file; never scope it only to `src/` when tests or other typed paths may change.
- Keep observable outcomes in `successCriteria`. Put reviewer-only, non-commandable concerns in `review.focus`; when present, `review.focus` must be a non-empty array of non-empty strings. No undocumented review keys are accepted.
- Prefer explicit test file paths in verification args; directory args can resolve differently between the Producer sandbox and clean-room verification.

**Verification preflight:** The runtime runs every verification command against clean HEAD in a disposable worktree before dispatch. Repair the spec if a command cannot start. A baseline failure unrelated to the task is an environment defect the architect repairs centrally before dispatching. Set `expectBaselineFailure: true` on any command that cannot pass at clean HEAD by design — one that reproduces the target bug, or one that exercises a file or test the candidate will create (it necessarily fails before that path exists).

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Build the Autopilot Spec

Wrap one or more Delegation Specs in the canonical Autopilot Spec:

1. Set `specVersion: "1"` and a lowercase, hyphenated `topic`.
2. Set `base` exactly to `{ remote: "origin", branch: "main" }`.
3. Put 1..32 ordered tasks in `tasks`. Each task needs a stable `id`, a single-line `commitMessage`, and a complete `delegation` spec built by the rules above.
4. Set `finalSuccessCriteria` and `finalVerification` for the entire cumulative workflow branch, not only the last task. The final evidence must cover every promoted commit and their interactions.
5. Set `shipping` to GitHub draft-PR shipping: `provider: "github"`, `draft: true`, `markReadyWhenRequiredChecksPass: true`, a 600000..3600000 `requiredChecksTimeoutMs`, and bounded PR title/body text.

Shipping v1 requires GitHub CLI 2.96 or newer, an authenticated GitHub HTTPS `origin`, a clean checkout based on `origin/main`, and configured required checks that can become green for the exact workflow head. Resolve these preconditions before calling the controller; it fails closed rather than changing remotes, inventing checks, or bypassing repository policy.

## Coordinator duties

When running multiple delegations, normalize reported blockers by phase, command id, and root cause. The moment two independent lanes report the same blocker, pause affected lanes and treat it as an architect-owned shared-environment defect. Reproduce it once against the clean baseline, fix it centrally, rerun the preflight to green, then resume or redispatch the unchanged specs. Never wait for remaining lanes to rediscover it, and never push shared-tooling fixes into individual Producer lanes.

**Repository precondition:** delegation and controlled integration require an exact clean checkout; tracked or unignored changes must be committed before delegation, including tracked planning files such as `tasks/todo.md`. Git-ignored local planning files do not affect the clean check. Do not use skip-worktree or assume-unchanged flags as a workaround.

## Trusted MCP autopilot lifecycle

Project-scoped permission settings become active only after the human grants Claude Code workspace trust. They can allow the three autopilot tools, but they cannot override managed `ask` or `deny` policy. “No mid-loop prompts” is therefore conditional: it applies only after workspace trust, when all three tool calls are allowed and no higher-precedence policy, controller halt, or ambiguity requires the human.

1. Call `autopilotStart` with `checkoutPath`, the complete Autopilot Spec as `spec`, and `protocolVersion: "2.0.0"` copied from this skill's marker. Do not attempt a workflow start against a dirty checkout.
2. If validation returns `validationErrors`, repair only the reported spec defects and resubmit. A protocol mismatch means the installed plugin must be updated and reloaded; never guess across versions. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined lane, fails closed with the structured diagnostic.
3. Record the returned `workflowId`. Call `autopilotStatus` with `checkoutPath`, that `workflowId`, and `protocolVersion: "2.0.0"` for read-only monitoring. Report only persisted phases and bounded progress supplied by the runtime; never infer completion from a phase name or Producer output.
4. After a host or process interruption, call `autopilotResume` with `checkoutPath`, the same `workflowId`, and `protocolVersion: "2.0.0"`. Resume replays durable observed state; it does not authorize a second workflow or waive a failed gate.
5. During autopilot, do not construct Autopilot Eligibility, synthesize a Candidate Decision, call separate review/decision/integration tools, run Git or `gh`, push, create or edit a PR, mark a PR ready, merge, or delete a branch. The controller owns policy, promotion, cumulative final review, exact-head push, draft-PR identity, required-check polling, ready transition, cleanup, and recovery.

The controller may proceed without a mid-loop prompt only while every eligibility and shipping gate remains objectively proven. Interpret terminal states exactly:

- `ready-for-human-review`: the workflow branch was pushed, the draft PR was proven for the expected head, configured required checks were green for that head, the PR was marked ready, and runtime cleanup completed. Review the cumulative PR evidence; only the human may merge or otherwise advance `main`.
- `human-decision-required`: ambiguity, a non-waivable finding, ownership mismatch, shipping uncertainty, or another fail-closed condition requires a human decision. Preserve the workflow branch, worktree, and evidence; do not improvise continuation.
- `failed`: the workflow ended without authority to ship. Present the durable reason and evidence. Do not claim the PR is ready or retry under altered policy.
- `cancelled`: cancellation is a durable terminal classification. Present preserved cleanup/evidence and do not resume it as if non-terminal; a human chooses any next action.

Autopilot is autonomous only up to a PR ready for human review. It never merges, deploys, releases, or deletes the remote feature branch. Successful cleanup removes temporary local workflow resources while retaining durable evidence and recovery records; fail-closed terminals retain what the runtime needs for inspection.

## Presenting workflow progress

Surface the workflow in the Claude Code subagent look and feel, but treat the card as presentation rather than evidence:

```text
▸ Autopilot · codex-implementer      workflow-owned branch
  Task    <3–5 word description>
  Model   GPT-5.6 Sol · reasoning low
  Phase   running-task      Workflow <workflowId>
```

Use one compact status line derived from `autopilotStatus`, for example `● running-task · task 1/2`. Use `◑` for `human-decision-required`, `✓` for `ready-for-human-review`, and `✗` for `failed` or `cancelled`. Never invent progress, display a Producer self-report as evidence, or equate policy acceptance with merge.

## Explicit manual fallback

Use the manual candidate lifecycle only when the human explicitly chooses it instead of autopilot. In that mode, call `delegate` or `delegatePipeline`, inspect the exact frozen evidence with `reviewCandidate`, obtain the human's Candidate Decision through `decideCandidate`, and use `integrateCandidate` only for an accepted, hash-matched candidate. Manual integration stages bytes in the human checkout and does not commit, push, open a PR, merge, deploy, or release. Never switch a halted autopilot workflow into the manual lifecycle implicitly.
