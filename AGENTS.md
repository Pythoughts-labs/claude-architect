# Agent Guide

## Project overview

Claude Architect is a cross-platform Claude Code plugin for verified delegation to Codex, OpenCode, Pi, and Pythinker. Claude authors a versioned Delegation Spec; the runtime launches an untrusted Producer in an isolated Git worktree, freezes its output as a Candidate Artifact, independently verifies it, and exposes the exact artifact for review and human-controlled integration. The repository also contains a strictly non-mutating advisor, cross-platform process supervision, crash recovery, bounded redacted logging, and Producer capability routing.

## Sources of truth (descending precedence)

1. JSON schemas and protocol constants in `schemas/` and `src/protocol/`.
2. Runtime behavior in `src/`, with generated packaged output in `runtime/`.
3. Contract and adversarial tests in `tests/`.
4. The delegation workflow in `skills/delegate/SKILL.md` and role definitions in `agents/`.
5. Plugin manifests in `.claude-plugin/` and user-facing documentation.

When prose conflicts with executable contracts, fix the prose or explicitly migrate the contract; do not silently make them disagree.

## Non-negotiable trust invariants

- Every implementation or repair attempt starts in fresh context and a fresh isolated worktree.
- Implementers cannot review, approve, or accept their own work.
- Independent reviewers evaluate frozen candidate bytes without sharing implementer context.
- Read-only roles cannot mutate files, Git state, processes, or external systems.
- Roles communicate through versioned specs, manifests, patches, findings, and other durable artifacts—not hidden conversational state.
- Verification is objective, recorded, and rerunnable; Producer claims are never evidence.
- Only the human can accept a candidate. Agents may recommend a decision but cannot make it for the human.
- Workflow state, decisions, evidence, and recovery data are durable across process failure.
- The final review covers the whole candidate branch, including cumulative interactions across attempts—not only the latest patch.

## Code discovery

This repository is indexed in the codebase-memory MCP server (project `Users-panda-Projects-active-claude-architect`). For any code exploration, use its graph tools first — `search_graph` to find symbols, `get_code_snippet` for exact symbol source, `trace_path` for call chains, `search_code` for graph-augmented text search, `get_architecture` for structure — before falling back to grep/glob/manual file reads. If the index is stale after large changes, re-run `index_repository`.

## Before making changes

- Read the relevant schema, implementation, tests, skill text, and recent Git history before editing.
- Inspect `tasks/lessons.md` and any active `tasks/todo.md` when those files exist.
- State the intended outcome, authorized scope, and verification method before a non-trivial change.
- Preserve unrelated user changes. Never assume a dirty worktree is disposable.
- Identify platform implications for macOS, Linux, and Windows and Producer-specific behavior.

## Scope discipline

Make the smallest change that satisfies the request. Do not reformat, rename, refactor, or clean up unrelated code. Every changed line must trace to an acceptance criterion. Record unrelated findings rather than fixing them opportunistically. When a required change exceeds the authorized scope, stop and request approval.

## Architecture boundaries

- `src/protocol/` and `schemas/` define versioned external contracts.
- `src/runtime/` owns attempt lifecycle, artifacts, state, recovery, redaction, and manifests.
- `src/producers/` owns capability probes, routing, and CLI adapters; adapters do not grant acceptance authority.
- `src/verify/` independently proves structural and project-level properties.
- `src/pipeline/` coordinates fresh-context implementation, review, repair, and gates.
- `src/integrate/` applies only accepted, hash-matched artifacts under repository locks.
- `src/platform/` encapsulates OS process and confinement behavior.
- `src/mcp/` exposes the trusted orchestration surface; keep handlers thin and validated.

Do not collapse these boundaries to make a test easier. Generated `runtime/` output must remain reproducible from source.

## Agent isolation

Treat every external agent as an untrusted Producer. Give it only the bounded spec and capabilities required for one attempt. Isolate concurrent writers in separate worktrees, prevent nested delegation, sanitize inherited configuration, and terminate complete process trees on cancellation or timeout. A failed confinement or eligibility probe must make the edit lane unavailable; never fall back to a less isolated path.

## Security requirements

- Validate all external inputs against the canonical schemas before use.
- Spawn processes with executable-plus-argv arrays, never interpolated shell command strings.
- Canonicalize paths and reject traversal, symlink escapes, repository escapes, and identity changes.
- Select executables through explicit allowlists and capability probes.
- Sanitize environments; pass only documented variables and never leak credentials into delegated contexts.
- Redact secrets, tokens, personal data, prompts, and sensitive argv values from bounded logs and tool output.
- Fail closed on ambiguity, unsupported platforms, missing confinement, malformed artifacts, verification failure, or state mismatch.

Never mock the component whose security property a test claims to prove.

## Plugin packaging

The plugin manifest exists only at `.claude-plugin/plugin.json`; do not add a duplicate root manifest. Claude Code components (`agents/`, `skills/`, `.mcp.json`, hooks, and runtime assets) live at the plugin root. Runtime references in packaged configuration must resolve through `${CLAUDE_PLUGIN_ROOT}` rather than checkout-specific or user-specific absolute paths.

Marketplace releases advance the minor version only (`0.3.0` → `0.4.0` → `0.5.0`); do not publish patch-version tags. Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README version badge, and `CHANGELOG.md` on exactly the same version. Run `bash scripts/validate-release.sh` before every release push, and never commit or push a release tag when validation fails.

## Development commands

```bash
npx tsc --noEmit
npx vitest run
bash scripts/validate-release.sh
claude plugin validate .
```

Enable the repository push gate once per clone:

```bash
git config core.hooksPath .githooks
```

`.githooks/pre-push` runs TypeScript and the full Vitest suite for every push. Pushes to `main` or a tag also run release validation and check the latest `origin/main` CI conclusion. Treat red cross-platform CI as stop-the-line.

## Testing requirements

Add the narrowest test that would fail without the change, then cover the relevant layers:

- unit tests for pure validation, policy, and transformation logic;
- contract tests for schemas, manifests, adapters, and MCP inputs/outputs;
- integration tests for worktrees, artifacts, recovery, verification, and controlled integration;
- adversarial tests for path, environment, process, redaction, race, and trust-boundary attacks;
- opt-in real-adapter smoke tests for supported Producer/platform combinations.

Exercise unhappy paths and fail-closed behavior. Do not mock the component whose security property is being proven. Save every bug discovered during delegation as a dogfood regression test description in `scratchpad.md`.

## Schema changes

Treat schemas as public, versioned APIs. Update the canonical schema, TypeScript types, validators, fixtures, contract tests, runtime compatibility checks, skill protocol marker, and documentation together. Prefer additive compatible changes; for breaking changes, increment the appropriate protocol/spec version and provide an explicit mismatch diagnostic. Never accept unknown semantics merely to preserve compatibility.

## Error handling

Return structured, stable classifications with actionable redacted diagnostics. Preserve the distinction among unavailable, invalid, failed, cancelled, timed out, conflicted, and aborted outcomes. Do not catch and ignore errors, convert failures into apparent success, or trust a Producer's self-report. Cleanup failures must not erase the primary outcome, but must remain visible in evidence.

## Git safety

Do not run destructive commands such as `git reset --hard`, `git clean -fdx`, forced checkout, force-push, broad recursive deletion, or history rewriting. Never discard user changes. Use isolated worktrees, repository locks, exact object IDs, and candidate refs. Integration must enforce an expected-old-head/base guard: abort if the checkout HEAD no longer equals the reviewed candidate's base. Revalidate the artifact hash, anchor, tree, status, and worktree before reporting success.

Do not add Codex co-author trailers or generated-by footers to commits or pull requests.

## Documentation duties

Update user-facing instructions whenever commands, permissions, compatibility, data retention, trust guarantees, or limitations change. Keep examples executable and distinguish certified, tested, legacy, and unsupported paths precisely. Record release-visible changes in `CHANGELOG.md` and keep all release version surfaces synchronized.

## Definition of done

- The requested behavior and trust invariants are satisfied with a minimal diff.
- Relevant unit, contract, integration, adversarial, and smoke coverage passes.
- `npx tsc --noEmit` and `npx vitest run` pass; release-facing work also passes both release validators.
- Generated runtime assets are current when source changes require them.
- Documentation, schemas, manifests, and changelog are consistent.
- Git status contains no unexplained changes, security-sensitive behavior received explicit review, and the final review covers the whole candidate branch.
- Any delegation-discovered bug is captured in `scratchpad.md` as a dogfood regression test.
