# Sliced Delegation — Design Spec

- **Date:** 2026-07-18
- **Status:** Draft for review
- **Scope:** Add architect-authored, test-gated vertical slicing to the delegation pipeline.

## Problem / gap

The pipeline already runs a **fresh-context increment loop** (`src/pipeline/pipeline-runtime.ts:~806-909`): after the initial implementer attempt it runs increments 2..N, each in fresh context, until the implementer self-reports `complete`, `blocked`, or `stalled`.

Two properties of that loop are the actual gap this enhancement closes:

1. **Boundaries are implementer-driven, not architect-authored.** The implementer decides how far each increment goes and when the work is done. There is no way for the architect to pre-declare the shape of the work as an ordered sequence of coherent chunks.
2. **Completion is self-reported, not test-proven.** An increment ends when the implementer *claims* `complete`. This is a Producer claim, and the trust model says Producer claims are never evidence — yet here a claim controls loop progression.

**This enhancement replaces implementer-self-reported increment boundaries with architect-authored slice boundaries whose completion is proven by an objective test gate.** The architect decomposes the objective into an ordered list of vertical slices, each ending at its own verification command ("till test"). Progression between slices is decided by objective gate results, not by the Producer.

## Non-goals

- Not replacing `delegate` or the reactive increment loop; both remain for tasks that don't decompose cleanly.
- Not adaptive/re-planning decomposition. Slices are a **static plan** authored up front (confirmed with user). A slice outcome never re-plans the remaining slices; it can only advance, repair-in-place, or halt.
- Not a new mutating role. The wayfinder is deterministic routing code, not an LLM with acceptance authority.
- Not mid-run integration. Nothing merges to the working tree until a human accepts the composed candidate.

## Design overview

Activate sliced behavior by adding an optional `slices` field to the existing `delegatePipeline` spec — **no new MCP call**. When `slices` is present and non-empty, the runtime runs the sliced pipeline; when absent, behavior is exactly as today.

```
architect authors spec.slices = [S1, S2, … SK]  (ordered, each ends at a test)
        │
        ▼
for N in 1..K:
    fresh-context implementer, fresh worktree anchored on SN-1's frozen output
        │  (sees code state + SN's slice spec only — no conversational handoff)
        ▼
    freeze slice bytes → structural verify → run SN.verification (the test gate)
        │
        ▼
    wayfinder (deterministic): gate green → advance
                               gate red + rounds left → repair (fresh context, same slice)
                               rounds exhausted / hard blocker → HALT → human-decision-required
        │
        ▼ (all K advanced)
composed candidate = whole accumulated branch
        │
        ▼
final review (whole branch + cumulative interactions) + advisor at the commitment boundary
        │
        ▼
human decideCandidate → integrateCandidate   (unchanged)
```

## The slice (scoped mini-spec)

Each entry in `spec.slices` is a scoped mini-spec carrying only what a fresh implementer needs:

- `objective` — one observable outcome for this chunk.
- `context` — durable context this slice needs (see "No context" below).
- `writeAllowlist` / `forbiddenScope` — subset of the whole; validated to sit within the top-level allowlist.
- `successCriteria` — reviewable conditions for this chunk.
- `verification` — the "till test": Host-authorized command objects, same shape as top-level `verification`. At least one command must mechanically cover each of this slice's success criteria. This is the gate that closes the slice.

The top-level `spec.objective`, `spec.writeAllowlist`, `spec.verification` remain and describe the **whole** deliverable; the composed-candidate final review checks them.

**Validation rules (fail closed):**
- Each slice `writeAllowlist` glob must be a subset of (or equal to) the top-level allowlist; a slice may not widen write scope.
- Slice `verification` must be non-empty (a slice with no test is not a slice).
- Slices are ordered; execution order equals array order.
- All existing per-command verification constraints apply per slice (args-not-argv, `network` ∈ {denied, allowed}, `timeoutMs` 1..1800000, cwd, exit codes, platform filters).

## Execution model

For slice N (1..K):

1. **Fresh-context implementer in a fresh worktree anchored on slice N-1's frozen output.** The worktree accumulates: slice N sees all prior slices' frozen code. The *agent context* is fresh — it receives slice N's spec and the code state, and **no conversational or `progress` summary handoff** from prior slices. This is the deliberate contrast with the current increment loop, which threads a `progress` note and is implementer-driven.
2. **Freeze** slice bytes into a candidate anchor, run structural verification, then run slice N's `verification` commands in a disposable worktree (same clean-room semantics as today).
3. **Wayfinder routes** (next section).

Repair is a fresh-context attempt on the **same** slice, anchored on the same base as the failed attempt (slice N-1's frozen output), bounded by `review.maxRounds` (reused). Repair never edits frozen bytes; it produces a new attempt.

## Wayfinder — deterministic per-slice router

The wayfinder is **code**, an extension of `evaluateGates`, run per slice. It consumes objective gate results only:

| Condition | Route |
|---|---|
| structural verify + all slice `verification` green (+ optional per-slice review clean, if enabled) | `advance` |
| any gate red, repair rounds remaining | `repair` (fresh context, same slice) |
| repair rounds exhausted, or hard/unrecoverable blocker (worktree/isolation/git failure) | `halt` → `human-decision-required` |

The wayfinder **recommends routing; it never accepts.** An LLM narrator MAY summarize the route for the human, but the routing decision is derived from gate results, preserving *"verification is objective, recorded, rerunnable; Producer claims are never evidence."*

Rationale for deterministic (not an LLM judge): no invariant requires an LLM per slice; the slice test *is* the judgment. An LLM router would have to re-inherit the reviewer's independence guarantees for no gain and introduces a hallucinated-approval path.

## Per-slice review: verification-only by default

**Default:** per slice, the gate is verification only (structural + slice `verification`). No LLM review per slice. This is the honest reading of "execute all with no context **then** judge the output back to advisor" — the judgment lands at the end.

**Optional knob:** `review.perSlice: true` (default `false`) enables an independent reviewer per slice for teams that want fail-early drift detection, at K× review cost. When enabled, per-slice review must satisfy the same independence/isolation guarantees as composed review (independent reviewer, frozen bytes, no implementer context).

Cost: default is 1 composed review + K test gates, vs K+1 reviews if per-slice review were mandatory.

## Composed candidate + advisor (the "judge back to advisor")

When all K slices advance, the pipeline yields a single **composed candidate** spanning the whole accumulated branch. Then, unchanged from today:

- **Final review covers the entire candidate branch and cumulative interactions across all slices and repairs** — not just the last slice (existing invariant).
- The read-only **advisor** is consultable at this commitment boundary. This is the literal "judge the output back to advisor."
- Human `decideCandidate` → `integrateCandidate` with the composed `manifestHash`. No mid-run integration.

## Partial candidate at halt + durability (gap fill)

When the wayfinder halts at slice N of K:

- The pipeline returns `status: "human-decision-required"` with a **partial composed candidate** covering slices 1..N-1 (all advanced slices) plus the frozen failed attempt(s) for slice N as evidence.
- The evidence bundle states explicitly: which slices advanced, which slice halted and why (gate reasons, exhausted rounds, or hard blocker), and that the candidate is **partial** (slices N..K not attempted or not passing).
- The human may accept the partial branch (slices 1..N-1), reject, or request revision. The runtime never advances past a halt on its own and never accepts a partial candidate on the human's behalf.

**Durability / crash recovery:** each slice's spec, frozen bytes, verification evidence, and wayfinder route are written as durable pipeline artifacts as they complete (reusing `writePipelineArtifact`), so a process failure mid-sequence leaves a recoverable record of which slices advanced and where the sequence stopped. Recovery resumes from the last durably-advanced slice's frozen output; it never silently re-runs an already-advanced slice as if fresh.

## "No context" — precise definition

"No context" means **no conversational or progress-summary handoff** between slices. It does **not** mean an information-starved implementer:

- Each slice runs with fresh agent context.
- Each slice reads the accumulated code state (prior slices' frozen output).
- Each slice's spec must carry enough durable `context` + `objective` that a fresh implementer makes globally-correct choices, not locally-right/globally-wrong ones. Authoring thin slice context is a spec defect the architect fixes before dispatch.

Roles communicate only through durable artifacts (slice specs, frozen bytes, verification evidence, routes) — never hidden conversational state (existing invariant).

## Trust-invariant mapping

| Invariant | How met |
|---|---|
| Fresh context, fresh worktree per attempt | Every slice + every repair is a fresh worktree/context |
| Implementer can't review own work | Independent reviewer on composed candidate (and per slice if enabled) |
| Reviewers evaluate frozen bytes | Slice freeze before verify; composed freeze before final review |
| Read-only roles cannot mutate | Wayfinder is pure routing over gate results; advisor unchanged |
| Durable artifacts, not conversational state | Slice specs, frozen bytes, evidence, routes all persisted |
| Verification objective, recorded, rerunnable | Routing derived from gate results; Producer claims never gate progression |
| Only a human accepts | Wayfinder routes/recommends; human decides composed (or partial) candidate |
| State durable across process failure | Per-slice artifacts written on advance; recovery resumes from last advance |
| Final review = whole branch | Composed-candidate review + advisor unchanged |

## Schema / protocol change surface (coordinated, per AGENTS.md)

Treated as one versioned change set:

- Canonical JSON schema in `runtime/schemas/` — add optional `slices` array + `review.perSlice`.
- TypeScript types + validators for `Slice` and the extended spec.
- Fixtures + contract tests (valid sliced spec, slice widening write scope → reject, empty slice verification → reject, slices absent → today's behavior).
- `PROTOCOL_VERSION` marker in `skills/delegate/SKILL.md` — **minor** bump (additive/compatible; slices are opt-in).
- Runtime: sliced runner reusing the increment machinery; deterministic wayfinder extending `evaluateGates`; partial-candidate + durability handling.
- `skills/delegate/SKILL.md` prose + `runtime/schemas/` regenerated packaged output.
- `CHANGELOG.md` + version-surface sync per release rules.
- Regenerate `runtime/` from source (reproducible).

## MVP (walking skeleton) vs optional

**MVP — separable, ships value alone:**
1. `slices` schema + validation (subset/non-empty/order).
2. Sequential slice runner reusing increment machinery, fresh no-context per slice, anchored on prior frozen output.
3. Per-slice freeze + verification (verification-only gate).
4. Deterministic wayfinder (advance / repair / halt) extending `evaluateGates`.
5. Composed-candidate final review + advisor at the boundary.
6. Partial-candidate-at-halt evidence + per-slice artifact durability.
7. Skill/docs/schema/changelog sync.

**Optional (follow-ups, gated behind knobs):**
- `review.perSlice: true` independent per-slice review.
- LLM narrator summarizing routes for the human.
- Crash-resume tooling beyond the durable artifact record.

## Sequencing

1. Slice schema + validation + contract tests.
2. Sequential slice runner + fresh no-context anchoring.
3. Per-slice freeze/verify + deterministic wayfinder gates.
4. Composed-candidate review + advisor boundary.
5. Partial-halt evidence + durability/recovery.
6. Skill text, protocol bump, packaged schema regen, changelog.

## Decisions to confirm at the spec-review gate

1. **Per-slice verification-only by default**, per-slice review behind `review.perSlice`. (Load-bearing cost decision.)
2. **`slices` field on `delegatePipeline`**, not a new MCP call.
3. **Deterministic wayfinder**, LLM only narrates.
4. **Static decomposition** — no re-planning on drift (already confirmed).
