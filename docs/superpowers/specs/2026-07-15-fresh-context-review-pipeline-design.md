# Fresh-Context Review Pipeline — Design

Date: 2026-07-15
Status: Approved (design), pending implementation plan

## Purpose

Extend claude-architect's existing delegate lifecycle with a runtime-driven
write→review→fix→verify loop in which every role runs in a fresh, isolated
producer-lane process. One agent authors the implementation; different fresh
agents review it; a fresh fixer applies accepted findings; a clean-room
verifier re-proves the result; Claude makes the final integration decision.

This is an extension of the existing MCP lifecycle
(`delegate` → `reviewCandidate` → `decideCandidate` → `integrateCandidate`),
not a standalone CLI. No new state store, no `.delegation/` tree.

## Core invariants

1. **Fresh context** — every role is a new headless producer CLI process with
   its own role-specific input package. No conversation resume, no shared
   scratchpads. This falls out of the existing producer-lane architecture.
2. **Role separation** — the implementer never approves its own code;
   reviewers and the verifier run under read-only confinement (existing
   Seatbelt/bwrap backends) and cannot edit; the fixer cannot perform final
   verification; the runtime never authors code or waives findings.
3. **Artifact-only handoff** — roles communicate via versioned artifacts in
   the existing ArtifactStore (spec, candidate diff, structured findings,
   dispositions, verification report). Reviewer packages never include the
   implementer's transcript or reasoning.
4. **Fail closed** — missing or invalid evidence means the gate is not
   satisfied. Round caps route to a human decision, never to auto-accept.

## Pipeline

One new MCP tool: `delegatePipeline`. Deterministic control flow inside the
plugin runtime (no agent decides state transitions).

1. **Implement** — existing `delegate` path unchanged: selected producer lane
   writes the candidate in its isolated worktree; AcceptanceVerifier runs;
   candidate artifact recorded.
2. **Review** — two fresh producer-lane reviewers run in parallel:
   - *correctness* — acceptance criteria, missing/incorrect behavior, edge
     cases, error handling, regression risk, test adequacy;
   - *systems* — security, authorization, concurrency, resource lifecycle,
     compatibility, performance, architectural boundaries.
   Each receives only: delegation spec, baseline commit, candidate diff,
   relevant source/test files, and test evidence. Read-only confinement.
   Reviewers cannot see each other's findings before submission.
3. **Consolidate** — deterministic code, not an agent: normalize finding
   format, dedupe substantially identical findings, preserve highest
   severity, assign stable finding IDs, detect contradictions. It can never
   downgrade or drop a blocker/major finding.
4. **Fix** — a fresh producer lane in the same worktree receives the spec,
   candidate, and consolidated findings. It must return exactly one
   disposition per finding: `fixed | already_satisfied |
   rejected_with_evidence | blocked | requires_human_decision`. Fixed
   findings must map to a commit and verification evidence.
5. **Re-review** — a fresh review round (new sessions) on the fixed commit.
   Maximum 2 rounds; exceeding the cap fails closed to human decision.
6. **Clean-room verify** — fresh worktree at the final candidate commit,
   read-only, re-runs the authorized checks, confirms: no deleted/weakened/
   skipped tests, clean tree after testing, diff within authorized scope,
   candidate still based on the approved baseline.
7. **Decide** — unchanged: `delegatePipeline` returns the full evidence
   bundle; Claude reviews it and calls `decideCandidate` →
   `integrateCandidate`. The pipeline never merges.

## Severity and gates

Findings carry severity `blocker | major | minor | nit`, exact location, a
falsifiable claim, evidence, reproduction, required outcome, and confidence.

A candidate is not decision-ready when any of: an unresolved blocker; an
unresolved/unwaived major; a failed or skipped required check; deleted or
newly skipped tests; a dirty verify worktree; out-of-scope diff; baseline
drift; a missing/invalid artifact; the round cap exceeded. Nits never block.

## Structured outputs

JSON schemas (validated at the runtime boundary, one schema-repair retry,
then phase failure):

- **Review report** — verdict + findings array (fields above) + coverage gaps.
- **Fix report** — new candidate commit + dispositions array.
- **Verification report** — pass/fail, per-command results, workspace-clean,
  tests-deleted/skipped counts, scope violations.

## Delegation Spec extension

Optional `review` block with defaults, so existing `delegate` calls are
untouched:

```yaml
review:
  reviewers: [correctness, systems]   # default
  maxRounds: 2                        # default
```

## Failure handling

- Role process failure: retry once with the identical input package in a new
  session; second failure marks the phase blocked.
- Reviewer contradiction or fixer rejection of a blocker: surface to Claude/
  human via the evidence bundle (no adjudicator agent in v1 — YAGNI).
- All failures reuse the existing failure-classification and recovery paths.

## New code (everything else is reuse)

- Role prompt templates: reviewer-correctness, reviewer-systems, fixer,
  clean-room verifier (adversarial rubrics per the reviewed design).
- Finding / disposition / verification schemas + validators.
- Deterministic consolidator.
- Round loop, gate evaluation, and `delegatePipeline` MCP tool wiring.
- `skills/delegate` update: use `delegatePipeline` by default for
  non-trivial tasks; plain `delegate` for trivial ones.

Reused as-is: worktree isolation, producer adapters + registry + routing,
confinement backends, ArtifactStore, RunManifest, AcceptanceVerifier,
redacted logging, RecoveryManager, decide/integrate tools.

## Testing

Existing TDD pattern: fake producers per role; gate matrix (unresolved
blocker → not decision-ready; weakened tests → fail; round cap → human
decision; invalid structured output → one repair then fail); consolidator
unit tests (dedupe, severity preservation); one end-to-end pipeline test in
a temporary Git repository.

## Out of scope (v1)

Adjudicator agent, file leases across concurrent tasks, execution profiles
beyond the default, process-learning metrics loop, standalone CLI surface.
