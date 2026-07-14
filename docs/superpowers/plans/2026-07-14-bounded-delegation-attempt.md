# Bounded Delegation Attempt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound one validated Delegation Attempt with a single Host-authored deadline, preserve an immutable and auditable candidate lifecycle, expose safe progress, recover incomplete cleanup without unsafe PID termination, default the POSIX legacy Codex lane to 900 seconds, and prohibit acceptance while any valid review finding remains unresolved.

**Architecture:** Validation remains outside the Attempt Runtime and returns a separate repair result. A deep Attempt Runtime owns one stop arbiter, one immutable phase ledger, one atomic Candidate Artifact transition, and one bounded finalization state machine. Large patches and evidence remain archived behind bounded references; Host Decisions bind to the exact result and candidate hashes. Platform Services owns process identity and platform-specific termination, including POSIX process groups and native Windows Job Objects.

**Tech Stack:** TypeScript 5.9 in strict NodeNext mode on Node.js 22 or later, `@modelcontextprotocol/sdk` 1.29.0, Ajv 8.20 draft 2020-12, Vitest 2.1, Node child processes and cryptography, Git argv execution, POSIX Bash only for the temporary legacy lane, and a native Windows helper supplied by the P0-B platform implementation.

## Global Constraints

- **One writer:** Task 0 must prove no other writer is active before implementation starts.
- **Validated input:** an Attempt Runtime accepts only `ValidatedDelegationSpec`. Invalid input returns `SpecValidationFailure` and never creates an Attempt Result, run journal, timing record, lock, worktree, or Producer process.
- **Attempt deadline:** `DelegationSpec.timeoutMs` begins after validation and bounds preflight, probing, preparation, Producer execution, atomic freeze, and Acceptance Verification.
- **Finalization budget:** finalization is not an Attempt phase and has a separate fixed `30_000` millisecond budget.
- **Finalization outcome:** exhaustion records `recovery-required`; it never becomes an Attempt timeout and never overwrites the primary Attempt termination source.
- **Single stop arbiter:** the lifecycle listens to Host cancellation and deadline once. Every module receives the same combined signal and reads the same canonical stop cause.
- **Deterministic tie:** Host cancellation wins only when its recorded monotonic event time is strictly before or exactly equal to the deadline timestamp; otherwise the deadline wins. Listener callback scheduling order is irrelevant.
- **Operation timeout semantics:** probe-local timeout marks only that Capability Report unavailable and permits routing fallback. Producer-local timeout after process start fails the Attempt with `producer-timeout` and never falls back. Verification-command timeout is `verification-failure`. Attempt deadline remains `timeout`.
- **Candidate preservation:** no Candidate Artifact exists before atomic tree, commit, and anchor completion. Once atomic freeze completes, preserve the Candidate Artifact through verification failure, cancellation, timeout, finalization exhaustion, and recovery.
- **Immutable Attempt Result:** never rewrite an Attempt Result after it is returned or hashed. Recovery writes a separate `RecoveryRecord`.
- **Bounded artifacts:** Candidate Artifact stores patch reference, hash, and byte count, never inline patch text. Evidence is a closed array of bounded references, never an arbitrary object.
- **Hash-bound decisions:** every Host Decision binds to `candidateTreeOid`, `candidateManifestHash`, and `attemptResultHash`. Integration checks all three.
- **Durable phases:** phase transitions and heartbeats append to a bounded event ledger before notification. Attempt Result stores a summary plus ledger reference and hash.
- **Recovery identity:** never terminate a process from PID alone. Platform Services validates persisted identity before termination.
- **Journal ordering:** run state and lock state are separate. Cleanup completion is durable before lock release; terminal state is durable after confirmed lock release.
- **No detached finalization:** any finalization operation that can block runs in a supervised finalizer process. Losing work may not continue after the runtime returns.
- **Progress:** MCP progress is best effort, static, redacted, and emitted only when the Host supplied a progress token. Persisted events remain authoritative.
- **Review findings:** every valid finding, including a nit, is fixed and reverified before acceptance. Invalid findings are `dismissed` with evidence. Decision-blocked findings force `revision-requested`. No deferred or optional disposition exists.
- **Scope distinction:** rejecting a suggestion as outside the approved Delegation Spec is an evidence-backed dismissal, not deferred work. Roadmap scope remains separate from review findings.
- **Legacy timeout:** the POSIX compatibility lane defaults Codex to 900 seconds and keeps explicit `CODEX_TIMEOUT_SECONDS=0` until legacy cutover.
- **Windows separation:** the Bash watchdog is POSIX-only and is never used by the native Windows MCP runtime.
- **Cross-platform gate:** native Windows claims require Job Object/helper, locked-file, rename-retry, wrapper-grandchild, recovery, path-casing, and CRLF tests.
- **Redaction:** journals, phase events, evidence metadata, progress, and decision records contain no secret values or raw Producer output.
- **Runtime floor:** Node.js 22 or later. No new JavaScript runtime dependency.
- **TDD:** every production behavior starts with a deterministic failing test.
- **Build:** ask before `npm run build`.
- **Release:** do not tag or push. Marketplace releases use the next minor version and require `bash scripts/validate-release.sh`.
- **Authorship:** never add Claude, Anthropic, Codex, or Pi co-author trailers.

## Review Finding Resolution

| Review item | Plan correction |
|---|---|
| Invalid spec contradiction | Separate `SpecValidationFailure`; branded validated input; remove invalid-specification from Attempt failures |
| Finalizing under Attempt clock | Split Attempt work phases from lifecycle finalization |
| Interrupted timing | Outcome-aware timing with nullable end/duration |
| Late escalation | Schedule forced termination before cooperative cancellation |
| Fragmented first cause | One Attempt-wide stop arbiter and combined signal |
| PID-only recovery | Persist and validate platform-specific process identity |
| Journal/lock race | Explicit run-state and lock-state transitions |
| Mutable results | Immutable Attempt Result plus append-only Recovery Record |
| Inline patch/evidence | Hash-addressed bounded artifact references |
| Stale Host Decision | Bind decision to exact result/tree/manifest hashes |
| Producer/probe timeout ambiguity | Explicit termination source and routing policy |
| Finalization abortability | Operation classification and supervised finalizer process |
| Incomplete progress persistence | Bounded append-only phase event ledger |
| Windows gap | Mandatory native Windows lifecycle tests and helper contract |
| Flaky races | Fake clocks, deferred barriers, deterministic arbiter tests |
| Missing state-machine tests | Exhaustive transition/property test suite |
| Moving branch | Mandatory Task 0 reconciliation gate |

## Authoritative Amendments To The P0 Plan

This plan supersedes affected contracts in `docs/superpowers/plans/2026-07-14-p0-runtime-implementation.md` Tasks 2-9, 11-15, 17-21, 24, and 25. Unaffected P0 behavior remains authoritative.

## Canonical Contracts

### Validation stays outside Attempt Runtime

```ts
declare const validatedSpecBrand: unique symbol;

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface SpecValidationFailure {
  kind: "invalid-specification";
  errors: ValidationIssue[];
}

export type ValidatedDelegationSpec = DelegationSpec & {
  readonly [validatedSpecBrand]: true;
};

export type ValidateSpecResult =
  | { ok: true; spec: ValidatedDelegationSpec }
  | { ok: false; failure: SpecValidationFailure };
```

Only `validateSpec` can create the brand. MCP returns validation failure directly and does not call Attempt Runtime.

### Attempt work phases, lifecycle phase, and interruption-aware timing

```ts
export const ATTEMPT_WORK_PHASES = [
  "preflight",
  "probing",
  "preparing",
  "executing",
  "freezing",
  "verifying",
] as const;

export type AttemptWorkPhase = (typeof ATTEMPT_WORK_PHASES)[number];
export type LifecyclePhase = AttemptWorkPhase | "finalizing";

export type PhaseOutcome =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "attempt-timeout"
  | "finalization-exhausted";

export interface AttemptPhaseTiming {
  phase: LifecyclePhase;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: PhaseOutcome;
}

export type AttemptTerminationSource =
  | "none"
  | "host"
  | "attempt-deadline"
  | "producer-operation-timeout"
  | "probe-operation-timeout";

export interface AttemptTiming {
  startedAt: string;
  deadlineAt: string;
  returnedAt: string;
  budgetMs: number;
  timedOutPhase: AttemptWorkPhase | null;
  terminationSource: AttemptTerminationSource;
  phases: AttemptPhaseTiming[];
  phaseEventsRef: string;
  phaseEventsHash: string;
  phaseEventCount: number;
  phaseEventsTruncated: boolean;
  finalization: {
    budgetMs: 30_000;
    status: "completed" | "recovery-required";
    exhausted: boolean;
    endedAt: string | null;
  };
}
```

Finalization exhaustion never populates `timedOutPhase` and never sets `terminationSource:"attempt-deadline"`.

### Durable phase events

```ts
export type PhaseEventKind = "started" | "heartbeat" | "ended" | "stop";

export interface PhaseEvent {
  sequence: number;
  phase: LifecyclePhase;
  kind: PhaseEventKind;
  at: string;
  monotonicOffsetMs: number;
  outcome?: Exclude<PhaseOutcome, "running">;
  stopCause?: AttemptStopCause;
}
```

`phase-events.ndjson` is append-only, fsynced, capped at 256 records, and always retains transitions and stop events. Heartbeats stop when the cap would displace a transition. Notifications are projections of persisted events.

### One Attempt-wide stop arbiter

```ts
export type AttemptStopCause = "host-cancel" | "attempt-timeout";

export interface CappedTimeout {
  timeoutMs: number;
  source: "operation" | "attempt";
}

export interface ExecutionControl {
  signal: AbortSignal;
  remainingMs(): number;
  capTimeout(requestedMs: number): CappedTimeout;
  stopCause(): AttemptStopCause | null;
  throwIfStopped(): void;
}
```

The arbiter records Host event monotonic time and the predetermined deadline time. It aborts one internal controller with the canonical cause. No child module compares Host and deadline signals independently.

### Attempt failure vocabulary

Remove `invalid-specification`. Add `producer-timeout`:

```ts
export const FAILURE_PRECEDENCE = [
  "unavailable",
  "authentication-required",
  "spawn-failure",
  "cancelled",
  "timeout",
  "sandbox-violation",
  "invalid-output",
  "producer-timeout",
  "producer-failure",
  "verification-failure",
] as const;
```

If the stop arbiter has a cause, map it first and do not let `FAILURE_PRECEDENCE` overwrite it. Use precedence only for secondary failures when no Host/deadline cause won.

### Bounded Candidate Artifact and evidence

```ts
export interface ArtifactReference {
  ref: string;
  sha256: string;
  bytes: number;
}

export interface EvidenceReference extends ArtifactReference {
  kind:
    | "producer-log"
    | "verification-stdout"
    | "verification-stderr"
    | "structural-report"
    | "run-manifest"
    | "phase-events";
  redacted: boolean;
}

export interface CandidateArtifact {
  baseCommitOid: string;
  candidateTreeOid: string;
  candidateCommitOid: string;
  anchorRef: string;
  manifestHash: string;
  changedPaths: ChangedPath[];
  patchRef: string;
  patchHash: string;
  patchBytes: number;
}
```

`AttemptResult.evidence` becomes `EvidenceReference[]`. Inline `patch` and unrestricted evidence objects are removed.

### Timeout provenance

```ts
export type CommandTimeoutSource = "none" | "command" | "attempt";

export interface CommandOutcome {
  id: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  timeoutSource: CommandTimeoutSource;
  durationMs: number;
  stdout: EvidenceReference;
  stderr: EvidenceReference;
}
```

Probe-local timeout yields Capability Report reason `probe-timeout` and permits fallback. Producer-local timeout after start yields `failed/producer-timeout` with termination source `producer-operation-timeout` and forbids fallback.

### Platform-specific process identity

```ts
export interface PersistedProcessIdentityBase {
  pid: number;
  startedAt: string;
  executableHash: string;
  commandHash: string;
}

export type PersistedProcessIdentity =
  | (PersistedProcessIdentityBase & {
      platform: {
        kind: "posix";
        processGroupId: number;
      };
    })
  | (PersistedProcessIdentityBase & {
      platform: {
        kind: "windows";
        jobId: string;
        helperPid: number | null;
      };
    });

export type PersistedTerminationResult =
  | "terminated"
  | "not-found"
  | "identity-mismatch"
  | "still-running";
```

Extend Platform Services:

```ts
captureProcessIdentity(
  process: SupervisedProcess,
  request: SpawnRequest,
): Promise<PersistedProcessIdentity>;

terminatePersistedProcess(
  identity: PersistedProcessIdentity,
): Promise<PersistedTerminationResult>;
```

Recovery retains the lock and reports `still-required` on identity mismatch; it never guesses.

### Run state, lock state, and immutable recovery

```ts
export type RunState =
  | "active"
  | "finalizing"
  | "cleanup-complete"
  | "terminal"
  | "recovery-required";

export type LockState = "not-acquired" | "held" | "released";

export interface RunJournalRecord {
  runId: string;
  canonicalCommonDir: string;
  state: RunState;
  lockState: LockState;
  lockKey: string | null;
  worktreePath: string | null;
  processIdentity: PersistedProcessIdentity | null;
  candidateTreeOid: string | null;
  candidateManifestHash: string | null;
  anchorRef: string | null;
  currentPhase: LifecyclePhase;
  phaseEventsRef: string;
  startedAt: string;
  deadlineAt: string;
  attemptResultRef: string | null;
  attemptResultHash: string | null;
}

export interface RecoveryRecord {
  runId: string;
  attemptedAt: string;
  completedAt: string | null;
  status: "completed" | "still-required";
  evidenceRefs: EvidenceReference[];
}
```

Attempt Result is immutable. Recovery appends `RecoveryRecord` and updates only run journal state.

Allowed state progression:

```text
active -> finalizing -> cleanup-complete -> terminal
active -> recovery-required
finalizing -> recovery-required
cleanup-complete -> terminal
recovery-required -> cleanup-complete -> terminal
```

No terminal state transitions back to active.

### Hash-bound Host Decision

```ts
export type FindingDisposition = "fixed" | "dismissed" | "blocked";

export interface FindingResolution {
  id: string;
  summary: string;
  disposition: FindingDisposition;
  evidence: string;
}

export interface HostDecisionRecord {
  runId: string;
  candidateTreeOid: string;
  candidateManifestHash: string;
  attemptResultHash: string;
  decision: "accepted" | "rejected" | "revision-requested";
  findings: FindingResolution[];
  decidedAt: string;
}
```

`accepted` requires current immutable hashes, no blocked findings, no unresolved Attempt issues, terminal run state, released lock, and no outstanding recovery.

### Deep Attempt Runtime interface

```ts
export interface AttemptRunOptions {
  signal?: AbortSignal;
  onProgress?: (event: AttemptProgressEvent) => void;
}

export interface AttemptRuntime {
  run(
    checkoutPath: string,
    spec: ValidatedDelegationSpec,
    options?: AttemptRunOptions,
  ): Promise<AttemptResult>;
}

export function createAttemptRuntime(
  dependencies: AttemptRuntimeDependencies,
): AttemptRuntime;
```

Dependencies are constructed once at the composition root, never supplied by MCP callers per run.

### Bounded review projection and artifact reads

```ts
export interface CandidateReviewProjection {
  result: AttemptResult;
  attemptResultHash: string;
  runState: RunState;
  lockState: LockState;
  latestRecovery: RecoveryRecord | null;
  acceptanceAllowed: boolean;
  patch: ArtifactReference;
}

export interface ArtifactChunk {
  ref: string;
  offset: number;
  bytes: number;
  nextOffset: number | null;
  sha256: string;
  content: string;
}
```

`readCandidateDiff` and `readEvidence` cap each response to 262,144 bytes. Full artifacts require explicit chunked retrieval.

---

### Task 0: Reconcile The Moving Baseline

**Files:**
- Inspect: every file named by Tasks 1-15
- Modify only if contracts drifted: this plan and the existing P0 plan

**Gate:** no production implementation begins in this task.

- [ ] Confirm the other Claude/P0 writer has stopped.
- [ ] Require `git status --short` to be clean. If staged or unstaged work exists, stop and identify its owner.
- [ ] Record `git rev-parse HEAD` in the execution log.
- [ ] Run the current baseline:

```bash
npm run typecheck
npm test
bash scripts/validate-release.sh
```

- [ ] Map landed P0 tasks by file and commit. Record which files are create versus modify.
- [ ] Diff all canonical interfaces in this plan against current source and `CONTEXT.md`.
- [ ] If reconciliation changes this plan, update only the affected contracts, run `git diff --check`, and commit the reconciled plan before Task 1.
- [ ] Begin Task 1 only when baseline verification is green and one writer owns the checkout.

---

### Task 1: Replace GNU Timeout With A POSIX-Portable Legacy Watchdog

**Files:**
- Modify: `scripts/run-isolated.sh`
- Modify: `tests/run-isolated.test.sh`
- Modify: `tests/lane-launchers.test.sh`

**Interfaces:**
- Consumes `RUN_TIMEOUT_SECONDS=0|positive integer`.
- Produces exit `124` on watchdog expiry without `timeout` or `gtimeout`.
- Applies only to the POSIX compatibility path.

- [ ] Add a failing restricted-PATH test containing `bash`, `perl`, `sleep`, `mktemp`, and `rm`, but no GNU timeout binary. Spawn a command with a sleeping descendant and assert exit `124` plus no survivor.
- [ ] Run `bash tests/run-isolated.test.sh`; verify the old missing-timeout failure.
- [ ] Replace timeout-prefix execution with a secure `mktemp -d` watchdog marker and background sleep.
- [ ] Register watchdog cleanup in every EXIT, INT, TERM, and HUP path.
- [ ] Ensure the watchdog writes its fired marker before terminating the isolated process group.
- [ ] Keep the final process-group kill as defense in depth.
- [ ] Add a test for natural process exit racing the watchdog; natural exit before marker creation preserves the process exit status.
- [ ] Run:

```bash
bash tests/run-isolated.test.sh
bash tests/lane-launchers.test.sh
bash tests/codex-lifecycle.test.sh
```

- [ ] Commit:

```bash
git add scripts/run-isolated.sh tests/run-isolated.test.sh tests/lane-launchers.test.sh tests/codex-lifecycle.test.sh
git commit -m "fix(runtime): enforce portable legacy process timeouts"
```

---

### Task 2: Default Legacy Codex To 900 Seconds

**Files:**
- Modify: `scripts/run-codex-isolated.sh`
- Modify: `tests/codex-lifecycle.test.sh`
- Modify: `agents/codex-implementer.md`
- Modify: `.opencode/agents/codex-implementer.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Unset -> `RUN_TIMEOUT_SECONDS=900`.
- Explicit positive -> exact override.
- Explicit zero -> uncapped compatibility escape hatch.

- [ ] Write a failing adapter-policy test with a stub sibling `run-isolated.sh` that records `RUN_TIMEOUT_SECONDS` for unset, zero, and positive values.
- [ ] Run `bash tests/codex-lifecycle.test.sh`; verify unset records zero.
- [ ] Change the adapter default to `${CODEX_TIMEOUT_SECONDS:-900}` and leave integer validation to the adapter plus enforcement to Task 1.
- [ ] Update both Codex agent variants, README, and Unreleased changelog.
- [ ] Label this path POSIX compatibility only and state that MCP Delegation Spec supersedes it after cutover.
- [ ] Run:

```bash
bash tests/codex-lifecycle.test.sh
bash tests/run-isolated.test.sh
bash scripts/validate-release.sh
```

- [ ] Commit:

```bash
git add scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh agents/codex-implementer.md .opencode/agents/codex-implementer.md README.md CHANGELOG.md
git commit -m "fix(codex): default legacy runs to 900 seconds"
```

---

### Task 3: Separate Validation Failure And Complete The Wire Protocol

**Files:**
- Modify: `src/protocol/delegation-spec.ts`
- Modify: `src/protocol/spec-validator.ts`
- Modify: `src/protocol/attempt-result.ts`
- Create: `src/protocol/host-decision.ts`
- Modify: `runtime/schemas/delegation-spec.v1.json`
- Replace: `runtime/schemas/attempt-result.v1.json`
- Create: `runtime/schemas/host-decision.v1.json`
- Modify: `src/protocol/schema-loader.ts`
- Modify: `CONTEXT.md`
- Modify: existing P0 plan with an amendment pointer
- Modify tests: `spec-validator`, `schema-loader`, `attempt-result`

**Interfaces:** canonical validation, timing, artifact-reference, evidence-reference, termination-source, and Host Decision contracts above.

- [ ] Write failing tests proving invalid spec returns `SpecValidationFailure`, creates no branded spec, and cannot be passed to Attempt Runtime at compile time.
- [ ] Write failing tests proving Attempt schema no longer accepts `invalid-specification`.
- [ ] Write failing tests for timeout minimum 1 on Attempt and verification commands.
- [ ] Write a full valid Attempt Result fixture using artifact references, evidence references, interruption-aware phases, and no inline patch.
- [ ] Delete each required field in turn and assert wire rejection.
- [ ] Add status/failure invariants and `producer-timeout` coverage.
- [ ] Implement branded `ValidatedDelegationSpec` creation only inside successful validation.
- [ ] Remove `invalid-specification` from Failure Classification and precedence.
- [ ] Replace arbitrary evidence object and inline patch schema with closed reference records.
- [ ] Add Host Decision schema with exact hash binding and `fixed|dismissed|blocked` dispositions.
- [ ] Record Attempt Deadline, Attempt Work Phase, Finding Resolution, immutable Attempt Result, and Recovery Record in `CONTEXT.md`.
- [ ] Amend the P0 plan to point to this plan for superseded contracts.
- [ ] Run:

```bash
npx vitest run tests/runtime/spec-validator.test.ts tests/runtime/schema-loader.test.ts tests/runtime/attempt-result.test.ts
npm run typecheck
```

- [ ] Commit exact protocol, schema, test, context, and plan files.

---

### Task 4: Build One Attempt Stop Arbiter And Durable Phase Ledger

**Files:**
- Create: `src/runtime/attempt-lifecycle.ts`
- Create: `src/runtime/phase-event-store.ts`
- Modify: `src/util/errors.ts`
- Create: `tests/runtime/attempt-lifecycle.test.ts`
- Create: `tests/runtime/phase-event-store.test.ts`

**Interfaces:** `ExecutionControl`, Attempt timing, Phase Event, and stop-cause contracts above.

- [ ] Write deterministic arbiter tests using a fake monotonic clock and explicit barriers, not real millisecond sleeps.
- [ ] Cover Host-before-deadline, deadline-before-Host, exact timestamp tie, already-aborted Host signal, and delayed event-loop callback after deadline.
- [ ] Assert one combined signal abort and one immutable stop cause.
- [ ] Write phase tests for completed, failed, cancelled, Attempt-timeout, and finalization-exhausted outcomes.
- [ ] Assert interrupted phases have `endedAt` and `durationMs` equal to the interruption observation, with an interruption outcome rather than completed.
- [ ] Write event-store tests for append order, fsync, restart replay, 256-record cap, heartbeat suppression, and transition retention.
- [ ] Implement monotonic deadline with wall time only for ISO projection.
- [ ] Install the Host listener before starting any phase or deadline timer.
- [ ] Derive canonical cause from Host event monotonic time versus predetermined deadline time.
- [ ] Persist each event before invoking `onProgress`.
- [ ] Make progress callback errors non-fatal.
- [ ] Run focused tests and `npm run typecheck`.
- [ ] Commit lifecycle, event store, errors, and tests.

---

### Task 5: Fix Process Supervisor Escalation And Consume Canonical Stop Control

**Files:**
- Modify: `src/platform/process-supervisor.ts`
- Modify: `tests/runtime/process-supervisor.test.ts`

**Interfaces:**

```ts
export interface ProcessStopControl {
  signal: AbortSignal;
  cause(): AttemptStopCause | null;
}

export interface SuperviseOptions {
  stopControl?: ProcessStopControl;
  timeoutSource?: "operation" | "attempt";
  graceMs?: number;
}
```

- [ ] Replace real 50ms/100ms race tests with deferred barriers that explicitly trigger operation timeout or stop control first.
- [ ] Add a fake Platform Services case where cooperative cancellation never resolves.
- [ ] Verify forced termination is still scheduled and called after grace.
- [ ] Add cases for spawn failure, operation timeout, Attempt timeout, Host cancellation, normal completion, and repeated stop events.
- [ ] Schedule escalation before awaiting cooperative cancellation:

```ts
const requestStop = async (cause: SupervisionStopCause) => {
  if (stopCause !== null) return;
  stopCause = cause;
  escalationTimer = setTimeout(() => {
    void ps.terminateProcessTree(proc).catch(() => undefined);
  }, opts.graceMs ?? 3000);
  try {
    await ps.requestCooperativeCancellation(proc);
  } catch {
    // Forced termination remains scheduled.
  }
};
```

- [ ] On combined signal abort, read only `stopControl.cause()`; never inspect separate Host/deadline signals.
- [ ] Ensure timeout and cancelled flags remain mutually exclusive.
- [ ] Run Process Supervisor and POSIX integration tests plus typecheck.
- [ ] Commit supervisor and tests.

---

### Task 6: Propagate Execution Control Through Preflight, Git, Locking, And Freeze

**Files:**
- Modify/create: `src/git/git-exec.ts`
- Modify/create: `src/git/repo-preconditions.ts`
- Modify/create: `src/git/worktree-manager.ts`
- Modify/create: `src/git/candidate-tree.ts`
- Modify: `src/platform/posix-platform-services.ts`
- Modify/create matching focused tests

**Interfaces:** every process operation receives `ExecutionControl`; `capTimeout` returns operation versus Attempt source.

- [ ] Write deterministic deadline tests for canonicalization, preconditions, lock wait, worktree creation, Git execution, and freeze.
- [ ] Assert no Producer starts after stop control.
- [ ] Make lock acquisition poll the combined signal and cap its 2.5-second local wait to remaining Attempt time.
- [ ] Add `GitExecutionOptions { control?, timeoutMs?, indexFile? }` and propagate timeout source to Process Supervisor.
- [ ] Translate canonical stop control into typed Attempt stop errors, never generic repository failure.
- [ ] Define atomic freeze commit point as successful tree, candidate commit, and anchor update.
- [ ] Before commit point, remove isolated index and partial refs. After commit point, preserve Candidate Artifact.
- [ ] Store patch through ArtifactStore and return only patch ref/hash/bytes.
- [ ] Run exact Git, precondition, worktree, candidate-tree, and POSIX suites plus typecheck.
- [ ] Commit exact files, never stage whole directories.

---

### Task 7: Define Probe, Producer, And Verification Timeout Semantics

**Files:**
- Modify/create Producer adapter, capability probe, routing, Codex adapter
- Modify/create project and acceptance verifiers
- Modify protocol types and focused tests

**Policies:**

- Probe-local timeout: Capability Report unavailable reason `probe-timeout`; routing may try next preference.
- Attempt deadline during probe: fail Attempt timeout; stop all probes; no fallback.
- Producer-local timeout after process start: failed/producer-timeout; no fallback.
- Attempt deadline during Producer: failed/timeout.
- Host cancellation during Producer: cancelled/cancelled.
- Verification-command timeout: verification-failure with timeout source command.
- Attempt deadline during verification: failed/timeout with timeout source Attempt; stop later commands; preserve frozen candidate.

- [ ] Write one failing test per policy before implementation.
- [ ] Add optional adapter-declared Producer operation timeout; omit it when no local cap exists.
- [ ] Pass the same `ExecutionControl` through probes, invocation, and verification.
- [ ] Record `AttemptTerminationSource` exactly.
- [ ] Ensure routing fallback occurs only before Producer process start and never for Host/deadline stops.
- [ ] Run producer, routing, verifier, Attempt Result, and typecheck suites.
- [ ] Commit exact files and tests.

---

### Task 8: Persist And Validate POSIX Process Identity

**Files:**
- Modify: Platform Services contract
- Modify: POSIX Platform Services
- Modify: Process Supervisor result
- Create/modify POSIX process identity tests

- [ ] Write tests for live matching leader, PID reuse mismatch, changed executable hash, changed command hash, missing process, process group with leader, and group with missing leader.
- [ ] Capture identity immediately after spawn and before journal update.
- [ ] Hash canonical executable bytes and canonical serialized command data without storing argv values.
- [ ] Record process group ID and OS-reported process start time.
- [ ] Validate leader start time, executable hash, command hash, and process group before terminating.
- [ ] On missing leader with surviving group members, return identity-mismatch unless every member can be proven to belong to the recorded group identity.
- [ ] Never call `kill(-pid)` from a stale journal without validation.
- [ ] Recovery on identity mismatch retains lock and writes `still-required` Recovery Record.
- [ ] Run POSIX identity, supervisor, and recovery-focused tests plus typecheck.
- [ ] Commit contract, adapter, and tests.

---

### Task 9: Implement Native Windows Job Identity And Crash Termination

**Files:**
- Create/modify: `src/platform/windows-platform-services.ts`
- Create: native Windows Job Object helper under `native/`
- Create: Windows process-helper integration tests
- Create: Windows runtime CI workflow
- Modify: build/release packaging for x64 and arm64 helper artifacts

**Helper contract:**

- create a named Job Object keyed by random `jobId`;
- set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`;
- spawn the resolved Producer without a shell when possible;
- assign the complete process tree to the Job;
- hold the Job handle while monitoring parent process and stdin EOF;
- close the Job and exit when MCP parent disappears;
- expose inspect and terminate modes that validate `jobId`, helper creation time, executable hash, and command hash;
- never terminate from helper PID alone.

- [ ] Write Windows-only failing tests for `.exe`, Node entrypoint, and trusted `.cmd` wrapper with a grandchild.
- [ ] Prove MCP server termination leaves no grandchild.
- [ ] Prove PID reuse and helper identity mismatch do not terminate an unrelated process.
- [ ] Cover locked journal/artifact files, antivirus-style transient sharing violations, rename retries, drive/UNC/Unicode paths, case-insensitive lock keys, and CRLF event streams.
- [ ] Persist Windows process identity from the canonical contract.
- [ ] Implement retry bounds for Windows atomic replace and locked-file cleanup.
- [ ] Publish helper artifacts only after native x64 and arm64 tests pass.
- [ ] Keep platform/Producer combinations diagnostic-only until this gate and write-confinement gate pass.
- [ ] Run Windows CI and archive its test report as release evidence.
- [ ] Commit helper, Platform Services, tests, workflow, and packaging metadata.

---

### Task 10: Implement Explicit Run And Lock State Machines

**Files:**
- Create: `src/runtime/run-journal.ts`
- Create: `src/runtime/finalizer-worker.ts`
- Modify/create: ArtifactStore and Run Manifest
- Create: journal/finalizer tests

**Finalization operation matrix:**

| Operation | Execution | Abort/atomic contract | May outlive return |
|---|---|---|---|
| Phase-event append | Parent, bounded file | append + fsync | No |
| Journal transition | Parent, bounded file | temp + fsync + rename + parent-dir fsync | No |
| Process termination | Platform adapter/helper | supervised escalation | No |
| Worktree removal | Finalizer process | process-controlled Git + filesystem | No |
| Candidate/evidence archive | Finalizer process | bounded chunk writes + atomic rename | No |
| Anchor preservation | Git atomic ref | completed before finalization | No |
| Lock release | Finalizer process after cleanup-complete | atomic/idempotent | No |
| Recovery Record append | Parent, bounded file | append + fsync | No |

- [ ] Write transition-table tests for every allowed and rejected RunState/LockState pair.
- [ ] Test crash snapshots at each boundary:
  1. active/held;
  2. finalizing/held;
  3. recovery-required/held;
  4. cleanup-complete/held;
  5. cleanup-complete/released;
  6. terminal/released.
- [ ] Implement atomic journal replace with file fsync and parent-directory fsync.
- [ ] On Windows, apply bounded sharing-violation retries tested in Task 9.
- [ ] Mark finalizing and recovery-required before spawning finalizer worker.
- [ ] Run all potentially blocking cleanup/archive work in the supervised finalizer process.
- [ ] Persist cleanup-complete while lock remains held.
- [ ] Release lock through supervised finalizer operation.
- [ ] Persist terminal/released only after release confirmation.
- [ ] On budget exhaustion, kill finalizer process tree, retain lock, leave recovery-required, and return without detached work.
- [ ] Run journal, finalizer, ArtifactStore, POSIX, and Windows suites plus typecheck.
- [ ] Commit exact files and tests.

---

### Task 11: Deepen Attempt Runtime And Freeze Immutable Results

**Files:**
- Create/replace: `src/runtime/attempt-runtime.ts`
- Modify: runtime composition root
- Create/modify: Attempt Runtime tests

- [ ] Write deterministic tests for stop during every Attempt work phase.
- [ ] Assert invalid specs cannot enter `run` and create no lifecycle artifacts.
- [ ] Assert interrupted timing outcomes and immutable phase summary match persisted events.
- [ ] Assert candidate null before atomic freeze and preserved after.
- [ ] Assert finalization exhaustion leaves Attempt status unchanged and creates recovery-required state.
- [ ] Construct dependencies once; expose only `run(checkoutPath, validatedSpec, options)`.
- [ ] Persist phase event before progress callback.
- [ ] Compute immutable Attempt Result after primary Attempt outcome and first finalization attempt are known.
- [ ] Canonicalize JSON with recursively sorted object keys and hash it with SHA-256.
- [ ] Store immutable result and hash; never rewrite either during recovery.
- [ ] Return result plus no inline patch or raw evidence.
- [ ] Run Attempt Runtime, lifecycle, journal, protocol, and typecheck suites.
- [ ] Commit runtime, composition, and tests.

---

### Task 12: Recover Without Mutating Attempt Results

**Files:**
- Create/modify: Recovery Manager
- Modify: Controlled Integrator
- Modify: ArtifactStore projections
- Create/modify recovery/integration tests

- [ ] Write recovery tests for each run/lock boundary from Task 10.
- [ ] Validate persisted process identity through Platform Services before termination.
- [ ] Append immutable Recovery Record for completed or still-required recovery.
- [ ] Never edit Attempt Result, result hash, phase events, or Candidate Artifact.
- [ ] Build review projection from immutable result, current journal, and latest Recovery Record.
- [ ] Set `acceptanceAllowed:false` unless terminal/released and no recovery outstanding.
- [ ] Refuse integration on identity mismatch, held lock, nonterminal state, stale result hash, stale tree, or stale manifest.
- [ ] Treat already-removed worktree/process as idempotent success only after identity/state validation.
- [ ] Run recovery and integration suites on POSIX and Windows.
- [ ] Commit exact files and tests.

---

### Task 13: Add Bounded MCP Review, Evidence, And Progress Operations

**Files:**
- Modify/create: MCP tools and server
- Modify/create: tools and handshake tests

**Tool behavior:**

- `delegate`: validation failure or one bounded Attempt.
- `reviewCandidate`: bounded projection only; no inline patch.
- `readCandidateDiff`: selected file or chunked patch, max 262,144 bytes.
- `readEvidence`: allowlisted EvidenceReference only, max 262,144 bytes.
- `decideCandidate`: exact hash-bound decision.
- `integrateCandidate`: exact hash-bound integration.

- [ ] Write failing tests for validation failure without Attempt timing.
- [ ] Write progress-token and no-token tests.
- [ ] Write notification-failure nonfatal test.
- [ ] Write chunk bounds, offset, EOF, ref allowlist, and hash tests.
- [ ] Prove a multi-megabyte binary patch never appears inline in delegate/review JSON.
- [ ] Map persisted Phase Events to MCP notifications only after append succeeds.
- [ ] Use `extra.signal` only as input to the central stop arbiter.
- [ ] Add real MCP handshake tests with `onprogress` and `resetTimeoutOnProgress:true`.
- [ ] Run tools, artifact, handshake, and typecheck suites.
- [ ] Commit exact MCP files and tests.

Reference: MCP TypeScript SDK v1.29 progress uses `extra._meta.progressToken` and `extra.sendNotification({ method:"notifications/progress" })`; cancellation uses `extra.signal`.

---

### Task 14: Bind Host Decisions And Eliminate Deferred Findings

**Files:**
- Modify protocol and MCP decision handlers
- Modify all advisor variants
- Modify Delegate Skill, README, CONTEXT
- Modify decision, routing, and tool tests

- [ ] Write failing tests for stale tree, manifest, and Attempt Result hashes.
- [ ] Write failing tests for blocked findings, unresolved Attempt issues, recovery-pending state, and old accepted-decision replay.
- [ ] Write passing tests for fixed and evidence-backed dismissed findings.
- [ ] Remove `rejected` finding disposition; use `dismissed` to avoid candidate-decision ambiguity.
- [ ] Require accepted Host Decision to bind exact run/result/tree/manifest hashes.
- [ ] Require integration caller to repeat expected hashes and fail closed on mismatch.
- [ ] Make advisor output contract state:

```text
Every valid finding is must-fix, including nits.
A finding ends fixed, dismissed with concrete evidence, or blocked on a named decision.
Blocked means revision-requested and is incompatible with acceptance.
No optional, deferred, follow-up, or fix-later category exists.
```

- [ ] Keep advisor read-only; architect or revision Producer applies every fix and reruns review.
- [ ] Distinguish an evidence-backed out-of-scope dismissal from deferred work.
- [ ] Run protocol, tools, delegate-routing, advisor-contract, and typecheck suites.
- [ ] Commit exact files and tests.

---

### Task 15: Add State-Machine, Property, Cross-Platform, And Incident Regression Gates

**Files:**
- Create/modify: end-to-end vertical slice tests
- Create: lifecycle state-machine test
- Modify fixtures, README, CHANGELOG, release validation

- [ ] Build a deterministic event-sequence generator over:

```text
host cancel
attempt deadline
operation timeout
producer exit
freeze commit
verification failure
finalization exhaustion
recovery completion
```

- [ ] Exercise all valid pairs and selected triples with a fake monotonic clock and deferred barriers.
- [ ] Assert invariants:
  - exactly one primary stop cause;
  - no Attempt Result for validation failure;
  - Candidate Artifact exists only after atomic freeze;
  - finalization never sets Attempt timedOutPhase;
  - lock never releases before cleanup-complete;
  - terminal never transitions to active;
  - recovery never mutates Attempt Result hash;
  - acceptance always matches current result/tree/manifest hashes;
  - integration never occurs during recovery;
  - no inline patch or arbitrary evidence object crosses MCP.
- [ ] Add observed-incident regression: serial Attempts each report their own timing while Host session may remain longer.
- [ ] Run native POSIX process-tree and crash-recovery tests with generous integration margins.
- [ ] Run mandatory native Windows helper, wrapper-grandchild, locked-file, path-casing, recovery, and CRLF tests.
- [ ] Document Host-session time versus Attempt time, phase progress limits, legacy 900/zero policy, immutable recovery projections, bounded diff reads, and no-deferred acceptance.
- [ ] Add all focused suites to release validation.
- [ ] Run non-build gate:

```bash
npm run typecheck
npm test
bash scripts/validate-release.sh
git diff --check
```

- [ ] Ask before build. After approval:

```bash
npm run build
npm test
bash scripts/validate-release.sh
```

- [ ] Verify no survivor process, stale worktree, stale lock, unbounded artifact, secret-bearing journal, or unresolved finding.
- [ ] Commit exact tests, docs, validation, and approved generated runtime bundle.
- [ ] Do not tag or push.

## Final Test Matrix

| Scenario | Required result |
|---|---|
| Invalid spec | `SpecValidationFailure`; no Attempt Result or timing |
| Host before deadline | cancelled/cancelled; termination source host |
| Deadline before Host | failed/timeout; termination source attempt-deadline |
| Exact event-time tie | Host wins by documented rule |
| Probe-local timeout | Producer unavailable; fallback allowed |
| Attempt deadline during probe | Attempt timeout; no fallback |
| Producer-local timeout | failed/producer-timeout; no fallback |
| Attempt deadline during Producer | failed/timeout |
| Verification-command timeout | verification-failure; timeout source command |
| Attempt deadline during verification | failed/timeout; frozen Candidate preserved |
| Stop before freeze commit | Candidate null; no anchor |
| Stop after freeze commit | Candidate preserved |
| Interrupted phase | ended timestamp, duration, interruption outcome |
| Finalization exhaustion | primary outcome unchanged; recovery-required |
| Crash at each journal boundary | deterministic recovery; safe lock ordering |
| PID reuse/identity mismatch | no termination; lock retained; still-required record |
| Windows MCP crash | Job Object closes; no descendants |
| Recovery completion | new Recovery Record; immutable Attempt Result hash |
| Large binary patch | reference only; bounded chunk reads |
| Progress token absent | no notification; durable phase events remain |
| Stale Host Decision | rejected by hash mismatch |
| Valid nit | fixed before acceptance |
| Invalid finding | dismissed with evidence |
| Blocked finding | revision-requested; acceptance false |
| Accepted decision | exact hashes, terminal/released, no outstanding recovery/findings |

## Plan Self-Review Checklist

- [x] Validation failure and Attempt Result are disjoint.
- [x] Attempt work phases and finalization clocks are disjoint.
- [x] Interrupted phase timing is honest and durable.
- [x] Escalation is scheduled before cooperative cancellation.
- [x] One arbiter owns Host/deadline cause across all modules.
- [x] Probe, Producer, verification, and Attempt timeout semantics are explicit.
- [x] Recovery validates platform identity and never trusts PID alone.
- [x] Run-state and lock-state crash boundaries are fully specified.
- [x] Attempt Result is immutable and Recovery Record is append-only.
- [x] Candidate patch and evidence are bounded references.
- [x] Host Decision binds result/tree/manifest hashes.
- [x] Progress notifications project persisted events.
- [x] POSIX and native Windows gates are mandatory and separate.
- [x] Timing tests use fake clocks/barriers, not narrow real sleeps.
- [x] State-machine invariants cover event permutations.
- [x] Task 0 prevents execution against an unreconciled moving branch.
- [x] No valid finding can be deferred or accepted unresolved.
- [x] Build, release, authorship, and Git safety rules are preserved.

## Execution Handoff

Execution is blocked while the existing P0 writer owns or stages changes in this checkout. Task 0 is mandatory after that writer stops.

Two execution options after Task 0 passes:

1. **Subagent-Driven (recommended):** one writer task at a time, then independent spec and quality reviews. Every valid finding is fixed before task acceptance.
2. **Inline Execution:** superpowers:executing-plans in small reviewed batches.

Do not execute from an outdated interface snapshot. Reconcile first, then follow this amendment as authoritative for the affected P0 contracts.
