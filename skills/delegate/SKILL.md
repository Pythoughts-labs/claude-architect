---
name: delegate
description: Delegate implementation, exploration, and review from an Opus or Fable architect session to the cheapest adequate subagent or CLI lane. Use when splitting work, writing subagent specs, selecting codex-implementer/opencode-implementer/pi-implementer/pythinker-implementer, controlling token cost, or consulting claude-advisor.
---

# Delegate

The session is the architect and should run Claude's strongest available tier (Fable 5, or Opus). It owns requirements, decomposition, interfaces, routing, and acceptance. Delegate implementation and broad exploration; keep decisions and review with the architect.

## Cost discipline

- Emit judgment, not volume. Hand off implementation, tests, boilerplate, and mechanical edits.
- Keep context lean. Delegate broad searches and return conclusions rather than raw output.
- Reason once, then put the decision into a complete delegation spec.

## Lanes

| Lane | Invoke | Route here when |
|---|---|---|
| Cloud / default | `codex-implementer` | Routine or correctness-sensitive implementation through GPT-5.6 Sol and Codex CLI. This is the default implementation lane. |
| Provider pool | `opencode-implementer` | The right model lives behind an OpenCode credential the other lanes can't reach (Zen/Go Kimi/GLM/DeepSeek, MiniMax coding plan). Pass the provider/model explicitly. |
| Local / $0 | `pi-implementer` | Routine work suitable for a local open-weight model through Pi. Pass the model explicitly. |
| In-house / autonomous | `pythinker-implementer` | A trusted spec should run unattended through Pythinker `--yolo`. Pass the provider/model explicitly. |
| Exploration | OpenCode `explore` or Claude Code `Explore` | Broad read-only codebase searches and implementation-surface mapping. |
| Judgment | Opus architect or `claude-advisor` | Architecture, migrations, API shapes, major refactors, repeated failures, and final review of multi-step work. |

Use Codex by default. Prefer OpenCode when the target model is only reachable through its provider pool. Prefer Pi when local execution and zero marginal cost matter. Prefer Pythinker when full unattended execution is the defining requirement. Race independent lanes only when the added implementation is worth the cost, and isolate races in separate worktrees because concurrent writers must not touch the same files.

Route all delegated Codex work explicitly to `claude-master:codex-implementer`, including work started from long-running flows such as `/goal`. Do **not** use `codex:codex-rescue`, `codex-companion.mjs`, or `codex app-server` as an implementation lane: the official rescue companion keeps a detached app-server broker alive for the Claude session, and fresh threads can leave configured MCP workers such as `node_repl` attached to that broker after the task reports completion. The one-shot lane ignores user config, runs ephemerally, and terminates its isolated process group when the task ends.

If a CLI lane returns `unavailable` or `timeout`, reroute the unchanged spec and report the substitution. Never silently implement inside a wrapper agent that promised a different producer.

## Spec contract

Every delegation prompt contains:

1. **Objective**: the observable outcome.
2. **Files**: exact paths to inspect, create, or modify.
3. **Interfaces**: signatures, types, commands, or API shapes to preserve.
4. **Constraints**: conventions, safety boundaries, and exclusions.
5. **Verification**: exact commands and expected evidence.

If the spec cannot name these, resolve the ambiguity before delegating.

## Parallelism

Launch independent read-only investigations or tasks with disjoint files in parallel. Keep dependent work and same-file edits serial. Do not race writing agents in one working tree.

## Commitment boundaries

The architect may run on Opus and own these judgments directly, or consult `claude-advisor`. Use one of those paths before architecture decisions, migrations, public API changes, or broad refactors; after two failed approaches; and once before accepting a multi-step deliverable. Pass the decision, constraints, and options considered when consulting the advisor.

## Acceptance

A lane report is a claim, not evidence. Before accepting delegated work, the architect must:

1. Read the actual diff.
2. Check it against the spec and project conventions.
3. Re-run or independently confirm the verification command.
4. Return a corrected spec to the lane when the implementation is wrong.

Never accept “should work,” a producer's self-report, or test output without reviewing the resulting code.
