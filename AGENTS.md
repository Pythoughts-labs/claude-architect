# Agent Guide

## Project purpose

Claude Architect is a cross-platform Claude Code plugin for verified delegation to Codex, OpenCode, Pi, and Pythinker. Claude authors a versioned Delegation Spec; the runtime launches an untrusted Producer in an isolated Git worktree, freezes its output as a Candidate Artifact, independently verifies it, and exposes the exact artifact for review and human-controlled integration.

The repository also contains a strictly non-mutating advisor, cross-platform process supervision, crash recovery, bounded redacted logging, and Producer capability routing.

## Sources of truth

When sources disagree, use this descending precedence:

1. JSON schemas in `runtime/schemas/` and protocol constants in `src/protocol/`.
2. Runtime behavior in `src/`; generated packaged output lives in `runtime/`.
3. Contract and adversarial tests in `tests/`.
4. The delegation workflow in `skills/delegate/SKILL.md` and role definitions in `agents/`.
5. Plugin manifests in `.claude-plugin/` and user-facing documentation.

When prose conflicts with an executable contract, correct the prose or explicitly migrate the contract. Never leave them silently inconsistent.

## Mandatory operating rules

### Code discovery

This repository is indexed by the `codebase-memory-mcp` server as project `Users-panda-Projects-active-claude-architect`.

- For code exploration, use graph tools first: `search_graph` for symbols, `get_code_snippet` for exact source, `trace_path` for call chains, `search_code` for graph-assisted text search, and `get_architecture` for structure.
- If the server or a required graph tool is unavailable, state that limitation, then fall back to repository search and direct file reads. Do not continue silently.
- If the index is stale after substantial changes, run `index_repository` before relying on it.

### Planning and approval

Before making a non-trivial change:

- Read the relevant schema, implementation, tests, skill text, and recent Git history.
- Inspect `tasks/lessons.md` and any active `tasks/todo.md` when present.
- State the intended outcome, authorized scope, and verification method.
- Inspect Git status and preserve unrelated user changes; never assume a dirty worktree is disposable.
- Identify implications for macOS, Linux, Windows, and each affected Producer.

Before invoking **dynamic workflows**, **ultra code**, or any equivalent harness feature that immediately launches a large swarm of subagents, explain the tradeoffs and obtain the user's explicit approval. Do not infer approval from a general request to investigate or implement.

### Scope and engineering quality

- Make the smallest change that fully satisfies the request. Every changed line must trace to an acceptance criterion.
- Do not perform unrelated reformatting, renaming, refactoring, or cleanup.
- Fix every lint failure, test failure, and flaky test discovered during the work, even when pre-existing or unrelated to the initial request.
- If a required fix exceeds the authorized scope, stop and request expanded scope. Do not ignore the failure or report the task complete.
- Prefer quality, simplicity, robustness, scalability, and long-term maintainability over short-term development cost.
- **Never propose deferring an applicable issue or fix.** If a problem is real and a fix applies, do the fix now — even when it requires a redesign or significantly more work. "Defer", "follow-up later", "out of scope for now", and equivalents are prohibited recommendations; the only permitted alternative to fixing immediately is stopping to request expanded scope, then fixing.

## Non-negotiable trust invariants

- Every delegated implementation or repair attempt starts with fresh context in a fresh isolated worktree.
- Implementers cannot review, approve, or accept their own work.
- Independent reviewers evaluate frozen candidate bytes without sharing implementer context.
- Read-only roles cannot mutate files, Git state, processes, or external systems.
- Roles communicate through versioned specs, manifests, patches, findings, and other durable artifacts—not hidden conversational state.
- Verification is objective, recorded, and rerunnable; Producer claims are never evidence.
- A human may record any Candidate Decision after reviewing the evidence. The trusted runtime may record `accepted` with authority `autopilot-policy` only through the hash-bound Promotion module when a current Autopilot Eligibility record proves every required review, verification, advisor, artifact, and base gate. Producers, reviewers, advisors, skills, and MCP callers cannot construct or waive eligibility.
- Autopilot acceptance authorizes Controlled Integration only into the workflow-owned feature branch. Only a human may merge a pull request or otherwise advance `main`.
- Workflow state, decisions, evidence, and recovery data remain durable across process failure.
- Final review covers the entire workflow branch and evidence from cumulative interactions across attempts, not only the latest patch.

## Architecture boundaries

- `src/protocol/` and `runtime/schemas/` define versioned external contracts.
- `src/runtime/` owns attempt lifecycle, artifacts, state, recovery, redaction, and manifests.
- `src/producers/` owns capability probes, routing, and CLI adapters. Adapters never gain acceptance authority.
- `src/verify/` independently proves structural and project-level properties.
- `src/pipeline/` coordinates fresh-context implementation, review, repair, and gates.
- `src/integrate/` applies only accepted, hash-matched artifacts under repository locks.
- `src/platform/` encapsulates OS-specific process and confinement behavior.
- `src/mcp/` exposes the trusted orchestration surface; keep handlers thin and validated.

Do not collapse these boundaries to simplify a test. Generated `runtime/` output must remain reproducible from source.

## Agent isolation

Treat every external agent as an untrusted Producer.

- Give each Producer only the bounded spec and capabilities required for one attempt.
- Isolate concurrent writers in separate worktrees.
- Prevent nested delegation and sanitize inherited configuration.
- Terminate complete process trees on cancellation or timeout.
- If confinement or eligibility cannot be proven, make the edit lane unavailable. Never fall back to a less isolated path.

## Security requirements

- Validate every external input against the canonical schemas before use.
- Spawn processes with executable-and-argument arrays; never interpolate shell command strings.
- Canonicalize paths and reject traversal, symlink escapes, repository escapes, and identity changes.
- Select executables through explicit allowlists and capability probes.
- Sanitize environments. Pass only documented variables and never expose credentials to delegated contexts.
- Redact secrets, tokens, personal data, prompts, and sensitive argument values from bounded logs and tool output.
- Fail closed on ambiguity, unsupported platforms, missing confinement, malformed artifacts, verification failure, or state mismatch.
- Never mock the component whose security property a test claims to prove.

## Testing and verification

Add the narrowest test that fails without the change, then cover the affected layers:

- unit tests for pure validation, policy, and transformation logic;
- contract tests for schemas, manifests, adapters, and MCP inputs and outputs;
- integration tests for worktrees, artifacts, recovery, verification, and controlled integration;
- adversarial tests for path, environment, process, redaction, race, and trust-boundary attacks;
- opt-in real-adapter smoke tests for supported Producer and platform combinations.

Exercise unhappy paths and fail-closed behavior. Save every bug discovered during delegation as a dogfood regression-test description in `scratchpad.md`.

Primary verification commands:

```bash
npx tsc --noEmit   # TypeScript 7 (native Go compiler)
npx vitest run
bash scripts/validate-release.sh
claude plugin validate .
```

### Dependency version policy (updated 2026-07-19)

All dependencies track latest, with one deliberate pin. Provenance for future sessions:

- `typescript` 7.x — the stable native Go compiler (successor of the `tsgo`
  `@typescript/native-preview` line, which is no longer installed); `npx tsc --noEmit`
  is the single type gate. tsconfig pins `types: ["node"]` because the native
  compiler does not auto-discover `@types` packages the way tsc 5.x did.
- `zod` is pinned to latest **v3** on purpose: `@modelcontextprotocol/sdk` v1.x
  declares `zod ^3` as a direct dependency, and mixing zod 4 into the tree causes
  dual-copy `TS2589` type blowups (per the SDK's own troubleshooting docs, verified
  via Context7 against /modelcontextprotocol/typescript-sdk). Move zod to v4 only
  together with the SDK v2 upgrade (v2 requires zod >= 4.2; it is still beta as of
  2026-07-19 — re-check before upgrading).
- `vitest` 4.x — the `test(name, fn, { timeout })` options-object third argument was
  removed in v4; use a numeric third argument or options as the second argument.
- `esbuild` tracks latest; any bump changes `runtime/server.mjs` bytes, so rebuild
  and commit the bundle in the same change (`bash scripts/build-runtime.sh`).

Run TypeScript and the full Vitest suite for executable changes. Run both release validators for release-facing work. For documentation-only changes, validate affected commands, links, examples, formatting, and contract consistency; run broader gates whenever the documentation is release-facing or a repository hook requires them.

## Schema and protocol changes

Treat schemas as public, versioned APIs. Update the canonical schema, TypeScript types, validators, fixtures, contract tests, runtime compatibility checks, skill protocol marker, and documentation together.

Prefer additive compatible changes. For breaking changes, increment the appropriate protocol or specification version and provide an explicit mismatch diagnostic. Never accept unknown semantics merely to preserve compatibility.

## Error handling

- Return structured, stable classifications with actionable redacted diagnostics.
- Preserve distinctions among unavailable, invalid, failed, cancelled, timed out, conflicted, and aborted outcomes.
- Never catch and ignore errors, convert failure into apparent success, or trust a Producer's self-report.
- Cleanup failures must remain visible in evidence without erasing the primary outcome.

## Plugin packaging and releases

- The plugin manifest exists only at `.claude-plugin/plugin.json`; never add a duplicate root manifest.
- Claude Code components (`agents/`, `skills/`, `.mcp.json`, hooks, and runtime assets) live at the plugin root.
- Packaged runtime references must resolve through `${CLAUDE_PLUGIN_ROOT}`, never checkout-specific or user-specific absolute paths.
- Marketplace releases advance the minor version only (`0.3.0` → `0.4.0` → `0.5.0`); never publish patch-version tags.
- Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README version badge, `tests/runtime/plugin-wiring.test.mjs`, and `CHANGELOG.md` on exactly the same version.
- Run `bash scripts/validate-release.sh` before every release push. Never commit or push a release tag when validation fails.
- Treat red cross-platform CI as stop-the-line.

Repository maintainers should enable the push gate once per clone:

```bash
git config core.hooksPath .githooks
```

Agents must not change Git configuration unless the user explicitly requests it. `.githooks/pre-push` runs TypeScript and the full Vitest suite for every push. Because that suite runs on one OS, cross-platform (Linux/macOS/Windows) failures only appear in CI; the hook therefore also consults actual CI conclusions via `gh`: it **refuses** to push more onto a feature branch whose latest completed CI is `failure` (use `git push --no-verify` only when the push itself is the fix), and it **warns** whenever `origin/main` CI is red so an inherited failure is visible before a merge or rebase. Pushes to `main` or a tag additionally run release validation, and a tag push is hard-blocked when `origin/main` CI is failing. These CI checks degrade gracefully to no-ops when `gh` is unavailable, so they cannot fully substitute for green cross-platform CI—never merge or tag on a red Windows/Linux run.

## Git safety

- Never discard user changes.
- Do not run destructive commands such as `git reset --hard`, `git clean -fdx`, forced checkout, force-push, broad recursive deletion, or history rewriting.
- Use isolated worktrees, repository locks, exact object IDs, and candidate refs.
- Integration must enforce an expected-old-head/base guard: abort if checkout `HEAD` no longer equals the reviewed candidate's base.
- Revalidate artifact hash, anchor, tree, status, and worktree before reporting integration success.
- Never add AI co-author trailers, including `Co-Authored-By`, or generated-by footers to commits or pull requests.

## Documentation duties

Update user-facing instructions whenever commands, permissions, compatibility, data retention, trust guarantees, or limitations change. Keep examples executable and distinguish certified, tested, legacy, and unsupported paths precisely. Record release-visible changes in `CHANGELOG.md` and keep every release-version surface synchronized.

## Definition of done

Work is complete only when all applicable conditions hold:

- The requested behavior and every trust invariant are satisfied with a minimal diff.
- Every discovered lint failure, test failure, and flaky test is fixed; none is deferred silently.
- Relevant unit, contract, integration, adversarial, and smoke coverage passes.
- TypeScript, Vitest, and applicable release validation pass as defined above.
- Generated runtime assets are current whenever source changes require them.
- Documentation, schemas, manifests, and changelog are consistent.
- Git status contains no unexplained changes.
- Security-sensitive behavior received explicit review.
- Final review covers the whole workflow branch and evidence from cumulative interactions across attempts.
- Every delegation-discovered bug is captured in `scratchpad.md` as a dogfood regression test.
