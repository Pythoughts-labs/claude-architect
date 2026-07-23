---
name: delegate
description: Let Claude Architect route a versioned implementation spec through the trusted MCP runtime, independently review the Candidate Artifact, record a decision, and integrate only accepted bytes. Use for implementation delegation, Producer selection, or commitment-boundary review.
---

# Delegate

```claude-architect-protocol
PROTOCOL_VERSION: 1.3.0
```

The current session is the architect. It owns requirements, the Delegation Spec, Producer selection, review, and acceptance. Producers are untrusted: their output is only a candidate until the runtime freezes it, independently verifies it, and the architect reviews the exact anchored bytes.

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

P0-A certifies the MCP implementation path only for Codex on macOS arm64 when its capability report names `codex-native-sandbox` and marks the edit Lane eligible.

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

**Verification preflight:** The runtime runs every verification command against clean HEAD in a disposable worktree before dispatch, and separately probes the Producer's own shell for the executables those commands name — a Producer that cannot resolve `node` or `git` cannot verify its own work, and would otherwise discover that only after burning the whole attempt window. An unresolvable executable ends the attempt as `environment-defect` before the Producer runs; anything less definite proceeds and is recorded in evidence. The probe proves resolution, not configuration, and grants a candidate nothing: independent verification remains the backstop. Repair the spec if a command cannot start. A baseline failure unrelated to the task is an environment defect the architect repairs centrally before dispatching. Set `expectBaselineFailure: true` on any command that cannot pass at clean HEAD by design — one that reproduces the target bug, or one that exercises a file or test the candidate will create (it necessarily fails before that path exists).

Resolve ambiguity before calling the runtime. Do not give the Producer credentials, hidden instructions, acceptance authority, or permission to expand scope.

## Coordinator duties

**Allowlist consumers:** Before dispatch the runtime reports tracked files that import the write allowlist but sit outside it. When a delegation changes an exported contract, either widen `writeAllowlist` to those consumers or add a repository-wide verification command — a src-only type gate plus focused tests compiles neither, so the breakage lands on the architect at integration time.

When running multiple delegations, normalize reported blockers by phase, command id, and root cause. The moment two independent lanes report the same blocker, pause affected lanes and treat it as an architect-owned shared-environment defect. Reproduce it once against the clean baseline, fix it centrally, rerun the preflight to green, then resume or redispatch the unchanged specs. Never wait for remaining lanes to rediscover it, and never push shared-tooling fixes into individual Producer lanes.

**Repository precondition:** delegation and controlled integration require an exact clean checkout; tracked or unignored changes must be committed before delegation, including tracked planning files such as `tasks/todo.md`. Git-ignored local planning files do not affect the clean check. Do not use skip-worktree or assume-unchanged flags as a workaround.

## Trusted MCP lifecycle

The `delegate` and `delegatePipeline` MCP calls are synchronous. Keep each call in the foreground until it returns; never hand it to Monitor or background execution.

1. Call `delegate` through `mcp__plugin_claude-architect_runtime__delegate` with `checkoutPath`, the candidate spec, and `protocolVersion: "1.3.0"` copied from this skill's `PROTOCOL_VERSION` marker.
2. When it returns `ok:false` with `validationErrors`, repair only the reported spec defects and resubmit. This repair loop must not touch a Producer.
3. When it returns a protocol/schema diagnostic, stop and tell the user to update the installed marketplace copy and reload Claude Code. Never guess across a version mismatch.
4. When the result is `unavailable`, `failed`, or `cancelled`, report the structured classification and evidence. Do not claim a candidate exists. A report with `laneEligibility.edit=false`, or any other ineligible or unconfined Lane, fails closed with the structured diagnostic.
5. When the result is `verified-candidate`, call `reviewCandidate` with `checkoutPath` and the run id. Read the exact unredacted patch, changed-path manifest, and verification evidence; compare them with every success criterion and repository convention.
6. Present the review outcome. Call `decideCandidate` with `checkoutPath`, the run id, and `accepted`, `rejected`, or `revision-requested`. Rejection discards the candidate anchor; a revision requires a new spec/attempt rather than editing frozen bytes.
7. Only after an accepted decision, call `integrateCandidate` with `checkoutPath`, the run id, and the exact candidate `manifestHash` as `expectedArtifactHash`. Report `applied`, `conflicted`, or `aborted` truthfully. Integration stages the reviewed tree but does not commit it.

Never accept a Producer self-report as evidence, bypass `reviewCandidate`, call integration before an accepted decision, or substitute a different artifact hash.

## Lanes as native subagents

For visibility, dispatch delegation lanes through the host's `Agent` tool using the plugin's `delegation-lane` agent; the host then renders each lane as a native subagent row (spinner, stats, completion notice). This is a dispatch surface only — spec construction, `reviewCandidate`, the human decision, and `integrateCandidate` stay in this session exactly as above.

Before dispatch, compute `specSha256` over the exact spec JSON and assign a short `laneId`. Each lane prompt contains only: `laneId`, `specSha256`, `checkoutPath`, `protocolVersion`, `pipeline` true/false, and the complete Delegation Spec JSON. Nothing else.

Concurrency is honest, never advertised beyond the runtime:

- **Independent repositories** (disjoint `gitCommonDir`s): dispatch one lane agent per repository in a single message; they genuinely run concurrently.
- **Same repository**: the runtime serializes all attempts on the repository lock. Lanes may still be dispatched as subagents for visibility, but they execute one at a time; size timeouts accordingly and never present them as parallel.

The lane report is model-mediated and untrusted for anything but correlation. On completion, take only `runId` from the report and call `reviewCandidate`; every reviewable fact comes from that evidence. On a malformed or missing report, do not redispatch: locate the run directory whose recorded spec matches `specSha256` (per the monitoring section) and resume from its `result.json`; redispatch only when no matching run directory exists.

Decision and integration remain per-repository and serial: review → decision → integrate → stop until the human commits or discards the staged tree. At most one accepted candidate per clean checkout; never batch-accept multiple candidates targeting the same checkout. Decisions for lanes on different repositories may be presented together in one structured question.

Single-lane delegation may still use the direct foreground MCP call; prefer the lane agent whenever the call will outlive the host's ~120s background threshold.

## Presenting delegations as subagents

When a lane runs through the `delegation-lane` agent, the host renders dispatch and live status natively; the cards below apply only to direct (non-subagent) MCP calls. This is presentation only: it renders the runtime's durable evidence and never replaces spec construction, `reviewCandidate`, the human decision, or `integrateCandidate`. A rendered card is not evidence; a Producer self-report is not evidence; acceptance stays human-only.

**Dispatch card** — emit when you call `delegate`/`delegatePipeline`, so the run reads like an `Agent` launch:

```text
▸ Agent · codex-implementer          edit · worktree-isolated
  Task    <3–5 word description>
  Model   GPT-5.6 Sol · reasoning low
  Mode    foreground        Pipeline  delegatePipeline
```

**Live status** — one FleetView-style line while the call runs and after the host collapses it to background. Derive it only from the run's durable artifacts using the rules in *Monitoring a backgrounded delegation*; never invent progress.

```text
● running · codex-implementer · verification · 4m12s
```

Status glyphs: `●` running (host-rendered for lane agents) · `◑` human decision pending · `✓` verified/accepted · `✗` failed, unavailable, cancelled, or rejected. The decision line appears only on decision-bearing outcomes.

**Completion notification** — when the call returns, render one compact box populated from the `reviewCandidate` evidence and verification report (mirrors a background subagent's completion notice):

```text
┌ ✓ delegation-lane · codex · verified-candidate ─────────
│ lane task1 · 1 file changed · verification 2/2 pass
│ producer self-report conflicts: none
│ manifestHash cebcb2a8…
│ ◑ YOUR DECISION: accept / reject / revise
└──────────────────────────────────────────────────────────
```

The box summarizes; it does not decide. Still read the exact unredacted patch, changed-path manifest, and verification evidence before recommending a decision, and present `failed` or `human-decision-required` outcomes verbatim.

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
     focus:
       - Check platform-specific process cleanup.
   ```

2. Call `mcp__plugin_claude-architect_runtime__delegatePipeline` with
   `checkoutPath`, `spec`, `protocolVersion: "1.3.0"`.
3. Read the returned evidence bundle: attempt result, per-round review
   reports and consolidated findings, fix dispositions, verification report,
   and gate reasons.
   - `status: "decision-ready"` — review the evidence yourself, then call
     `decideCandidate` with `checkoutPath` and the run id and, if accepted,
     `integrateCandidate` with `checkoutPath`, the run id, and the candidate
     `manifestHash` as `expectedArtifactHash`.
   - `status: "human-decision-required"` — present the gate reasons,
     unresolved findings, and dispositions to the human verbatim. Never
     accept on their behalf.
   - `status: "failed"` — report the failure classification; retry or
     re-scope per the normal delegate failure guidance.
4. The pipeline never merges and never waives findings; you and the human
   remain the only decision-makers.

## Sliced pipeline

For a task that decomposes into ordered, independently testable steps, add a
top-level `slices` array to the spec. Each slice is a scoped mini-spec with its
own `objective`, `context`, `writeAllowlist`, `forbiddenScope`,
`successCriteria`, and — required — its own `verification`:

```yaml
slices:
  - objective: Add the parser for the new record type.
    context: The record grammar lives in docs/format.md.
    writeAllowlist: [src/parse/**]
    forbiddenScope: [src/emit/**]
    successCriteria:
      - New record type round-trips through the parser.
    verification:
      - id: parse-tests
        executable: npx
        args: [vitest, run, tests/parse]
        cwd: "."
        timeoutMs: 600000
        network: denied
        expectedExitCodes: [0]
  - objective: Emit the new record type.
    # ...its own scope and verification
```

Slice rules and guarantees:

- Each slice runs **fresh with no context** — a slice implementer sees only its
  own mini-spec, never a prior slice's conversation, and is gated only by its
  own `verification`. Each slice's `writeAllowlist` must be a subset of the
  spec's, and its verification `cwd` must stay inside the candidate root.
- A deterministic wayfinder routes each completed slice **advance / repair /
  halt** from objective gate results — the slice's own `verification`, plus its
  independent per-slice review findings when `review.perSlice` is enabled —
  never from model judgment or a Producer's self-report. A slice that passes
  advances; a slice that fails is repaired within its round budget; a slice that
  cannot be made to pass halts the run.
- Review and the advisor judge the **composed candidate** at the end, over the
  whole slice branch. Per-slice review is off by default; opt in with
  `review.perSlice: true` to review each slice as it lands.
- A mid-run halt **after at least one slice has advanced** yields a **partial**
  candidate with `status: "human-decision-required"`, the halted slice index in
  `haltedSliceIndex`, and each slice's route in `slices`; the promoted partial
  branch (the advanced slices) is a real candidate the human may accept, reject,
  or revise, and the halted slice's attempts stay in `slices` as evidence. A
  halt on the very first slice, with nothing advanced, is reported `failed` with
  the slice evidence retained — there is no partial branch to accept. Present
  the completed slices, the halt reason, and the partial candidate to the human;
  never accept or continue past a halt on their behalf.

## Monitoring a backgrounded delegation

`delegate` and `delegatePipeline` are synchronous, but the host auto-backgrounds
a long call (after roughly 120s) and then surfaces only a generic "1 MCP task
still running" line; the in-band progress phases stop being visible there. A
producer alone almost always runs longer than the background threshold, so most
of a real delegation happens after the collapse. When a call backgrounds, do not
go silent — report a real status line by reading the run's durable artifacts.

Correlate the run without guessing:

1. Before dispatch, snapshot the run directories under the state dir
   (`CLAUDE_PLUGIN_DATA/runs` on a host; `CLAUDE_ARCHITECT_STATE_DIR`/tmp under
   tests). Reading these directories is read-only observation only.
2. After the call backgrounds, take the newly appeared directory whose
   `run-start.json` `canonicalCommonDir` equals this checkout's `.git` and that
   has no `result.json` yet. If more than one new matching directory appears —
   another session may be delegating against the same repository — report the
   ambiguity and do not assume which run is yours.
3. Read `runs/<runId>/pipeline/<name>.json` for the latest stage: `round-N-…`,
   `verification`, then `pipeline-result`. No pipeline artifact yet means the
   implement attempt (baseline or producer) is still running. `result.json`
   appearing means the run finished.

After backgrounding the host returns control once; emit a single Live status
line (the FleetView-style format above) then. Continuous status requires scheduled wakeups (about 75s apart, each a full
turn) — only do this when the human explicitly asks for live status, tell them it
costs a turn per update, and never poll tighter than the round cadence.

Prefer the `delegation-lane` subagent path over run-dir polling; polling remains the fallback for direct calls and for lane-report recovery via `specSha256`.
