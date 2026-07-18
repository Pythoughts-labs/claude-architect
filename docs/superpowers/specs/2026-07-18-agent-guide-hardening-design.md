# Agent Guide Hardening Design

## Goal

Make `AGENTS.md` concise, internally consistent, and reliable for Claude, Codex, Pi, OpenCode, and other coding agents without changing Claude Architect's established trust, security, packaging, or release policy.

## Scope

The implementation changes only `AGENTS.md`. It preserves the user's uncommitted approval rule for swarm-style workflows. No runtime, schema, test, plugin, or release file changes are authorized.

## Structure

Reorganize the guide so agents encounter rules in operational order:

1. project purpose and instruction precedence;
2. mandatory operating rules, including code discovery and approval gates;
3. trust invariants and architecture boundaries;
4. security, isolation, testing, release, and Git requirements;
5. an explicit definition of done.

Operational requirements must not appear as numbered sources of truth.

## Policy Decisions

- Preserve all existing policy intent unless two rules conflict.
- Require `codebase-memory-mcp` for code exploration when available. If unavailable, state that fact and use filesystem search.
- Require explicit user approval before any dynamic, ultra, or equivalent workflow that immediately launches a large subagent swarm. Ordinary bounded single-agent or small parallel work remains governed by normal task planning.
- Preserve the requirement to fix every discovered lint failure, test failure, or flaky test. If doing so exceeds authorized scope, stop and request expanded scope; never ignore the failure or report completion.
- Preserve human-only candidate acceptance, independent review, isolated Producer execution, fail-closed security behavior, cross-platform analysis, generated-runtime reproducibility, and release-version synchronization.
- Use direct `MUST`/`NEVER` wording only for mandatory behavior. Remove malformed numbering, duplicated statements, excess whitespace, and ambiguous pronouns.

## Verification

- Inspect the complete resulting file for missing policy and contradictory instructions.
- Inspect `git diff -- AGENTS.md` to ensure the user's uncommitted swarm-approval rule is preserved and only the authorized file is implemented.
- Check Markdown headings, lists, code fences, paths, commands, and version examples for structural correctness.
- Do not run runtime tests for a documentation-only edit unless repository hooks or validation expose a relevant failure.

## Acceptance Criteria

- `AGENTS.md` is valid, readable Markdown with no malformed numbered items.
- Sources of truth contain only sources of truth.
- MCP fallback, swarm approval, unrelated-failure handling, scope escalation, and completion gates are explicit.
- Existing trust, security, architecture, packaging, Git, and release guarantees remain materially unchanged.
- The implementation diff changes only `AGENTS.md`.
