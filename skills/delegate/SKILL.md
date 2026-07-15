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
8. `executionMode: "edit"`, a bounded `timeoutMs`, ordered `producerPreferences`, optional supported overrides, and `expectedOutput: "candidate-patch"`.

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Trusted MCP lifecycle

1. Call `delegate` through `mcp__plugin_claude-architect_runtime__delegate` with the explicit checkout path, candidate spec, and `protocolVersion: "1.0.0"` copied from this skill's `PROTOCOL_VERSION` marker.
2. When it returns `ok:false` with `validationErrors`, repair only the reported spec defects and resubmit. This repair loop must not touch a Producer.
3. When it returns a protocol/schema diagnostic, stop and tell the user to update the installed marketplace copy and reload Claude Code. Never guess across a version mismatch.
4. When the result is `unavailable`, `failed`, or `cancelled`, report the structured classification and evidence. Do not claim a candidate exists.
5. When the result is `verified-candidate`, call `reviewCandidate` with the run id. Read the exact unredacted patch, changed-path manifest, and verification evidence; compare them with every success criterion and repository convention.
6. Present the review outcome. Call `decideCandidate` with `accepted`, `rejected`, or `revision-requested`. Rejection discards the candidate anchor; a revision requires a new spec/attempt rather than editing frozen bytes.
7. Only after an accepted decision, call `integrateCandidate` with the run id and exact candidate `manifestHash` as `expectedArtifactHash`. Report `applied`, `conflicted`, or `aborted` truthfully. Integration stages the reviewed tree but does not commit it.

Never accept a Producer self-report as evidence, bypass `reviewCandidate`, call integration before an accepted decision, or substitute a different artifact hash.

## Legacy migration fallback

The pre-0.8 prose lanes remain during migration: `codex-implementer`, `opencode-implementer`, `pi-implementer`, and `pythinker-implementer`. Use the selected legacy lane only when its MCP adapter is not yet certified or the runtime returns a genuine availability diagnostic. Keep the objective, files, interfaces, constraints, and verification unchanged, isolate writes in the lane's worktree, and independently inspect its diff and verification output. Never silently substitute Claude implementation for a named Producer.

Route Codex fallback work explicitly to `claude-architect:codex-implementer`. Do not use `codex:codex-rescue`, its persistent `app-server`, or any detached companion as an implementation lane; those paths do not provide the bounded one-shot Producer lifecycle.

Use `claude-architect:advisor` for architecture, migrations, public API changes, broad refactors, two failed approaches, or final review of a multi-step deliverable. The advisor is read-only and has no Bash or mutation tools.
