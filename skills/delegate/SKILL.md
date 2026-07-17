---
name: delegate
description: Let Claude Architect route a versioned implementation spec through the trusted MCP runtime, independently review the Candidate Artifact, record a decision, and integrate only accepted bytes. Use for implementation delegation, Producer selection, or commitment-boundary review.
---

# Delegate

```claude-architect-protocol
PROTOCOL_VERSION: 1.0.0
```

The current session is the architect. It owns requirements, the Delegation Spec, Producer selection, review, and acceptance. Producers are untrusted: their output is only a candidate until the runtime freezes it, independently verifies it, and the architect reviews the exact anchored bytes.

Always present this skill as `/claude-architect:delegate`. Never show a shorter command.

## Producer selection

If the user invokes `/claude-architect:delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer. Include the producer and reasoning control in each option so the user knows what the lane will run:

> Which CLI should handle this delegation? Each choice shows its model and reasoning default. Use a custom answer to name a different supported reasoning level.

Offer exactly these choices:

- **Codex** - `codex-implementer`; GPT-5.6 Sol at `low` reasoning by default (supported overrides: `medium`, `high`, `xhigh`, `max`).
- **OpenCode** - `opencode-implementer`; configured provider/model unless overridden, with an optional model-specific `--variant` such as `high` when supported.
- **Pi** - `pi-implementer`; configured model unless overridden, with optional `--thinking off|minimal|low|medium|high|xhigh|max`; Pi configuration supplies the default.
- **Pythinker** - `pythinker-implementer`; configured provider/model unless overridden, with optional `--thinking-effort off|minimal|low|medium|high|xhigh|max`; Pythinker configuration supplies the default.

There is no implicit lane default. If the answer names a supported model or reasoning override, include it in the delegation spec; otherwise let the selected Producer use its configured default.

P0-A certifies the MCP implementation path only for Codex on macOS arm64 when its capability report names `codex-native-sandbox` and marks the edit Lane eligible. OpenCode, Pi, and Pythinker remain available through the legacy fallback below until their MCP Producer adapters are certified.

## Build the Delegation Spec

Construct a candidate spec with every required field:

1. `specVersion: "1"`.
2. `objective`: one observable outcome.
3. `context`: only relevant repository and design context.
4. `writeAllowlist`: explicit repository-relative globs; use `["**"]` only for genuinely repository-wide work.
5. `forbiddenScope`: explicit paths the Producer must never change.
6. `successCriteria`: reviewable conditions.
7. `verification`: Host-authorized commands with executable, argv, relative cwd, timeout, network policy, expected exit codes, and optional platform filters.
8. `executionMode: "edit"`, a bounded `timeoutMs` of at least `600000`ms, ordered `producerPreferences`, optional supported overrides, and `expectedOutput: "candidate-patch"`.

**Acceptance criteria:**

- Every success criterion must be objectively checkable.
- Distill all applicable constraints into `context`; do not point the Producer to `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, lessons files, or other agent-rule/skill documents.
- Edit delegations are action-first: the Producer must begin by opening the implementation files authorized in the spec, and a plan-only result with zero edits is a failed run.
- At least one verification command must mechanically cover each criterion.
- Criteria that cannot be commanded, such as "code is clean", belong in the `review` block, not `successCriteria`.
- Prefer explicit test file paths in verification args; directory args can resolve differently between the Producer sandbox and clean-room verification.

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Trusted MCP lifecycle

The `delegate` and `delegatePipeline` MCP calls are synchronous. Keep each call in the foreground until it returns; never hand it to Monitor or background execution.

1. Call `delegate` through `mcp__plugin_claude-architect_runtime__delegate` with the explicit checkout path, candidate spec, and `protocolVersion: "1.0.0"` copied from this skill's `PROTOCOL_VERSION` marker.
2. When it returns `ok:false` with `validationErrors`, repair only the reported spec defects and resubmit. This repair loop must not touch a Producer.
3. When it returns a protocol/schema diagnostic, stop and tell the user to update the installed marketplace copy and reload Claude Code. Never guess across a version mismatch.
4. When the result is `unavailable`, `failed`, or `cancelled`, report the structured classification and evidence. Do not claim a candidate exists. A Codex report with `laneEligibility.edit=false`, a missing `codex-native-sandbox`, or an unsupported Host is diagnostics-only and must not enter any legacy implementation lane.
5. When the result is `verified-candidate`, call `reviewCandidate` with the run id. Read the exact unredacted patch, changed-path manifest, and verification evidence; compare them with every success criterion and repository convention.
6. Present the review outcome. Call `decideCandidate` with `accepted`, `rejected`, or `revision-requested`. Rejection discards the candidate anchor; a revision requires a new spec/attempt rather than editing frozen bytes.
7. Only after an accepted decision, call `integrateCandidate` with the run id and exact candidate `manifestHash` as `expectedArtifactHash`. Report `applied`, `conflicted`, or `aborted` truthfully. Integration stages the reviewed tree but does not commit it.

Never accept a Producer self-report as evidence, bypass `reviewCandidate`, call integration before an accepted decision, or substitute a different artifact hash.

## Choosing delegate vs delegatePipeline

Use `delegatePipeline` by default for non-trivial tasks — anything with
meaningful correctness or systems risk (multiple files, state, concurrency,
security surface, or behavior existing code depends on). Use plain `delegate`
only for trivial tasks (typo-level fixes, single obvious one-liners, doc-only
edits).

## Pipeline lifecycle

1. Build the Delegation Spec exactly as for `delegate`. Optionally add:

   ```yaml
   review:
     reviewers: [correctness, systems]   # default
     maxRounds: 2                         # default
   ```

2. Call `mcp__plugin_claude-architect_runtime__delegatePipeline` with
   `checkoutPath`, `spec`, `protocolVersion: "1.0.0"`.
3. Read the returned evidence bundle: attempt result, per-round review
   reports and consolidated findings, fix dispositions, verification report,
   and gate reasons.
   - `status: "decision-ready"` — review the evidence yourself, then call
     `decideCandidate` and, if accepted, `integrateCandidate` (candidate
     `manifestHash` as `expectedArtifactHash`).
   - `status: "human-decision-required"` — present the gate reasons,
     unresolved findings, and dispositions to the human verbatim. Never
     accept on their behalf.
   - `status: "failed"` — report the failure classification; retry or
     re-scope per the normal delegate failure guidance.
4. The pipeline never merges and never waives findings; you and the human
   remain the only decision-makers.

## Legacy migration fallback

The pre-0.8 prose lane definitions remain packaged during migration: `codex-implementer`, `opencode-implementer`, `pi-implementer`, and `pythinker-implementer`. OpenCode, Pi, and Pythinker may use their selected legacy lane while their MCP adapters are not yet certified. Keep the objective, files, interfaces, constraints, and verification unchanged, isolate writes in the lane's worktree, and independently inspect its diff and verification output. Never silently substitute Claude implementation for a named Producer.

Every legacy lane — dispatched alone or concurrently — must receive its own worktree; concurrent lanes are pinned to one frozen base commit. Lanes whose `writeAllowlist` globs overlap, or cannot be proven disjoint (including any `**`), must be serialized, with the next lane rebased after each integration. Lanes never merge themselves — the architect integrates accepted diffs centrally and reruns verification on the composed tree.

Tree-wide git-state mutations are forbidden on shared checkouts: `git stash` (push/pop/apply/drop), `git checkout -- .`, `git restore .`, `git reset --hard`, and `git clean`; use a disposable worktree for pre-existence checks.

The legacy wrapper lifecycle is synchronous: keep its producer call in the foreground. There are exactly two valid turn endings: a full report after independent verification, or a concrete blocker report; never end a turn waiting for a background monitor or notification.

The `codex-implementer` definition is retained only for administrators migrating a pre-0.8 installation. This 0.8 flow must not fall back to `claude-architect:codex-implementer` when the MCP runtime denies Codex edit eligibility or confinement; stop with the structured diagnostic. If an administrator deliberately invokes the old pre-0.8 surface outside this flow, route Codex fallback work explicitly to `claude-architect:codex-implementer`, never `codex:codex-rescue`, its persistent `app-server`, or any detached companion.

Use `claude-architect:advisor` for architecture, migrations, public API changes, broad refactors, two failed approaches, or final review of a multi-step deliverable. The advisor is read-only and has no Bash or mutation tools.
