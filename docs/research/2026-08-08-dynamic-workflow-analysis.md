# Claude Architect — Dynamic Workflow Analysis

**Date:** 2026-08-08
**Scope:** Whole-application analysis of functional specifications and implementation designs.
**Version analyzed:** 0.48.0 (`a870bac`), protocol 2.0.0
**Method:** 13 parallel read-only exploration passes over source, schemas, specs, docs, and tests; cross-checked against live runtime behavior.
**Status:** Analysis report — no repository state was mutated.

---

## 1. Executive summary

Claude Architect is a Claude Code plugin that turns a bounded implementation request into a **reviewable candidate artifact**. Claude (the host session) authors a versioned Delegation Spec; the runtime launches an untrusted Producer CLI (Codex, OpenCode, Pi, Pythinker, or Antigravity CLI) in an isolated Git worktree; the Producer's output is frozen as a hash-anchored candidate; independent verification reruns Host-authorized checks in a clean worktree; and only an accepted, hash-matched candidate can be staged into the user's checkout. Integration never commits — the human (or an explicit promoter) owns commit identity.

The application is layered into 13 source areas plus a packaged runtime, 13 versioned JSON schemas, 5 functional skill/agent specs, a native Windows helper pair, and a ~110-file test suite. The architecture's defining properties are **fail-closed behavior** (unverifiable → unavailable, never degraded), **evidence over Producer claims**, **separated authority** (implementers cannot approve their own work), and **durable, provenance-recorded decisions**.

### Key findings at a glance

| # | Finding | Severity |
|---|---|---|
| F1 | `doctor` MCP tool fails client-side schema validation: its output carries 4 keys undeclared in its advertised schema (`git.path`, `sandboxBackends`, `dependencyClone`, `liveBundle`) → `-32602 data must NOT have additional properties`. **Confirmed live in this session.** | High |
| F2 | `delegatePipeline` full-mode success responses omit `failure` from the declared `result` schema while every `PipelineResult` carries `failure: null` — same bug class as F1. | High |
| F3 | `baselineFailureExitCodes` (RED-intent semantics) is accepted by the spec but deliberately dropped before archive persistence; the archived `requestedVerification` loses it. | Medium |
| F4 | `verification-report.v1.json` is compiled but never invoked for validation; the pipeline's inline verification object adds an `evidence` field the schema forbids — the emitted object would fail its own schema. | Medium |
| F5 | Docs stale vs code: `TRUST_BOUNDARIES.md`, `SECURITY_MODEL.md`, `MARKETPLACE_REVIEW.md` still claim plain `delegate` always requires MCP elicitation; 0.48.0 auto-accepts a clean verified plain delegate under autonomous authority. | Medium |
| F6 | The single per-repository checkout lock serializes all same-repo lanes (by design); cross-repo lanes are genuinely parallel. Worktree *creation* is additionally serialized in-process. | Design constraint |
| F7 | Windows has no certified edit-lane confinement (Codex native sandbox unsupported, Seatbelt unsupported on win32) → Windows edit lanes fail closed. macOS Intel similarly has no certified backend. | Constraint |
| F8 | `handshake.smoke.test.ts` uses `toMatchObject`, so the F1/F2 schema violations are untested — the bug shipped and was only caught by client-side strict validation. | Process |

> **Resolution (same day):** F1, F2, F8, and a third same-class instance found during the fix — the `delegatePipeline` lane-mode envelope did not conform to the declared `result` schema — are fixed: the advertised schemas now declare every returned key, the output objects parse strictly so future drift fails loudly server-side, and `tests/runtime/mcp-output-schema.test.ts` pins byte-exact round-trips of real handler outputs. The Pi delegation lane now always uses the model configured in Pi itself; a requested model override fails the lane explicitly instead of substituting a different (possibly local) model. See `CHANGELOG.md` → `[Unreleased]`.

---

## 2. Scope and method

**Functional specifications analyzed:** `skills/delegate/SKILL.md`, `skills/codex/SKILL.md`, `skills/subagent-driven-delegation/SKILL.md`, `agents/advisor.md`, `agents/claude-advisor.md`, `agents/delegation-lane.md`, plugin manifests.

**Implementation designs analyzed:** `tasks/todo.md`, `tasks/decisions.md`, `tasks/delegation-loop-redesign.md`, `tasks/isolation-plan.md`, `tasks/maestro-integration-plan.md`, `tasks/debate-fold-design.md`, `tasks/lessons.md`, `tasks/scratch.md`, `tasks/wayfinder/*`, task specs (`t9`, `t10`, `t11` variants, `superpowers-spec.json`), `docs/design-review/*`, `docs/research/*`, and the live security/ops docs.

**Implementation analyzed:** all of `src/` (13 areas), `runtime/` (packaged bootstrap/server/watchdog), `native/` (Windows helpers), `scripts/` (build/release), `tests/` (~110 vitest files + 6 release-contract suites), `.github/workflows/`, `.githooks/pre-push`.

The `codebase-memory-mcp` graph index was unavailable in this session; per repository rules the analysis fell back to direct repository search and file reads, executed as 13 parallel read-only agents.

---

## 3. System overview

```
┌────────────────────────────────────────────────────────────────────────┐
│  Claude Code host session                                               │
│  skills/delegate · skills/subagent-driven-delegation · delegation-lane  │
│  agents/advisor · agents/claude-advisor                                 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ MCP (stdio), protocol 2.0.0
┌───────────────────────────────────▼────────────────────────────────────┐
│  .mcp.json → ${CLAUDE_PLUGIN_ROOT}/runtime/bootstrap.mjs                │
│    └─ Node ≥22 resolver → runtime/server.mjs (esbuild bundle of src/)   │
│    └─ runtime/watchdog.mjs (parent-death producer supervision)          │
├────────────────────────────────────────────────────────────────────────┤
│  src/mcp       tool definitions, thin wiring, human elicitation         │
│  src/mcp/tools orchestration: locks, archives, decisions, integration   │
├────────────────────────────────────────────────────────────────────────┤
│  src/protocol  versioned specs, AJV schema loading, spec validation,    │
│                canonical specSha256, candidate decision records         │
├────────────────────────────────────────────────────────────────────────┤
│  src/runtime   attempt lifecycle, artifact store, recovery, worktrees,  │
│                redaction, env policy, run start/manifest/status         │
│  src/pipeline  implement/review/fix rounds, gates, advisor stage,       │
│                slices, role prompts (untrusted-data fencing)            │
│  src/verify    structural + project verification in clean worktrees,    │
│                baseline (RED) verification, dependency linking          │
│  src/producers capability probes, routing, 5 CLI adapters               │
│  src/platform  process supervision, sandbox backends (Seatbelt,         │
│                codex-native), locks, Windows native helpers             │
│  src/git       candidate freeze (tree/commit/anchor ref), manifest      │
│                hash, repo preconditions, git exec                       │
│  src/integrate controlled integration (read-tree apply, no commit)     │
│  src/autopilot multi-task workflow controller, durable workflow store,  │
│                branch manager, promoter, final branch review            │
│  src/ship      GitHub hosting adapter (push, draft PR, required checks) │
│  src/util      errors, stable-file IO, glob matching, path, logger      │
└────────────────────────────────────────────────────────────────────────┘
   ↓ external integration points
   git CLI · Producer CLIs · sandbox-exec · gh CLI · native/win32 .exe
   GitHub Actions CI · Claude Code plugin surface · vendored Superpowers
```

**Durable state** lives under `${CLAUDE_PLUGIN_DATA}`: `runs/<run-id>/` (result, manifest, logs, pipeline artifacts, decisions), `worktrees/<run-id>/`, `locks/`, `workflows/<id>/` (autopilot), `autopilot-branches/`, and removal journals. Git refs `refs/claude-architect/candidates/<run-id>` (and `slices/*`, `prune-backups/*`) keep frozen commits reachable until rejection, integration, or pruning.

---

## 4. Component map

### 4.1 Protocol contracts (`src/protocol/`, `runtime/schemas/`)

| Contract | Schema | Purpose / key fields |
|---|---|---|
| Delegation Spec v1 | `delegation-spec.v1.json` | `objective, context, writeAllowlist, allowedTestDeletions?, forbiddenScope, successCriteria, verification[] (id/executable/args/cwd/env/timeoutMs/network/expectedExitCodes/platform/…), executionMode="edit", timeoutMs, producerPreferences, producerOverrides, slices` |
| Attempt Result v1 | `attempt-result.v1.json` | `runId, status (unavailable/failed/cancelled/verified-candidate), failure, candidate, requestedVerification, executedVerification, evidence`; `oneOf` couples status/failure/candidate |
| Verification Report v1 | `verification-report.v1.json` | `pass, commandResults, workspaceClean, testsDeleted, testsSkipped, scopeViolations` |
| Review / Fix / Increment v1 | `review-report.v1.json`, `fix-report.v1.json`, `increment-report.v1.json` | `verdict`+`findings F-###`; `candidateCommit`+`dispositions`; `status complete/continue/blocked` |
| Candidate Decision v2 | `candidate-decision.v2.json` | `decision, authority (human/policy-autonomous/autopilot-policy/caller-asserted), candidateManifestHash, evidenceHash, policyVersion`; policy authorities may only accept |
| Run Status v1 | `run-status.v1.json` | advisory `phase` (12 values) — writes never affect control flow |
| Advisor Report v1 | `advisor-report.v1.json` | `verdict (approve/human-decision-required), rationale, risks` |
| Autopilot Spec v1 | `autopilot-spec.v1.json` | `topic, base (origin/main), tasks[1..32]{id, commitMessage, delegation}, finalSuccessCriteria, finalVerification, shipping{provider:github, draft, requiredChecks}` |
| Autopilot Eligibility / Workflow State v1 | `autopilot-eligibility.v1.json`, `autopilot-workflow-state.v1.json` | eligibility evidence bundle; 13-phase durable state machine |
| Final Branch Report v1 | `final-branch-report.v1.json` | whole-branch gate: `branchArtifactHash, verificationHash, reviewHashes, eligible` |

**Validation pipeline:** one shared AJV2020 instance (`src/protocol/schema-loader.ts`) compiles all schemas; `src/protocol/spec-validator.ts` layers semantic gates on top (timeout floors, scope-pattern ReDoS bounds, test-deletion glob safety, verification `cwd` escape checks, slice ordering/containment). Producer role output is parsed and schema-validated via `parseStructuredReport` with exactly one repair retry, then fail-closed (`src/pipeline/structured-output.ts`). Archive reads revalidate persisted records (`artifact-store.ts`). `specSha256` is a canonical key-sorted SHA-256 (`src/protocol/spec-hash.ts`), computed at dispatch, persisted at run start, echoed by lane launchers, and enforced by `expectedSpecSha256` correlation.

### 4.2 MCP surface (`src/mcp/`)

12 tools: `validateDelegationSpec`, `delegate`, `delegatePipeline`, `reviewCandidate`, `decideCandidate`, `integrateCandidate`, `doctor`, `gitStatus/Diff/Log/ChangedFiles`, `autopilotStart/Status/Resume`. Handlers in `tools.ts` are deliberately non-thin: they own checkout-lock lifecycle, archive consistency cross-checks, decision advisory, provenance mapping, and anchor deletion; mechanics delegate to runtime/pipeline/integrate/autopilot. Human elicitation (`confirmWithHuman`) fails closed with `elicitation-unavailable` when the client lacks the capability.

### 4.3 Runtime lifecycle (`src/runtime/`)

- `attempt-runtime.ts` — one attempt end-to-end: lock → preconditions → baseline verify → probe/route → worktree + sandbox → supervise → freeze → verify → archive.
- `artifact-store.ts` — crash-safe, write-once archive; prune with journaled cleanup.
- `recovery-manager.ts` — startup reconciliation: liveness via **pid + process start token**, never pid alone; quarantine (`poisoned-<runId>`) on ambiguity; replays worktree-removal journals.
- `worktree-manager.ts` / `worktree-removal-manifest.ts` / `worktree-removal-coordinator.ts` / `worktree-mutation-gate.ts` — durable worktree transactions with inode/birthtime identity checks and quarantine removal.
- `run-start.ts` / `run-manifest.ts` / `run-status.ts` — recovery anchor (`run-start.json` O_EXCL), self-hashed redacted manifest, advisory status.
- `redaction.ts` / `environment-policy.ts` — fixed-point redaction with secret registry; env built from scratch from allowlists, never inherited.
- `producer-preflight.ts` — probes spec verification executables inside the Producer's own sandbox before the attempt window burns.
- `review-snapshot.ts` — binds candidate commit/tree/hash, patch, evidence for review.

### 4.4 Producers (`src/producers/`)

Registry of 5 adapters (Codex, OpenCode, Pi, Pythinker, Agy), each: `probe` (executable resolution, `--version`, auth-store existence, confinement-backend eligibility) → `buildInvocation` (argv arrays, stdin prompt, temp HOME) → `normalizeEvents` (structured JSON parsing, truncation → fail). Routing (`routing-policy.ts`) walks `producerPreferences` and picks the first eligible lane; the attempt runtime re-validates the sandbox backend and fails closed (`no-write-confinement-backend`) if confinement cannot be proven. Codex adapter enforces `--disable multi_agent`, `approval_policy=never`, `network_access=false`, ephemeral config, and shell-environment inclusion policy. No adapter path carries acceptance authority.

### 4.5 Verification (`src/verify/`)

- `structural-verifier.ts` — recomputes the changed-path manifest + hash from Git, checks identity (anchor→commit→tree→base), scope, symlinks, submodules, case collisions, non-emptiness.
- `project-verifier.ts` — reruns Host-authorized commands in a fresh worktree at the candidate commit; platform filters, canonicalized CWD containment, sanitized env, 1 MB stream caps, mutation scans, archived logs.
- `baseline-verifier.ts` — RED evidence: same commands at clean HEAD (`expectBaselineFailure`), vitest no-tests-collected detection.
- `dependency-link.ts` — COW `node_modules` (clonefile/reflink) after byte-equality lockfile check.
- Evidence records `confinement: "none"` and `networkPolicy: "unenforced"` honestly — verification is evidence, not proof.

### 4.6 Pipeline (`src/pipeline/`)

`pipeline-runtime.ts` loops: fresh-context implementer → freeze → **parallel adversarial reviewers** (`reviewer-correctness`, `reviewer-systems`, read-only: empty allowlist, `forbiddenScope: ["**/*"]`) → `consolidator.ts` (dedupe, F-### IDs, severity never downgraded) → fixer (original write policy, must disposition every finding) → rounds until approved → **clean-room final verification** (read-only role, fresh worktree) → `gates.ts` → durable `pipelineGateCleared/Refused` → optional advisor stage (`advisor-stage.ts`). `role-prompts.ts` fences every Producer-adjacent payload in `<<<BEGIN/END UNTRUSTED DATA>>>` markers with neutralized fence strings and a 200k-char cap (advisor uses an exact refuse-to-render variant).

### 4.7 Integration (`src/integrate/`, `src/git/`)

`controlled-integrator.ts` under the checkout lock: precondition suite (dirty tree, in-progress ops, submodules, sparse, bare, unborn, nested repos) → base/HEAD match → manifest hash match → anchor/tree `rev-parse` identity → structural re-verification → `git read-tree -m -u base candidateTree` (index+worktree move; **HEAD stays at base; nothing commits**) → post-apply proof (`write-tree` == candidate tree, quiet diff, porcelain status exactly equals changedPaths) → delete anchor ref with exact-OID guard. Failure modes are classified `aborted:<reason>` / `conflicted:<reason>`; cleanup failures stay visible in evidence.

### 4.8 Platform (`src/platform/`, `native/`)

`process-supervisor.ts`: argv-array spawns (no shell), detached process groups (POSIX) / Job Object (Windows), cooperative cancel → SIGKILL escalation with grace, bounded output, start tokens gate recovery kills. Confinement table (`sandbox/backends.ts`): `codex-native-sandbox` darwin/arm64 **certified**, linux **tested**, win32 **unsupported**; `macos-seatbelt` darwin/arm64 **certified** — states promotable only by real CI. Windows native helpers `win32-job-kill.c` (Job Object terminate, creation-time token) and `win32-filesystem.c` (ACL validation, identity-checked sync/delete) are SHA-256-pinned and byte-compared in CI.

### 4.9 Autopilot (`src/autopilot/`), shipping (`src/ship/`)

`AutopilotController` chains 1–32 pipeline tasks onto a workflow branch: branch create (quarantine-remote fetch, ref transaction) → per-task pipeline → advisor → eligibility → promotion (reuses `controlled-integrator` staging; decisions recorded `autopilot-policy`) → **final branch review** (cumulative artifact, clean-room verification, correctness/systems reviewers, advisor) → push via quarantine bare repo → draft PR → required-checks polling → mark-ready → `ready-for-human-review`. Durability: `WorkflowStore` (hash-chained journal, lease with pid+token, torn-tail tolerance); `resume()` re-enters at the persisted phase; `main` is never mutated — delivery is the PR.

### 4.10 Functional specs (skills/agents)

- `skills/delegate/SKILL.md` — protocol marker `PROTOCOL_VERSION: 2.0.0`; spec-building rules (allowlist, verification commands with `args` not `argv`, `network` enum, baseline semantics); `delegatePipeline` by default for non-trivial work; review/decision/integration discipline; never accept Producer self-reports.
- `skills/codex/SKILL.md` — direct unverified lane, explicitly not the lifecycle.
- `agents/delegation-lane.md` — courier with exactly 2 tools; `responseMode: "lane"`; echoes `laneId/specSha256`, never claims acceptance.
- `agents/advisor.md`, `agents/claude-advisor.md` — strictly read-only (Read/Grep/Glob + 4 bounded git tools), verdict + evidence.

### 4.11 Packaging

`runtime/bootstrap.mjs` (Node-20-parseable) resolves Node ≥ 22 from PATH and re-execs, then `import()`s `runtime/server.mjs` over stdio. `runtime/watchdog.mjs` supervises producer trees (parent-death detection → group SIGTERM → SIGKILL). `esbuild.config.mjs` bundles `src/index.ts` → `runtime/server.mjs` (node22 ESM, banner with `createRequire`); bundle is committed and byte-compared by release validation. `scripts/validate-release.sh` checks artifacts, vendored skills, native-helper hashes, **5 version surfaces** (plugin.json = marketplace.json = README badge = CHANGELOG heading = `RUNTIME_VERSION`), protocol marker match, bundle freshness, then runs plugin validation + contract tests.

---

## 5. Interdependency map

```
mcp/server.ts ──► mcp/tools.ts ──► runtime/attempt-runtime ──► git/candidate-tree, changed-path-manifest
  (thin)            (orchestr.)   ► pipeline/pipeline-runtime ─► runtime (attempt reuse, worktrees)
                                  ► integrate/controlled-integrator ─► verify/structural-verifier, git
                                  ► autopilot/controller ─► pipeline, runtime, ship, verify
                                  ► verify/acceptance-verifier ─► verify/{structural,project,baseline}
                                  ► runtime/artifact-store (read) ─► git refs
                                  ► platform (locks) ─► platform/posix|windows, process-supervisor
                                  ► git/git-exec ─► platform (resolveExecutable, supervise)

runtime/attempt-runtime ─► producers/{probe, route, adapters} ─► platform/{sandbox, seatbelt}
                         ► runtime/{run-start, run-manifest, artifact-store, redaction,
                                     environment-policy, producer-preflight, worktree-manager}
                         ► verify/baseline-verifier
pipeline/role-runner ─► producers (role lanes) + runtime (parentDeathWatchdog)
verify/project-verifier ─► runtime/worktree-manager, platform, runtime/redaction
integrate/controlled-integrator ─► platform (lock), git, verify/structural
autopilot ─► pipeline.executePipeline, runtime/review-snapshot, pipeline/advisor-stage,
             ship/github-cli-adapter (gh), integrate (promoter staging), verify
ship/github-cli-adapter ─► platform (supervise gh), util
protocol/schema-loader ─► consumed by mcp, runtime/artifact-store, pipeline, autopilot
src/index.ts ─► mcp/server, mcp/tools (single bundle entry)
runtime/{bootstrap,watchdog}.mjs ─► external node processes only (no src imports)
native/*.exe ─► platform/windows-platform-services, windows-filesystem-helper
```

**Key edges (trust-critical):** every mutation path converges on the **checkout lock** (`platform`); every acceptance path converges on **decision records** (`protocol/candidate-decision` + `runtime/artifact-store`); every byte entering the checkout converges on **`controlled-integrator`**; every external process goes through **`process-supervisor`**.

---

## 6. Data flows

### 6.1 Single attempt (`delegate`)

```
spec → validateDelegationSpec → specSha256 (canonical hash)
     → delegate{expectedSpecSha256} → revalidate + correlation
     → repo preconditions (clean, single repo, eligible) → checkout lock
     → baseline verify (RED evidence at HEAD)
     → probe producers → route → build invocation → sanitized env + temp HOME
     → managed worktree (detached at base) → sandbox wrap (Seatbelt/codex-native)
     → supervise Producer (argv, stdin prompt, timeouts, watchdog, tree kill)
     → freeze: inventory changes → scope filter → write-tree → commit-tree
       → refs/claude-architect/candidates/<runId> → changed-path manifest hash
     → independent verify: structural (recompute hash, identity, scope)
       + project (clean worktree rerun, mutation scan, archived logs)
     → archive: result.json + manifest.json + logs (redacted, write-once)
     → reviewCandidate: exact patch + manifest + evidence snapshot
     → decideCandidate: authority check → human or autonomous → decision.json
     → integrateCandidate: hash + HEAD guard + lock → read-tree apply
       → post-apply proof → anchor delete → applied (no commit)
```

### 6.2 Pipeline (`delegatePipeline`)

`delegate` flow plus: frozen candidate + test evidence → parallel correctness/systems reviews (fresh read-only sessions, untrusted-fenced prompts) → consolidated `F-###` findings → fixer (original write policy, dispositions with commits) → provenance validation (disposition commits in lineage) → rounds until clean → clean-room final verification (read-only, fresh worktree, zero deleted/skipped tests, no scope violations) → gate evaluation → **durable `pipelineGateCleared` bound to the archived candidate commit** → decision → integration.

### 6.3 Autopilot

`autopilotStart{spec}` → preflight → workflow branch (quarantine fetch, ref txn) → per task: pipeline → review snapshot → advisor → eligibility → promote (staged apply + `autopilot-policy` decision) → cumulative final review → push (quarantine bare repo) → draft PR → required-checks poll → mark ready → `ready-for-human-review`. `autopilotStatus` reads durable state; `autopilotResume` revalidates spec hash, ownership, branch identity, then re-enters at the persisted phase.

### 6.4 Recovery

Startup `recoverStaleRuns()` under `locks/recovery.lock`: pid+token liveness → dead runs reclaimed, live/unverifiable preserved, ambiguous → quarantine; interrupted pipelines archived; worktree-removal journals replayed under the checkout lease; stale locks reclaimed only on proven owner death.

---

## 7. Critical components

1. **Checkout lock** (`src/platform/platform-services.ts`, `posix-platform-services.ts`) — the serialization point for every mutating operation per repository; identity-bound (canonical git common dir), token-gated reclamation. A defect here means concurrent integration races.
2. **Candidate freeze + manifest hash** (`src/git/candidate-tree.ts`, `changed-path-manifest.ts`) — content addressing of the entire candidate; every later gate (review, decision, integration) binds to `manifestHash`.
3. **Independent verification** (`src/verify/acceptance-verifier.ts`) — decides what may be accepted at all; Producer self-reports are never evidence.
4. **Decision authority** (`src/mcp/decision-authority.ts`) — provenance (`human-elicitation` / `policy-autonomous` / `autopilot-policy` / `caller-asserted`) with fail-closed env parsing; only spendable authorities may integrate.
5. **Controlled integrator** (`src/integrate/controlled-integrator.ts`) — the last gate before bytes touch the checkout: hash, base/HEAD, anchor, tree, cleanliness, post-apply equality.
6. **Artifact store + recovery** (`artifact-store.ts`, `recovery-manager.ts`) — durability of state, evidence, and decisions across process death; quarantine instead of guessing.
7. **Redaction** (`src/runtime/redaction.ts`) — privacy invariant applied at every persistence boundary; manifest refuses to persist anything that changes under redaction.
8. **Worktree manager + mutation gate** — isolation guarantee; cleanup is a durable transaction, never a best-effort `prune`.
9. **Pipeline gate durability** — the accept path reads the *archived* attempt, so a gate refusal must outlive the run; `pipelineGateCleared` is commit-bound.
10. **Autopilot workflow store** — hash-chained journal + lease; the only component that ships user code (via PR) autonomously.

---

## 8. Potential bottlenecks

| Bottleneck | Location | Impact / mitigation |
|---|---|---|
| Single checkout lock per repo | `platform` locks | All same-repo lanes serialize (documented; cross-repo lanes parallel). Serial worktree creation (`createWorktreeSerially`) adds a second serialization. |
| Producer latency dominates | `attempt-runtime` / `role-runner` | LLM wall-clock up to `timeoutMs` (max 30 min); pipeline multiplies by 2 reviewers + fixer rounds + verifier; MCP stdio channel is blocked while a run is in flight. |
| Verification is double-cost | `baseline-verifier` + `project-verifier` | RED baseline + GREEN candidate reruns; per-command sequential execution; mitigated by `node_modules` COW linking, otherwise `none`. |
| Human elicitation pause | `confirmWithHuman` | 15-minute elicitation timeout; non-autonomous decisions block until a human answers; `elicitation-unavailable` fails closed. |
| Windows edit lane unavailable | `sandbox/backends.ts` | No certified backend on win32 → all Windows edit lanes fail closed; macOS Intel identical. Windows kill fallback (`TerminateProcess` root only) is a tree-kill gap when the target is in a non-joinable job. |
| gh CLI shipping ops | `src/ship/github-cli-adapter.ts` | `gh pr checks` polling (10 s interval, up to 3.6 M ms timeout) and push/pr operations run under 60 s / 1 MB bounds; PR identity is in-memory only (lost on resume). |
| Startup recovery | `recovery-manager.ts` | Serialized under `recovery.lock`; unverifiable process tokens preserve locks (safe but can strand). |
| Prune / cleanup | `artifact-store.ts` | Serialized under the checkout lease; removal is multi-phase with identity rechecks. |
| Env-building + redaction fan-out | `environment-policy.ts` / `redaction.ts` | Per-spawn cost; every log/evidence path re-redacts (fixed-point). |

---

## 9. Integration points

1. **Git CLI** — deepest integration: worktrees (`add --detach`), object store, `read-tree`/`update-index`/`write-tree`, refs under `refs/claude-architect/*`, `status --porcelain -z`, `diff-tree --raw`; executed only via argv arrays through `PlatformServices`.
2. **Producer CLIs** — `codex exec --json --ephemeral --sandbox … --disable multi_agent`, `opencode run --agent build --auto`, `pi -p --no-session --no-skills`, `pythinker --prompt`, `agy -p --dangerously-skip-permissions`; capability + auth + confinement probed per attempt.
3. **Claude Code plugin surface** — `${CLAUDE_PLUGIN_ROOT}` (runtime resolution), `${CLAUDE_PLUGIN_DATA}` (mandatory state), MCP stdio, client elicitation capability, subagent lanes, hooks-free (no hooks shipped).
4. **macOS Seatbelt** (`/usr/bin/sandbox-exec`) — write confinement for non-Codex adapters; Codex native sandbox where certified.
5. **Windows native helpers** — `win32-job-kill-{x64,arm64}.exe`, `win32-filesystem-{x64,arm64}.exe`; SHA-256 pinned, CI byte-compares rebuilds.
6. **GitHub (`gh` CLI)** — autopilot shipping: preflight, quarantine-remote push, draft PR create/verify, required-checks polling, mark-ready.
7. **GitHub Actions CI** — 3-OS matrix (macos-15/ubuntu/windows) + windows-arm64 job; native helper rebuild byte-compare; POSIX `validate-release.sh`; `.githooks/pre-push` consults CI conclusions and hard-blocks tag pushes without a green Windows run.
8. **Superpowers skills** — vendored filtered subset (`vendor/superpowers/skills/`: TDD, systematic-debugging, verification-before-completion) offered to Producers; host-side full set usable by the architect.
9. **Host verification toolchain** — arbitrary spec-declared executables rerun by verification (allowlist-resolved, sanitized env, platform-filtered).

---

## 10. Contract and consistency findings

### 10.1 Live schema violations (F1, F2)

- **F1 — `doctor` output violates its advertised schema.** `doctorOutput` (`src/mcp/server.ts:119-127`) declares `node/git/producers/runtimeVersion/schemaVersion/protocolVersion/issues`; `DoctorResult` (`src/mcp/doctor.ts:791-802`) adds `git.path`, `sandboxBackends`, `dependencyClone`, `liveBundle`. The SDK strips unknown keys server-side, but Claude Code's strict client validation rejects the structured content with `-32602 … data must NOT have additional properties`. **Observed live during this analysis** (the `mcp__runtime__doctor` call failed exactly this way, including `data/git`).
- **F2 — `delegatePipelineOutput.result` omits `failure`** (`server.ts:66-88`) while every `PipelineResult` carries `failure: null` — full-mode success responses violate their declared schema.
- F8 — `tests/runtime/handshake.smoke.test.ts:326` asserts with `toMatchObject`, so neither violation is covered.

**Recommended fix:** add the four keys to `doctorOutput`, add `failure` to `delegatePipelineOutput.result`, and strengthen the handshake smoke test to strict-match the advertised schema (e.g. `toStrictEqual` on a parsed object or a schema-based assert).

### 10.2 Contract gaps

- **F3 — `baselineFailureExitCodes` dropped at archive.** Allowed in `delegation-spec.v1.json:113-117` and the TS type, absent from `attempt-result.v1.json` `$defs/verificationCommand`, and deliberately dropped by `sanitizeVerificationCommand` (`artifact-store.ts:480-507`) — archived `requestedVerification` loses RED-intent semantics.
- **F4 — `verification-report.v1.json` dead schema.** Compiled in `schema-loader.ts` but never invoked; the pipeline builds its verification object inline with an extra `evidence` field that `additionalProperties: false` forbids — the emitted object would fail its own schema. Only used as prompt text.
- `context` lacks a `minLength` while `objective` requires ≥1 (likely unintentional asymmetry).
- `RUNTIME_VERSION` sync (versions.ts ↔ plugin.json ↔ docs) is enforced only by `validate-release.sh`, not by code.

### 10.3 Doc-vs-code drift

- **F5 — 0.48.0 changed plain-delegate autonomy; docs not updated.** `docs/TRUST_BOUNDARIES.md:22`, `docs/SECURITY_MODEL.md:39`, `docs/MARKETPLACE_REVIEW.md:44` still say plain `delegate` always elicits a human; commits `6f73eb2`/`b4efdb8` auto-accept a clean, independently verified plain delegate under autonomous authority (positive provenance recorded).
- `SECURITY_MODEL.md:37-38` uses retired `decidedBy` vocabulary; `tasks/decisions.md` retired `RunDecisionRecord` in favor of the versioned `CandidateDecision` with `authority`.
- `marketplace.json` description omits Antigravity (`agy`), present in the roster, `agy-adapter.ts`, and the delegate skill.
- `tasks/wayfinder/parallel-execution-decision.md` names `maxParallelSlices`; code implements `sliceConcurrency` + per-slice `dependsOn`.
- `tasks/wayfinder/visibility-ux-decision.md` names `architect-status.sh`; shipped asset is `assets/statusline/delegation-status.sh`.
- `tasks/debate-fold-design.md` §4 still asserts the `verifiedClean` hole as live (fixed by `c2b40dc`).
- `docs/PLUGIN_COMPONENTS.md` stamps 0.15.0 while describing the 0.48.0 surface (minor).

### 10.4 Design-doc status

- `tasks/maestro-integration-plan.md` (P0–P4, including read-only Codex on win32 and a fixer-rebuttal adjudicator) — **pending**, not implemented; P3 adjudication shipping decision undecided.
- `docs/design-review/enhancement-plan.md` (dynamic-workflow rev 3) — superseded in spirit by the shipped serial `AutopilotController`.
- `tasks/isolation-plan.md` — units largely implemented; 3 human open questions remain (MCP auto-restart blast radius, partitioning approval, Windows parity).
- `tasks/wayfinder/windows-gate-run.md` — **open**: Windows Codex edit-lane promotion requires a human GitHub secret (HITL gate).
- `tasks/delegation-loop-redesign.md` — R6 (parallel slices) implemented; R5 partially absorbed.
- `tasks/debate-fold-design.md` §10 — unswept targets: same-vendor review compensation, slice DAG.

---

## 11. Test coverage and quality gates

- **Vitest suite** (`tests/runtime/`, ~110 files): unit (module-per-test mirroring `src/`), integration (real Git worktrees/remotes: e2e-pipeline, attempt-runtime, artifact-store, recovery-manager, controlled-integrator, lock-contention, process-supervisor, watchdog, autopilot e2e/recovery/adversarial), adversarial (seatbelt escapes, redaction prototype pollution, changed-path-manifest malformed output, shipping red paths, windows helper resolve), smoke (`bootstrap.smoke`, `handshake.smoke`).
- **Release-contract suites** (plain node/bash): plugin-manifest version sync, delegate-routing protocol markers, validate-release preflight, lane-launcher absence, install-opencode migration, claude-runtime-resolver smoke.
- **Invariants asserted:** implementers cannot approve own work (role-runner/role-prompts), hash mismatch/HEAD guards (controlled-integrator, mcp-input-schema), decision provenance (decision-authority, legacy-decision-provenance, human-decision-gate, mcp-decision-gate), redaction, confinement fail-closed, tree kill/cancellation, gate non-convergence, lock contention without token disclosure, bundle freshness (live-bundle).
- **Gaps:** `worktree-removal-coordinator.ts` has no direct test; `bounded-buffer`, `glob`, `lock-owner`, `run-start`, `state-dir`, `worktree-mutation-gate` are only transitively covered; no direct server-validation tests beyond `mcp-input-schema`; no performance/load tests; no opt-in real-Producer smoke tests in the suite.
- **Gates:** `npx tsc --noEmit` (TS 7 native), `npx vitest run`, `scripts/validate-release.sh`, `claude plugin validate --strict .`; `.githooks/pre-push` runs typecheck + full vitest (`--maxWorkers=4`), consults CI via `gh` (refuses pushes onto failed CI; warns on red main; hard-blocks tags without a completed green run including a green Windows job). CI matrix: macos-15 / ubuntu-latest / windows-latest + windows-11-arm native byte-compare job; CodeQL workflow present.

---

## 12. Risks and recommendations

1. **Fix F1/F2 immediately** — a broken `doctor` is user-facing diagnostic tooling; the delegatePipeline success response violating its own schema can break client-side contract checks. Add the missing fields to the schemas and make the handshake smoke test strict (F8). *(Within scope of this analysis; requires a code change + bundle rebuild + contract test.)*
2. **Resolve F3/F4** — either persist `baselineFailureExitCodes` in the attempt-result schema or drop it from the spec schema; either validate the pipeline verification object against `verification-report.v1.json` or extend the schema with `evidence`.
3. **Update the stale security docs (F5)** — the autonomous plain-delegate behavior is deliberate and recorded in code; prose must not claim the old always-human behavior.
4. **Windows strategy** — the Windows edit lane is fail-closed by design; the pending `windows-gate-run.md` HITL gate and maestro P0 (read-only Codex on win32) are the tracked paths. Document the job-object tree-kill fallback gap explicitly.
5. **Bottleneck awareness** — same-repo serialization, verification cost, and MCP channel blocking are structural; surfaced lanes (`delegation-lane`) mitigate UX but not runtime serialization. Slices (`sliceConcurrency` ≤ 8, dependency-ordered) are the supported parallelism mechanism.
6. **Coverage gaps** — add direct tests for `worktree-removal-coordinator`, `worktree-mutation-gate` refusal, and `lock-owner`; the mutation gate is a trust-boundary component currently only indirectly tested.

---

## 13. Appendix — source map (quick reference)

| Area | Modules |
|---|---|
| protocol | `versions, delegation-spec, attempt-result, candidate-decision, autopilot-spec, schema-loader, spec-validator, spec-hash` |
| mcp | `server, tools, doctor, decision-authority, git-read-tools, serialize` |
| runtime | `attempt-runtime, artifact-store, recovery-manager, worktree-manager, worktree-removal-{manifest,coordinator}, worktree-mutation-gate, run-start, run-manifest, run-status, redaction, environment-policy, producer-preflight, reproducibility, review-snapshot, state-dir` |
| producers | `producer-registry, producer-adapter, capability-probe, routing-policy, codex-adapter, opencode-adapter, pi-adapter, pythinker-adapter, agy-adapter, plain-text, skill-bootstrap` |
| verify | `acceptance-verifier, structural-verifier, project-verifier, baseline-verifier, dependency-link` |
| pipeline | `pipeline-runtime, role-runner, role-prompts, consolidator, gates, advisor-stage, structured-output, slice-scheduler, slice-runner, slice-composer, report-types` |
| git | `candidate-tree, changed-path-manifest, git-exec, repo-preconditions` |
| integrate | `controlled-integrator` |
| platform | `platform-services, posix-platform-services, windows-platform-services, windows-env, windows-filesystem-helper, process-supervisor, select-platform, lock-owner, durable-directory, bound-directory-cleanup, sandbox/{backends,seatbelt}` |
| autopilot | `autopilot-controller, workflow-store, branch-manager, candidate-promoter, final-branch-reviewer, autopilot-eligibility` |
| ship | `hosting-adapter, github-cli-adapter` |
| util | `errors, stable-file, glob, platform-path, logger, bounded-buffer` |
