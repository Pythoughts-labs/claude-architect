# Claude Architect P0 Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shell-script/Bash-tool delegation surface (v0.7.0) with a trusted TypeScript/Node MCP-server runtime that turns an untrusted Producer CLI's edits into an independently verified, content-addressed Candidate Artifact that Claude reviews and the runtime integrates — delivering the **P0-A vertical slice** end to end on one certified environment.

**Architecture:** A stdio MCP server bundled into the `claude-architect` plugin owns the whole trusted path: it validates a Host-authored Delegation Spec, probes and routes to a Producer CLI (Codex first), runs it in an isolated Git worktree under process supervision, freezes the result as a base-bound content-addressed Git tree, verifies scope + declared checks without importing candidate code, and — only on an explicit Host decision — integrates that exact tree into the main checkout. The runtime is the validation authority; Producer output and self-reports are untrusted evidence. Main Claude never runs Git for delegation; it calls structured MCP tools (`delegate`, `reviewCandidate`, `decideCandidate`, `integrateCandidate`, `doctor`).

**Tech Stack:** TypeScript (strict) on Node.js ≥ 22 · `@modelcontextprotocol/sdk` (stdio server) · `zod` (tool + spec schemas) · `ajv` (JSON-Schema validation of versioned wire types) · `execa`-free (native `node:child_process` for supervised spawn) · `vitest` (unit/integration) · `esbuild` (bundle the runtime to one self-contained `runtime/server.mjs` — no shipped `node_modules`) · Git plumbing (`read-tree`, `write-tree`, `commit-tree`, `hash-object`, `ls-tree`, `update-ref`).

---

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from `CONTEXT.md` (the "Revised Verdict" spec) and the project's `AGENTS.md`.

- **Platforms (matrix):** native macOS (arm64, x64); Linux (x64, arm64) on glibc **and** musl; native Windows (x64, arm64). WSL 2 is treated as Linux and **never** satisfies the native Windows requirement. Native Windows and WSL are probed, tested, and reported **separately** — never merged into one "Windows" claim.
- **Runtime floor:** Node.js **22 or later** is required and must be refused below 22 even when an older `node` is found first. The plugin also requires Claude Code, Git, and at least one eligible Producer CLI. Claude Architect must **not** be described as "zero-dependency" or "universal" while these prerequisites hold.
- **P0 Lane:** the trusted Attempt Runtime supports the **implementation Lane only**. Other Lanes are deferred.
- **No shell dependency in shipped runtime:** the shipped path must not depend on shell-generated command strings, the Bash tool's `PATH`, Bash shebangs, `chmod +x`, `.sh`/`.cmd` launchers as the transport, Unix-only path syntax, Unix file modes, Unix-only process semantics, or Claude composing a shell command string. Shell scripts may support repo development and CI only.
- **Invocation:** the public command is the namespaced Skill `/claude-architect:delegate`. Docs, examples, and screenshots must never present bare `/delegate` as the normal command.
- **Plugin paths:** resolve packaged assets through `${CLAUDE_PLUGIN_ROOT}` (changes on every update; previous version is ephemeral — **never** write run state, archives, or locks under it). Persistent state (archived runs, locks) lives under `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/{id}/`, survives updates).
- **Nested delegation:** denied unconditionally in P0. The runtime sets `CLAUDE_ARCHITECT_DELEGATED=1` and refuses to start when that marker is already present.
- **One active attempt:** P0 allows one active editing Delegation Attempt per base checkout; the checkout lock is keyed by the **canonical Git common directory**, not the user-supplied path. P0 requires a clean main checkout before an editing attempt starts.
- **Untrusted Producers:** Producer output, claims, path discipline, and failure reporting may be wrong. Successful exit and self-reported verification never imply acceptance. A zero exit code never overrides invalid output, scope violations, or failed verification. `authentication-required` never triggers automatic fallback; after a Producer process starts, no failure triggers automatic fallback in P0.
- **Symlinks:** P0 rejects new or modified symbolic links rather than proving target confinement.
- **Redaction:** sensitive env values and known credential forms are redacted before any event, log, or result is persisted, including Git status/diff/log outputs. The Run Manifest records env-var **names** and redacted provenance, never secret values.
- **Advisor:** the bundled `claude-architect:advisor` agent is strictly non-mutating with an explicit `Read, Grep, Glob` (+ scoped read-only Git MCP tools) allowlist; it never receives Bash, Write, or Edit. Plugin agents cannot declare their own `mcpServers`, `hooks`, or `permissionMode` (confirmed against the plugin reference), so read-only Git operations are exposed as tools on the plugin MCP server and allowlisted by scoped name.
- **Release cadence (`AGENTS.md`):** advance the **minor** version for every marketplace release (`0.7.0` → `0.8.0` → `0.9.0`); never publish patch tags. Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README version badge, and `CHANGELOG.md` on the same version. Run `bash scripts/validate-release.sh` before every release push; never tag or push when it fails.
- **Commit messages (user override — `~/.claude/CLAUDE.md`):** commit messages and PR bodies are authored as if by the user alone. **Never** append `Co-Authored-By: Claude`, any Claude/Anthropic co-author trailer, or a "Generated with Claude Code" footer. Every "Commit" step in this plan omits them deliberately.

---

## Scope Of This Plan

The spec (`CONTEXT.md` → "Release Sequencing") already decomposes P0 into three staged subsystems. Per the writing-plans Scope Check, this document is scoped so each stage is its own working, testable deliverable:

| Stage | This document | Why |
|---|---|---|
| **P0-A — Protocol & vertical slice** | **Fully detailed, bite-sized TDD tasks (Tasks 1–25).** | The smallest slice that produces working, integration-capable software: MCP bootstrap, schemas, POSIX Platform Services, the content-addressed Git-tree artifact, the Codex adapter, **one certified environment (macOS arm64 — a deliberate reduction from the spec's per-OS wording; see C7 scope note and the published support matrix)**, Acceptance Verification, and Controlled Integration. |
| **P0-B — Cross-platform hardening** | **Roadmap section** (interfaces, acceptance gates, code sketches for the hard parts). Becomes its own detailed plan when P0-A lands. | Windows Platform Services, native process-tree helper, concrete Sandbox Backends, path/locking/Unicode/wrapper tests, and full crash recovery. Its interfaces will shift once P0-A is real, so detailing to TDD depth now would bake in rework. |
| **P0-C — Producer completion** | **Roadmap section.** Its own detailed plan when reached. | OpenCode/Pi/Pythinker adapters, per-platform capability certification, and the final universal release gates. |

"Everything in detail" is honored by **depth on the buildable slice (P0-A)**, not by breadth across the two unbuilt stages.

---

## Migration From v0.7.0 (read before Task 1)

The repo currently ships a shell/Bash-tool delegation surface: `scripts/run-*-isolated.sh`, `skills/delegate/SKILL.md` (routes to `*-implementer` Agent subagents), five `agents/*.md`, and `.sh`/`.mjs` tests. The new runtime is **additive during P0-A and cuts over at P0-C**, so a working plugin is preserved the whole way:

- **Add, don't delete (P0-A):** the TS runtime lands under `runtime/`, `native/`, and new `tests/runtime/`. The legacy `scripts/`, existing `agents/`, and `tests/*.sh`/`*.mjs` stay in place and keep passing. `validate-release.sh` continues to gate the legacy surface.
- **Skill (P0-A, Task 23):** `skills/delegate/SKILL.md` is **rewritten** so `/claude-architect:delegate` drives the new MCP `delegate` tool. The old Agent-subagent lanes (`codex-implementer`, etc.) remain available as a documented fallback until P0-C. The `.opencode/`, `.pi-subagents/`, `.pythinker/` scratch dirs are untouched.
- **Advisor (P0-A, Task 23):** a new `agents/advisor.md` is added with the read-only allowlist. The existing `agents/claude-advisor.md` is left in place; the delegate flow references `claude-architect:advisor`.
- **Cutover (P0-C):** once all four adapters are certified, remove the superseded `scripts/run-*-isolated.sh` launchers and the `*-implementer` prose lanes in one release, updating `validate-release.sh` accordingly. That deletion is **out of scope for P0-A** and appears only in the P0-C roadmap.
- **Versioning:** internal P0-A development does not release. The first marketplace release of the runtime is **`0.8.0`** at the P0-A release gate (Task 25). P0-B → `0.9.0`, P0-C → `0.10.0`, matching the minor-bump cadence.

---

## File Structure

New runtime files (all under the plugin root, resolved at runtime through `${CLAUDE_PLUGIN_ROOT}`). Each file has one clear responsibility; files that change together live together.

```text
claude-architect/
├── .claude-plugin/
│   ├── plugin.json                      # MODIFY: version bump; unchanged component layout
│   └── marketplace.json                 # MODIFY: version bump
├── .mcp.json                            # CREATE: stdio MCP server → runtime/bootstrap.mjs
├── package.json                         # CREATE: TS runtime deps + build/test scripts
├── tsconfig.json                        # CREATE: strict TS, NodeNext, target ES2023
├── vitest.config.ts                     # CREATE: test config
├── esbuild.config.mjs                   # CREATE: bundle runtime → runtime/server.mjs (dev)
├── skills/delegate/SKILL.md             # MODIFY (Task 23): drive the MCP delegate tool
├── agents/advisor.md                    # CREATE (Task 23): non-mutating advisor allowlist
├── runtime/                             # BUILT OUTPUT + bootstrap (committed, .mjs)
│   ├── bootstrap.mjs                    # CREATE: Node-locator + version-gate + launches server.mjs
│   ├── server.mjs                       # BUILT: esbuild bundle of src/ (committed for offline install)
│   └── schemas/                         # CREATE: JSON Schemas (source of truth for wire types)
│       ├── delegation-spec.v1.json
│       └── attempt-result.v1.json
├── native/                              # P0-B: Windows process-tree helper (stub dir in P0-A)
│   └── README.md                        # CREATE: documents the P0-B helper contract
├── src/                                 # TS SOURCE (bundled into runtime/server.mjs)
│   ├── protocol/
│   │   ├── versions.ts                  # protocol + schema version constants
│   │   ├── delegation-spec.ts           # DelegationSpec type + zod + ajv validator glue
│   │   ├── attempt-result.ts            # AttemptResult type, statuses, FailureClassification
│   │   ├── schema-loader.ts             # compiled ajv validators (Ajv2020)
│   │   └── spec-validator.ts            # SpecValidator (repair loop, structured errors)
│   ├── platform/
│   │   ├── platform-services.ts         # PlatformServices interface + types
│   │   ├── posix-platform-services.ts   # PosixPlatformServices (P0-A)
│   │   ├── select-platform.ts           # returns the PlatformServices for the current OS
│   │   └── process-supervisor.ts        # ProcessSupervisor (timeout/drain/limits/exit)
│   ├── git/
│   │   ├── git-exec.ts                   # thin argv-array git runner (no shell)
│   │   ├── repo-preconditions.ts        # supported/rejected repository state matrix
│   │   ├── worktree-manager.ts           # WorktreeManager (create/remove from base)
│   │   └── candidate-tree.ts             # content-addressed artifact construction + manifest
│   ├── runtime/
│   │   ├── attempt-runtime.ts            # AttemptRuntime orchestration
│   │   ├── environment-policy.ts         # layered env construction + allowlist
│   │   ├── redaction.ts                  # secret/credential redaction
│   │   ├── artifact-store.ts             # archive under CLAUDE_PLUGIN_DATA
│   │   ├── run-manifest.ts               # Run Manifest builder
│   │   └── recovery-manager.ts           # stale-run detection + cleanup (P0-A minimal)
│   ├── producers/
│   │   ├── producer-adapter.ts           # ProducerAdapter contract + CapabilityReport type
│   │   ├── producer-registry.ts          # machine facts registry
│   │   ├── routing-policy.ts             # Host-ordered preference filter
│   │   ├── capability-probe.ts           # per-attempt probe (no side effects)
│   │   └── codex-adapter.ts              # CodexAdapter (P0-A)
│   ├── verify/
│   │   ├── structural-verifier.ts        # packaged structural checks (no candidate import)
│   │   ├── project-verifier.ts           # Host-authorized command execution
│   │   └── acceptance-verifier.ts        # orchestrates both stages → evidence
│   ├── integrate/
│   │   └── controlled-integrator.ts      # integrateCandidate mutation into main checkout
│   ├── mcp/
│   │   ├── server.ts                     # McpServer wiring + tool registration + serialization
│   │   ├── tools.ts                      # delegate/review/decide/integrate/doctor handlers
│   │   ├── serialize.ts                  # per-canonical-repo async mutex (one active attempt)
│   │   ├── bootstrap-check.ts            # pure Node-version helpers (tested)
│   │   ├── git-read-tools.ts             # read-only git tools for the advisor allowlist
│   │   └── doctor.ts                      # Doctor diagnostics
│   ├── util/
│   │   ├── logger.ts                     # stderr-only structured logger (never stdout)
│   │   ├── bounded-buffer.ts             # bounded output capture with truncation facts
│   │   └── errors.ts                     # typed runtime errors
│   └── index.ts                          # real entrypoint: builds server, connects stdio
└── tests/runtime/                        # vitest suites (mirrors src/ layout)
    ├── fixtures/                          # fake-producer scripts, captured native events
    └── ... (one suite per src module)
```

---

## Canonical Contracts (single source of truth)

Every task consumes types from this section. When a task's step writes one of these types, it uses **these exact names and shapes**. Do not redefine them per task.

### C1 — Protocol versions (`src/protocol/versions.ts`)

```ts
export const PROTOCOL_VERSION = "1.0.0" as const;      // MCP tool contract version
export const DELEGATION_SPEC_VERSION = "1" as const;   // wire schema major
export const ATTEMPT_RESULT_VERSION = "1" as const;
export const RUNTIME_VERSION = "0.8.0" as const;       // mirrors plugin.json at release
```

### C2 — DelegationSpec (`src/protocol/delegation-spec.ts`)

```ts
export interface VerificationCommand {
  id: string;
  executable: string;               // resolved via PlatformServices.resolveExecutable
  args: string[];
  cwd: string;                      // relative to the materialized candidate root
  environment?: Record<string, string>;
  timeoutMs: number;                // bounded by RUNTIME_MAX_TIMEOUT_MS — schema enforces maximum
  network: "denied" | "allowed";
  expectedExitCodes: number[];
  platform?: { os?: Array<"darwin" | "linux" | "win32">; arch?: string[] };
}

export interface DelegationSpec {
  specVersion: "1";
  objective: string;                         // observable outcome
  context: string;                           // relevant background for the Producer
  writeAllowlist: string[];                  // positive path globs; repo-wide MUST be explicit ["**"]
  forbiddenScope: string[];                  // path globs never to touch
  successCriteria: string[];
  verification: VerificationCommand[];       // Host-authorized checks only
  executionMode: "edit";                     // P0: implementation Lane only
  timeoutMs: number;                         // wall-clock; bounded by RUNTIME_MAX_TIMEOUT_MS
  producerPreferences: string[];             // ordered producer ids, e.g. ["codex"]
  producerOverrides?: { model?: string; reasoningEffort?: string };
  expectedOutput: "candidate-patch";         // P0 canonical output
}

export const RUNTIME_MAX_TIMEOUT_MS = 1_800_000; // 30 min hard ceiling
```

### C3 — AttemptResult, statuses, FailureClassification (`src/protocol/attempt-result.ts`)

```ts
export type AttemptStatus = "unavailable" | "failed" | "cancelled" | "verified-candidate";

// Precedence order is the ARRAY order below (earliest wins). AttemptRuntime.classify()
// walks this list; the first applicable reason is the canonical FailureClassification.
export const FAILURE_PRECEDENCE = [
  "invalid-specification",
  "unavailable",                 // pre-launch unavailability
  "authentication-required",     // pre-launch; never triggers fallback
  "spawn-failure",
  "cancelled",                   // per the initiating runtime event
  "timeout",
  "sandbox-violation",
  "invalid-output",
  "producer-failure",
  "verification-failure",
] as const;
export type FailureClassification = (typeof FAILURE_PRECEDENCE)[number];

export interface ChangedPath {
  path: string;                  // repo-relative, forward-slash normalized
  changeType: "added" | "modified" | "deleted";
  mode: string;                  // git mode, e.g. "100644"
  contentHash: string | null;    // blob oid; null for deletions
}

export interface CandidateArtifact {
  baseCommitOid: string;
  candidateTreeOid: string;
  candidateCommitOid: string;    // anchors the tree against GC (Task 9)
  anchorRef: string;             // refs/claude-architect/candidates/<runId>
  manifestHash: string;          // sha256 over the sorted ChangedPath manifest
  changedPaths: ChangedPath[];
  patch: string;                 // git diff --binary --full-index (review/portability only)
}

export interface CommandOutcome {
  id: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutRef: string;             // archive pointer (redacted, bounded)
  stderrRef: string;
}

export interface AttemptResult {
  resultVersion: "1";
  runId: string;
  status: AttemptStatus;
  failure: FailureClassification | null;   // null iff status === "verified-candidate"
  summary: string;                          // runtime-authored; producer summary is a separate untrusted field
  producerSummary: string | null;           // UNTRUSTED
  // Non-null whenever freezing SUCCEEDED, regardless of verification outcome. Spec: "a changed base
  // preserves the Candidate Artifact but yields verification-failed." So a verification-failure result
  // still carries the frozen artifact (tree oid, anchor ref, manifest, patch) and archives it.
  // Null only when no candidate was ever frozen (unavailable / spawn-failure / invalid-output / empty-candidate).
  candidate: CandidateArtifact | null;
  requestedVerification: VerificationCommand[];
  executedVerification: CommandOutcome[];
  unresolvedIssues: string[];
  evidence: Record<string, unknown>;        // structural + project verification evidence
  logsRef: string;                          // archive pointer
  producerId: string | null;
  producerVersion: string | null;
  producerModel: string | null;
  durationMs: number;
  sessionId: string | null;
}
```

### C4 — PlatformServices (`src/platform/platform-services.ts`)

```ts
export interface ExecutableRequest {
  name: string;                     // e.g. "codex", "git", "node"
  explicitPath?: string;
  searchPath?: string;              // overrides process PATH when set
}
export interface ResolvedExecutable {
  kind: "native" | "node-entrypoint" | "cmd-wrapper";
  command: string;                  // argv[0] actually spawned
  prefixArgs: string[];             // e.g. ["<entry.js>"] for node-entrypoint
  resolvedFrom: string;             // provenance for the Run Manifest
}
export interface SpawnRequest {
  executable: ResolvedExecutable;
  args: string[];
  cwd: string;
  env: Record<string, string>;      // fully constructed; host env NOT inherited wholesale
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes: number;
}
export interface SupervisedProcess {
  pid: number;
  done: Promise<SupervisedExit>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}
export interface SupervisedExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;                   // bounded; truncation recorded in truncated
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  spawnError?: unknown;             // set when the child emitted 'error' before start (→ spawn-failure)
}
export interface CheckoutLock { key: string; release(): Promise<void>; }
export interface CanonicalPath { input: string; canonical: string; gitCommonDir: string | null; }

export interface PlatformServices {
  os: "darwin" | "linux" | "win32";
  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable>;
  spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess>;
  requestCooperativeCancellation(process: SupervisedProcess): Promise<void>;
  terminateProcessTree(process: SupervisedProcess): Promise<void>;
  terminateProcessTreeByPid(pid: number): Promise<void>;   // crash recovery: kill a tree by recorded pid (no live SupervisedProcess). POSIX: kill(-pid); ESRCH treated as success.
  acquireCheckoutLock(checkout: string): Promise<CheckoutLock>;
  createSecureTempDirectory(): Promise<string>;
  canonicalizePath(path: string): Promise<CanonicalPath>;
}
```

### C5 — ProducerAdapter + CapabilityReport (`src/producers/producer-adapter.ts`)

```ts
export type PlatformState = "certified" | "tested" | "conditional" | "unsupported" | "unknown";

export interface CapabilityReport {
  producerId: string;
  available: boolean;
  reason: string | null;            // machine-readable, e.g. "unsupported-platform", "missing-executable"
  os: "darwin" | "linux" | "win32";
  arch: string;
  environmentType: "native" | "wsl";
  resolvedExecutable: ResolvedExecutable | null;
  version: string | null;
  authState: "authenticated" | "unauthenticated" | "unknown";
  executionModes: string[];         // e.g. ["edit"]
  structuredOutput: boolean;
  writeConfinementBackend: string | null;   // named backend or null
  laneEligibility: Record<string, boolean>; // { edit: true }
}

export interface AdapterEvent {                 // normalized producer output
  kind: "message" | "tool" | "error" | "final";
  text?: string;
  raw?: unknown;
}
export interface ProducerInvocation {
  executable: ResolvedExecutable;
  args: string[];
  stdin?: string;
  requiredEnv: string[];            // env var NAMES the adapter needs allowlisted
  network: "denied" | "allowed";
}
export interface ProducerAdapter {
  producerId: string;
  probe(ctx: ProbeContext): Promise<CapabilityReport>;
  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation;
  normalizeEvents(raw: { stdout: string; stderr: string; exit: SupervisedExit }):
    { events: AdapterEvent[]; producerSummary: string | null; ok: boolean };
  configurationProfile(): ProducerConfigurationProfile;
}
export type ProducerConfigurationProfile = {
  isolationState:
    | "controlled-config-supported"
    | "controlled-config-with-copied-credentials"
    | "inherited-config-only"
    | "configuration-isolation-unsupported";
  credentialSources: string[];
  behavioralConfigSources: string[];
  repositoryInstructionSources: string[];
  environmentDependencies: string[];
  temporaryHomeStrategy: string;
};
// ProbeContext / InvocationContext defined in Task 12.
```

### C6 — MCP tool signatures (`src/mcp/tools.ts`)

All tools return `{ content: [...], structuredContent }`; `structuredContent` matches the `outputSchema`. Errors are structured results, not thrown exceptions.

**Repository identity:** every tool that touches a repo takes an explicit `checkoutPath`. The runtime canonicalizes it via `PlatformServices.canonicalizePath` (never trusts it as-is), derives the canonical Git common dir for the serialization key, and persists it in the archived run record so `runId`-only tools (`reviewCandidate`, `decideCandidate`, `integrateCandidate`) can rehydrate `{ repoRoot, artifact }`. This satisfies the spec's "one server instance may serve multiple repositories" — the repo is never implicitly `process.cwd()`.

```ts
// delegate(checkoutPath, spec) → validates spec; on invalid returns { ok:false, validationErrors }
//   for Main Claude to repair & resubmit; on protocol/schema-version mismatch → { ok:false, diagnostic }
//   on valid runs one attempt → { ok:true, result: AttemptResult }
//   (status ∈ unavailable/failed/cancelled/verified-candidate). Nested delegation → { ok:false, error:"nested-delegation-denied" } (never an AttemptResult).
// reviewCandidate(runId) → { patch, changedPaths, evidence, executedVerification }
//   patch is regenerated UNREDACTED from the anchored tree so Claude reviews the exact integrated bytes.
// decideCandidate(runId, decision) → decision ∈ accepted|rejected|revision-requested;
//   persists decision.json under the run dir → { recorded:true }
// integrateCandidate(runId, expectedArtifactHash) → refuses ("aborted", detail "no-accepted-decision")
//   unless the latest recorded decision is "accepted"; else → { integration: applied|conflicted|aborted, detail }
// doctor() → { node, git, producers: CapabilityReport[], runtimeVersion, schemaVersion, protocolVersion, issues }
//   Always responds — even on an unsupported Host platform — with structured diagnostics, never a crash.
```

> **Naming:** the MCP tool `integrateCandidate` and the internal module function differ. The Task 19 module exports **`applyCandidateTree(args)`**; the Task 21 `integrateCandidate` tool handler resolves the run record then calls it. Do not reuse one name for both.

### C7 — Cross-cutting decisions (from adversarial review — authoritative, referenced by tasks)

- **FailureClassification mapping (pin exactly; do not re-derive per task):**

  | Event | `AttemptStatus` | `FailureClassification` |
  |---|---|---|
  | spec fails `validateSpec` | `failed` | `invalid-specification` |
  | no eligible producer (routing) | `unavailable` | `unavailable` |
  | first-preference producer's probe reason is auth-required (no fallback) | `unavailable` | `authentication-required` |
  | `child.on("error")` before start (ENOENT/EACCES) | `failed` | `spawn-failure` |
  | Host `AbortSignal` fired | `cancelled` | `cancelled` |
  | wall-clock timeout | `failed` | `timeout` |
  | freeze reject `out-of-scope-write` **or** `modified-symlink` | `failed` | `sandbox-violation` |
  | adapter `normalizeEvents` returns `ok:false` | `failed` | `invalid-output` |
  | producer non-zero exit **with** normalizable output | `failed` | `producer-failure` |
  | freeze reject `empty-candidate`, changed-base, mutated verification, or command outside `expectedExitCodes` | `failed` | `verification-failure` |
  | none of the above + verified non-empty candidate | `verified-candidate` | `null` |

- **Value-based redaction:** `EnvironmentPolicy` (Task 10) registers the *values* of every env var whose name matches the sensitive pattern — from the host env, the constructed producer env, and every verification-command env — with the redactor (Task 5). The redactor literal-replaces those exact strings (length ≥ 6) in all persisted/emitted text *before* the pattern rules run. This closes the enterprise-credential-without-a-known-prefix leak.
- **Windows in P0-A = diagnostics-only, never a crash:** `select-platform.ts` returns a **`DiagnosticsOnlyPlatformServices`** on `win32` (resolve/canonicalize work; `spawnSupervised`/`acquireCheckoutLock`/attempt paths return a typed `unsupported-platform` error). The plugin **always loads**, `doctor` and `delegate` return structured `unavailable`/`unsupported-platform` results. `getPlatformServices()` never throws at import time.
- **P0-A certified-environment scope (explicit deviation from `CONTEXT.md`):** `CONTEXT.md` lists "one certified environment per operating system" under P0-A. This plan **stages that down**: P0-A certifies **macOS arm64 only**; Linux and native Windows certification move to P0-B. Per the spec's own rule ("Any reduction before release must be explicit in the published support matrix"), Task 23 publishes the reduced `0.8.0` support matrix (macOS arm64 = certified; Linux/Windows = pending). The macOS/Codex edit-Lane combination ships **only** if Task 13's write-confinement test passes (see below); otherwise it publishes `laneEligibility.edit=false` (diagnostics-only) until P0-B/B4.
- **Write-confinement gate for P0-A:** because the spec forbids certifying an implementation-Lane combination without a *proven* confinement path, Task 13 includes a test that Codex's native sandbox actually blocks an out-of-worktree write on macOS. If that test cannot be made to pass in P0-A, `CodexAdapter.probe` returns `writeConfinementBackend:null` + `laneEligibility.edit=false`, and P0-A ships the delegate path as diagnostics-only. Verification commands (Task 17) run **unconfined** in P0-A; the runtime records `confinement:"none"` / `networkPolicy:"unenforced"` per `CommandOutcome` in evidence and the Run Manifest rather than asserting a policy it does not enforce. Real confinement is P0-B/B4.
- **Anchor-ref lifecycle:** `refs/claude-architect/candidates/<runId>` is deleted on `applied` integration, on a `rejected` decision, and by `ArtifactStore.prune`/`recoverStaleRuns` for pruned runs (deletion recorded in the archive) — so candidate commits do not accumulate forever in the user's repo.
- **Run-start record + orphan-lock reclaim:** immediately after acquiring the checkout lock and *before* spawning, Task 15 writes `${CLAUDE_PLUGIN_DATA}/runs/<runId>/run-start.json` `{ runId, lockKey, canonicalCommonDir, pid: null, startedAt }`, updating `pid` when the producer spawns. `recoverStaleRuns` (Task 24) scans **both** stale run dirs and `locks/*`, reclaiming any lock whose recorded owner pid is dead or whose run has no live record — closing the "crash after lock, before run dir" permanent-brick hole.
- **State dir resolution:** `${CLAUDE_PLUGIN_DATA}` is required in production. The `os.tmpdir()` fallback is gated to tests only (`CLAUDE_ARCHITECT_STATE_DIR` override or `NODE_ENV==="test"`). In production a missing `CLAUDE_PLUGIN_DATA` is a `doctor`-reportable startup diagnostic, never a silent tmpdir.

---

# Milestone P0-A — Protocol & Vertical Slice

**Dependency order (drives task numbering):** scaffold → protocol/schemas → validator → redaction → platform services → supervisor → git plumbing → candidate tree → env policy → adapter contract → codex adapter → registry/routing/probe → attempt runtime → structural verify → project verify → acceptance orchestration → controlled integrator → MCP bootstrap → MCP server/tools → doctor → plugin wiring → recovery → e2e.

**P0-A Definition of Done:** on one certified environment (author's macOS arm64), `/claude-architect:delegate` drives a fake or real Codex adapter through `delegate → verified-candidate → reviewCandidate → decideCandidate(accepted) → integrateCandidate(applied)`, with every failure path in `FAILURE_PRECEDENCE` covered by a test using fake Producer processes, and `doctor` reachable over MCP.

---

### Task 1: Runtime scaffold, build pipeline, and migration guardrail

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`
- Create: `src/index.ts` (placeholder entry), `src/util/logger.ts`, `src/util/errors.ts`
- Create: `runtime/.gitkeep`, `native/README.md`
- Modify: `.gitignore` (ignore `node_modules/`, keep `runtime/server.mjs` committed)
- Test: `tests/runtime/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `npm run build` → `runtime/server.mjs` (esbuild bundle, `--platform=node --format=esm --bundle`); `npm test` → vitest; `logger.error/info/debug` that write **only** to `process.stderr`; typed error classes `SpecInvalidError`, `RuntimeError`.

- [ ] **Step 1: Write the failing test** — `tests/runtime/scaffold.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { logger } from "../../src/util/logger.js";

describe("logger", () => {
  it("writes to stderr and never stdout", () => {
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test shim
    process.stdout.write = (c: string) => { outChunks.push(String(c)); return true; };
    // @ts-expect-error test shim
    process.stderr.write = (c: string) => { errChunks.push(String(c)); return true; };
    try { logger.info("hello", { a: 1 }); } finally {
      process.stdout.write = out; process.stderr.write = err;
    }
    expect(outChunks.join("")).toBe("");
    expect(errChunks.join("")).toContain("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/runtime/scaffold.test.ts`. Expected: FAIL, cannot resolve `../../src/util/logger.js`.

- [ ] **Step 3: Write `package.json`** (deps pinned; `type: module`; Node engine floor)

```json
{
  "name": "claude-architect-runtime",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.19.0",
    "ajv": "^8.17.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

> Verify exact installed versions after `npm install`; pin the ones resolved. `@modelcontextprotocol/sdk` v1.x uses import subpaths `@modelcontextprotocol/sdk/server/mcp.js` and `.../server/stdio.js` — confirm against `node_modules/@modelcontextprotocol/sdk/package.json` `exports`. **Confirm the `registerTool` `inputSchema` shape and the zod major it expects at install time** (the SDK's examples reference `zod/v4`; the pinned `zod@^3.24.1` uses `import { z } from "zod"`). If the resolved SDK requires zod 4, either bump `zod` or use the SDK's re-exported zod — decide before Task 21, not during it.

- [ ] **Step 4: Write `tsconfig.json`, `vitest.config.ts`, `esbuild.config.mjs`**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "resolveJsonModule": true, "skipLibCheck": true, "declaration": false,
    "outDir": "dist", "rootDir": "src"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.{ts,mjs}"], environment: "node", testTimeout: 30_000 } });
```

```js
// esbuild.config.mjs
import { build } from "esbuild";
await build({
  entryPoints: ["src/index.ts"],
  outfile: "runtime/server.mjs",         // .mjs so ESM-ness never depends on a package.json shipping in the cache
  bundle: true, platform: "node", format: "esm", target: "node22",
  // REQUIRED: esbuild ESM output of CJS deps (the MCP SDK, ajv) will "Dynamic require of 'node:*' is not
  // supported" at runtime without this shim. Do not omit it.
  banner: { js: [
    "// GENERATED by esbuild — do not edit. Source: src/. Build: npm run build",
    "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  ].join("\n") },
});
console.error("built runtime/server.mjs");
```

> Shipped entrypoints are `runtime/bootstrap.mjs` and `runtime/server.mjs` (both `.mjs`), so they parse as ESM without relying on the plugin-root `package.json` being present in the marketplace cache. Update `.mcp.json` (Task 23) and the bootstrap import accordingly.

- [ ] **Step 5: Write `src/util/logger.ts` and `src/util/errors.ts`**

```ts
// src/util/logger.ts
type Level = "debug" | "info" | "warn" | "error";
function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ t: level, msg, ...(meta ?? {}) });
  process.stderr.write(line + "\n");   // NEVER stdout: stdout carries the MCP protocol
}
export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
```

```ts
// src/util/errors.ts
export class RuntimeError extends Error {
  constructor(message: string, readonly detail?: Record<string, unknown>) { super(message); this.name = "RuntimeError"; }
}
export class SpecInvalidError extends RuntimeError {
  constructor(readonly validationErrors: Array<{ path: string; message: string }>) {
    super("delegation spec invalid"); this.name = "SpecInvalidError";
  }
}
export class NestedDelegationError extends RuntimeError {   // CLAUDE_ARCHITECT_DELEGATED already set
  constructor() { super("nested delegation denied"); this.name = "NestedDelegationError"; }
}
export class SpawnFailureError extends RuntimeError {       // child 'error' before start (ENOENT/EACCES)
  constructor(readonly cause: unknown) { super("spawn failure"); this.name = "SpawnFailureError"; }
}
```

- [ ] **Step 6: Write `src/index.ts` placeholder + `native/README.md`**

```ts
// src/index.ts — real MCP wiring lands in Task 21. Keep buildable now.
import { logger } from "./util/logger.js";
export function main() { logger.info("claude-architect runtime placeholder"); }
```

`native/README.md` documents that the P0-B Windows process-tree helper will live here and that **no** shipped P0-A feature depends on it.

- [ ] **Step 7: Run tests + typecheck + build** — `npm install && npx vitest run tests/runtime/scaffold.test.ts && npm run typecheck && npm run build`. Expected: test PASS; `tsc` clean; `runtime/server.mjs` emitted.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts esbuild.config.mjs src/ runtime/ native/ tests/runtime/scaffold.test.ts .gitignore
git commit -m "feat(runtime): scaffold TypeScript MCP runtime and stderr-only logger"
```

---

### Task 2: Protocol version constants and JSON-Schema validation tooling

**Files:**
- Create: `src/protocol/versions.ts` (contract **C1** verbatim), `runtime/schemas/delegation-spec.v1.json`, `runtime/schemas/attempt-result.v1.json`
- Create: `src/protocol/schema-loader.ts`
- Test: `tests/runtime/schema-loader.test.ts`

**Interfaces:**
- Consumes: **C1**.
- Produces: `loadSchemas()` → compiled ajv validators keyed by name; `checkVersionCompat(skillProtocolVersion): { ok: boolean; diagnostic?: string }` used by the Task 21 `delegate` handler and Task 22 `doctor` (compares the SKILL's `PROTOCOL_VERSION` marker to `src/protocol/versions.ts`; returns an actionable diagnostic on mismatch rather than failing silently). Not called from bootstrap, which is dependency-free and cannot import `src/`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadSchemas } from "../../src/protocol/schema-loader.js";

describe("schema loader", () => {
  it("compiles delegation-spec and attempt-result validators", () => {
    const v = loadSchemas();
    expect(typeof v.delegationSpec).toBe("function");
    expect(v.delegationSpec({ specVersion: "1" })).toBe(false); // missing required fields
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/runtime/schema-loader.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Write `runtime/schemas/delegation-spec.v1.json`** — a JSON Schema (draft 2020-12) mirroring contract **C2**: required `specVersion,objective,context,writeAllowlist,forbiddenScope,successCriteria,verification,executionMode,timeoutMs,producerPreferences,expectedOutput` (**`forbiddenScope` is required** — allow `[]` but require presence, so scope enforcement is never silently undefined); `specVersion` `const:"1"`, `executionMode` `const:"edit"`, `expectedOutput` `const:"candidate-patch"` (so a wrong value is rejected by the repair loop); `writeAllowlist` `minItems:1` (repo-wide must be explicit `["**"]`); `timeoutMs` `maximum: 1800000`; `verification[]` items require `id,executable,args,cwd,timeoutMs,network,expectedExitCodes` with `timeoutMs` `maximum: 1800000` (so an over-ceiling command timeout fails at validation, not mid-verification in `supervise`).

- [ ] **Step 4: Write `runtime/schemas/attempt-result.v1.json`** mirroring **C3**: `status` enum `["unavailable","failed","cancelled","verified-candidate"]`; `failure` enum = `FAILURE_PRECEDENCE` ∪ `null`.

- [ ] **Step 5: Write `src/protocol/versions.ts` (C1) and `src/protocol/schema-loader.ts`**

```ts
// NOTE: the DEFAULT `import Ajv from "ajv"` supports draft-07 only AND fails typecheck under NodeNext
// (TS2351 "not constructable"). For draft 2020-12 schemas use the dedicated 2020 build + NAMED import:
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import specSchema from "../../runtime/schemas/delegation-spec.v1.json" with { type: "json" };
import resultSchema from "../../runtime/schemas/attempt-result.v1.json" with { type: "json" };
export interface CompiledSchemas { delegationSpec: ValidateFunction; attemptResult: ValidateFunction; }
export function loadSchemas(): CompiledSchemas {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return { delegationSpec: ajv.compile(specSchema as object), attemptResult: ajv.compile(resultSchema as object) };
}
```

> Verified against the pinned deps: the default `import Ajv from "ajv"` throws `no schema with key ... draft/2020-12` at compile time and `TS2351` at typecheck. `Ajv2020` from `ajv/dist/2020.js` fixes both. (If you instead author the schemas as draft-07, use `import { Ajv } from "ajv"` and drop the 2020-12 claim.)

- [ ] **Step 6: Run test** — `npx vitest run tests/runtime/schema-loader.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/protocol/versions.ts src/protocol/schema-loader.ts runtime/schemas/ tests/runtime/schema-loader.test.ts
git commit -m "feat(protocol): add versioned JSON schemas and ajv loader"
```

---

### Task 3: DelegationSpec type and SpecValidator repair loop

**Files:**
- Create: `src/protocol/delegation-spec.ts` (contract **C2** verbatim), `src/protocol/spec-validator.ts`
- Test: `tests/runtime/spec-validator.test.ts`

**Interfaces:**
- Consumes: **C1**, **C2**, `loadSchemas` (Task 2), `SpecInvalidError` (Task 1).
- Produces: `validateSpec(input: unknown): { ok: true; spec: DelegationSpec } | { ok: false; errors: Array<{ path: string; message: string }> }`. This is the **repair loop** entry: no Producer is probed or started until it returns `ok:true`.

- [ ] **Step 1: Write the failing test** — cover: (a) valid spec passes; (b) empty `writeAllowlist` fails with a path-pointing error; (c) `timeoutMs` over ceiling fails; (d) `executionMode !== "edit"` fails.

```ts
import { describe, it, expect } from "vitest";
import { validateSpec } from "../../src/protocol/spec-validator.js";

const base = {
  specVersion: "1", objective: "add fn", context: "ctx", writeAllowlist: ["src/**"], forbiddenScope: [],
  successCriteria: ["compiles"], verification: [], executionMode: "edit",
  timeoutMs: 60000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};
describe("validateSpec", () => {
  it("accepts a valid spec", () => expect(validateSpec(base).ok).toBe(true));
  it("rejects a spec missing forbiddenScope", () => {
    const { forbiddenScope, ...noScope } = base;
    expect(validateSpec(noScope).ok).toBe(false);
  });
  it("rejects empty writeAllowlist", () => {
    const r = validateSpec({ ...base, writeAllowlist: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path.includes("writeAllowlist"))).toBe(true);
  });
  it("rejects over-ceiling timeout", () =>
    expect(validateSpec({ ...base, timeoutMs: 9_000_000 }).ok).toBe(false));
  it("rejects non-edit executionMode", () =>
    expect(validateSpec({ ...base, executionMode: "review" }).ok).toBe(false));
});
```

> Every downstream spec fixture (Tasks 15, 21, 25) must likewise include `forbiddenScope: []`.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/runtime/spec-validator.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write `src/protocol/delegation-spec.ts`** — export the **C2** interfaces and `RUNTIME_MAX_TIMEOUT_MS`.

- [ ] **Step 4: Write `src/protocol/spec-validator.ts`**

```ts
import { loadSchemas } from "./schema-loader.js";
import type { DelegationSpec } from "./delegation-spec.js";
const schemas = loadSchemas();
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: Array<{ path: string; message: string }> };
export function validateSpec(input: unknown): ValidateResult {
  const ok = schemas.delegationSpec(input);
  if (ok) return { ok: true, spec: input as DelegationSpec };
  const errors = (schemas.delegationSpec.errors ?? []).map(e => ({
    path: e.instancePath || e.schemaPath, message: e.message ?? "invalid",
  }));
  return { ok: false, errors };
}
```

- [ ] **Step 5: Run test** — `npx vitest run tests/runtime/spec-validator.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/delegation-spec.ts src/protocol/spec-validator.ts tests/runtime/spec-validator.test.ts
git commit -m "feat(protocol): add DelegationSpec and validate-and-repair loop"
```

---

### Task 4: AttemptResult, statuses, and FailureClassification precedence

**Files:**
- Create: `src/protocol/attempt-result.ts` (contract **C3** verbatim, plus `classifyFailure`)
- Test: `tests/runtime/attempt-result.test.ts`

**Interfaces:**
- Consumes: **C3**.
- Produces: `classifyFailure(signals: FailureSignals): FailureClassification | null` — walks `FAILURE_PRECEDENCE`; returns the first true signal or `null` (→ `verified-candidate`). `FailureSignals` is a record of boolean flags keyed by each `FailureClassification`.

- [ ] **Step 1: Write the failing test** — assert precedence: when both `sandbox-violation` and `verification-failure` are true, `sandbox-violation` wins; when all false, returns `null`.

```ts
import { describe, it, expect } from "vitest";
import { classifyFailure } from "../../src/protocol/attempt-result.js";
describe("classifyFailure", () => {
  it("honors precedence (sandbox before verification)", () =>
    expect(classifyFailure({ "sandbox-violation": true, "verification-failure": true })).toBe("sandbox-violation"));
  it("invalid-specification wins over everything", () =>
    expect(classifyFailure({ "invalid-specification": true, "producer-failure": true })).toBe("invalid-specification"));
  it("returns null when no signal set", () => expect(classifyFailure({})).toBeNull());
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL, module not found.

- [ ] **Step 3: Write `src/protocol/attempt-result.ts`** — export **C3** types plus:

```ts
export type FailureSignals = Partial<Record<FailureClassification, boolean>>;
export function classifyFailure(s: FailureSignals): FailureClassification | null {
  for (const reason of FAILURE_PRECEDENCE) if (s[reason]) return reason;
  return null;
}
```

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/attempt-result.ts tests/runtime/attempt-result.test.ts
git commit -m "feat(protocol): add AttemptResult types and failure-precedence classifier"
```

---

### Task 5: Secret and credential redaction

**Files:**
- Create: `src/runtime/redaction.ts`
- Test: `tests/runtime/redaction.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `redact(text: string): string` and `redactRecord<T>(obj: T): T` — applied before **any** log, event, or result byte is persisted. Redacts common credential forms (bearer tokens, `sk-`/`ghp_`/`gho_` prefixes, `AKIA` AWS keys, `xox[baprs]-` Slack, JWT-looking triplets, `KEY=value` where key name matches `(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)`), replacing with `«redacted:<kind>»`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { redact } from "../../src/runtime/redaction.js";
describe("redact", () => {
  it("masks bearer tokens and known key prefixes", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("key sk-ABCDEF0123456789")).not.toContain("sk-ABCDEF0123456789");
    expect(redact("AWS AKIAIOSFODNN7EXAMPLE here")).toContain("«redacted:");
  });
  it("leaves ordinary text intact", () =>
    expect(redact("just a normal sentence")).toBe("just a normal sentence"));
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/runtime/redaction.ts`** — array of `{ kind, re }` rules; `redact` runs `text.replace` for each; `redactRecord` deep-walks strings. Keep rules conservative to avoid over-redacting file paths.

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/redaction.ts tests/runtime/redaction.test.ts
git commit -m "feat(runtime): add credential redaction for logs and results"
```

---

### Task 6: PlatformServices interface and PosixPlatformServices

**Files:**
- Create: `src/platform/platform-services.ts` (contract **C4** verbatim), `src/platform/posix-platform-services.ts`, `src/platform/select-platform.ts`
- Create: `src/util/bounded-buffer.ts`
- Test: `tests/runtime/posix-platform-services.test.ts`, `tests/runtime/fixtures/echo-sleep.mjs`

**Interfaces:**
- Consumes: **C4**, `logger` (Task 1).
- Produces: `getPlatformServices(): PlatformServices` (POSIX impl in P0-A; throws `unsupported-platform` on `win32` until P0-B). POSIX behaviors: `resolveExecutable` walks `PATH` and returns `kind:"native"`; `spawnSupervised` spawns with `detached:true` (own process group) and `stdio:["pipe","pipe","pipe"]`; cancellation sends `SIGTERM` to `-pgid`; `terminateProcessTree` sends `SIGKILL` to `-pgid`; `acquireCheckoutLock` creates an `O_EXCL` lockfile under `${CLAUDE_PLUGIN_DATA}/locks/<sha256(gitCommonDir)>.lock`; `canonicalizePath` uses `fs.realpath` + `git rev-parse --git-common-dir`.

- [ ] **Step 1: Write the fake-process fixture** — `tests/runtime/fixtures/echo-sleep.mjs`

```js
// Prints argv[2] to stdout, argv[3] to stderr, then sleeps argv[4] ms. Ignores SIGTERM if argv[5]==="stubborn".
const [, , out, err, sleepMs, mode] = process.argv;
if (out) process.stdout.write(out);
if (err) process.stderr.write(err);
if (mode === "stubborn") process.on("SIGTERM", () => {});
setTimeout(() => process.exit(0), Number(sleepMs ?? 0));
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { fileURLToPath } from "node:url";
const fixture = fileURLToPath(new URL("./fixtures/echo-sleep.mjs", import.meta.url));

describe("PosixPlatformServices", () => {
  const ps = getPlatformServices();
  it("resolves node and spawns supervised, draining stdout", async () => {
    const node = await ps.resolveExecutable({ name: "node" });
    const proc = await ps.spawnSupervised({
      executable: node, args: [fixture, "HELLO", "WOES", "0"],
      cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5000, maxOutputBytes: 1_000_000,
    });
    const exit = await proc.done;
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toContain("HELLO");
    expect(exit.stderr).toContain("WOES");
  });
});
```

- [ ] **Step 3: Run to verify it fails** — Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/util/bounded-buffer.ts`** — collects chunks up to `maxBytes`, sets `truncated=true` and drops excess (but the caller keeps draining the stream to avoid deadlock).

```ts
export class BoundedBuffer {
  private parts: Buffer[] = []; private size = 0; truncated = false;
  constructor(private readonly maxBytes: number) {}
  push(chunk: Buffer) {
    if (this.size >= this.maxBytes) { this.truncated = true; return; }
    const room = this.maxBytes - this.size;
    if (chunk.length > room) { this.parts.push(chunk.subarray(0, room)); this.size = this.maxBytes; this.truncated = true; }
    else { this.parts.push(chunk); this.size += chunk.length; }
  }
  toString() { return Buffer.concat(this.parts).toString("utf8"); }
}
```

- [ ] **Step 5: Write `src/platform/platform-services.ts` (C4) and `src/platform/posix-platform-services.ts`** — core `spawnSupervised`:

```ts
import { spawn } from "node:child_process";
import { BoundedBuffer } from "../util/bounded-buffer.js";
// ... implements PlatformServices for darwin/linux
async spawnSupervised(req: SpawnRequest): Promise<SupervisedProcess> {
  const child = spawn(req.executable.command, [...req.executable.prefixArgs, ...req.args], {
    cwd: req.cwd, env: req.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const outBuf = new BoundedBuffer(req.maxOutputBytes), errBuf = new BoundedBuffer(req.maxOutputBytes);
  child.stdout.on("data", (c: Buffer) => outBuf.push(c));   // always drain
  child.stderr.on("data", (c: Buffer) => errBuf.push(c));
  if (req.stdin != null) { child.stdin?.on("error", () => {}); child.stdin?.write(req.stdin); child.stdin?.end(); }
  let settled = false;
  const done = new Promise<SupervisedExit>((resolve) => {
    const finish = (e: SupervisedExit) => { if (!settled) { settled = true; resolve(e); } };
    // MANDATORY: without this, a failed spawn (ENOENT/EACCES) emits 'error' with no listener → uncaught
    // exception crashes the MCP server. Instead settle done with a spawn-failure marker.
    child.on("error", (err) => finish({
      exitCode: null, signal: null, timedOut: false, cancelled: false,
      stdout: outBuf.toString(), stderr: errBuf.toString(),
      truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated }, spawnError: err,
    }));
    child.on("close", (code, signal) => finish({
      exitCode: code, signal: signal as NodeJS.Signals | null, timedOut: false, cancelled: false,
      stdout: outBuf.toString(), stderr: errBuf.toString(),
      truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated },
    }));
  });
  return { pid: child.pid ?? -1, done, stdout: child.stdout, stderr: child.stderr, /* internal: child */ } as SupervisedProcess;
}
```

`terminateProcessTree` calls `process.kill(-proc.pid, "SIGKILL")` (negative pid = the process group created by `detached:true`), treating `ESRCH` (already reaped) as success; `terminateProcessTreeByPid(pid)` does the same by recorded pid for crash recovery. `requestCooperativeCancellation` sends `SIGTERM` to `-pid`. Per **C7**, `select-platform.ts` returns the POSIX impl for `darwin`/`linux` and a **`DiagnosticsOnlyPlatformServices`** for `win32` (resolve/canonicalize work; spawn/lock/attempt return a typed `unsupported-platform` error) — it **never throws at import time**, so `doctor` still responds on Windows.

- [ ] **Step 6: Run test** — Expected: PASS.

- [ ] **Step 6b: Test the checkout lock (one-active-attempt enforcement)** — add to the suite: a second `acquireCheckoutLock` on the same repo rejects/blocks while the first is held and succeeds after `release()`; and acquiring via a **symlinked alias** of the repo path produces the **same** lock key as the real path (proving `canonicalizePath` applies `realpath` to the `--git-common-dir` output, so `/tmp` vs `/private/tmp` and case-only differences cannot bypass the rule). The same canonical key feeds Task 21's in-process mutex.

- [ ] **Step 7: Commit**

```bash
git add src/platform/ src/util/bounded-buffer.ts tests/runtime/posix-platform-services.test.ts tests/runtime/fixtures/echo-sleep.mjs
git commit -m "feat(platform): add PlatformServices contract and POSIX implementation"
```

---

### Task 7: ProcessSupervisor (timeout, cancellation, drain, exit normalization)

**Files:**
- Create: `src/platform/process-supervisor.ts`
- Test: `tests/runtime/process-supervisor.test.ts`

**Interfaces:**
- Consumes: **C4**, `getPlatformServices`, the `echo-sleep.mjs` fixture.
- Produces: `supervise(ps, req, opts): Promise<SupervisedExit>` where `opts = { onCancel?: AbortSignal }`. Enforces `req.timeoutMs`: on timeout, cooperative cancel → wait `graceMs` (default 3000) → `terminateProcessTree`, and returns `{ timedOut: true }`. On `onCancel` abort, returns `{ cancelled: true }`. Always drains streams. Validates `timeoutMs > 0 && <= RUNTIME_MAX_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing test** — three cases: (a) fast process exits 0; (b) stubborn process past timeout returns `timedOut:true` and leaves no survivor; (c) cancellation via `AbortController` returns `cancelled:true`.

```ts
import { describe, it, expect } from "vitest";
import { supervise } from "../../src/platform/process-supervisor.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { fileURLToPath } from "node:url";
const ps = getPlatformServices();
const fixture = fileURLToPath(new URL("./fixtures/echo-sleep.mjs", import.meta.url));
async function run(args: string[], timeoutMs: number, onCancel?: AbortSignal) {
  const node = await ps.resolveExecutable({ name: "node" });
  return supervise(ps, { executable: node, args: [fixture, ...args], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" }, timeoutMs, maxOutputBytes: 1_000_000 }, { onCancel });
}
describe("supervise", () => {
  it("returns exit 0 for a fast process", async () => expect((await run(["hi", "", "0"], 5000)).exitCode).toBe(0));
  it("times out a stubborn process and kills the tree", async () => {
    const exit = await run(["", "", "60000", "stubborn"], 800);
    expect(exit.timedOut).toBe(true);
  }, 15000);
  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const exit = await run(["", "", "60000"], 30000, ac.signal);
    expect(exit.cancelled).toBe(true);
  }, 15000);
  it("returns spawn-failure marker for a missing executable", async () => {
    const exit = await supervise(ps, { executable: { kind: "native", command: "/no/such/bin", prefixArgs: [], resolvedFrom: "test" },
      args: [], cwd: process.cwd(), env: {}, timeoutMs: 5000, maxOutputBytes: 1000 }, {});
    expect(exit.spawnError).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/platform/process-supervisor.ts`**

```ts
import type { PlatformServices, SpawnRequest, SupervisedExit } from "./platform-services.js";
import { RUNTIME_MAX_TIMEOUT_MS } from "../protocol/delegation-spec.js";
export async function supervise(
  ps: PlatformServices, req: SpawnRequest, opts: { onCancel?: AbortSignal; graceMs?: number }
): Promise<SupervisedExit> {
  if (!(req.timeoutMs > 0 && req.timeoutMs <= RUNTIME_MAX_TIMEOUT_MS)) throw new Error("invalid timeout");
  const proc = await ps.spawnSupervised(req);
  let timedOut = false, cancelled = false;
  const grace = opts.graceMs ?? 3000;
  const graceTimers = new Set<NodeJS.Timeout>();
  const escalate = () => graceTimers.add(setTimeout(() => ps.terminateProcessTree(proc).catch(() => {}), grace));
  const timer = setTimeout(async () => { timedOut = true; await ps.requestCooperativeCancellation(proc); escalate(); }, req.timeoutMs);
  const onAbort = async () => { cancelled = true; await ps.requestCooperativeCancellation(proc); escalate(); };
  opts.onCancel?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await proc.done;
    return { ...exit, timedOut: timedOut || exit.timedOut, cancelled: cancelled || exit.cancelled };
  } finally {
    // Cancel EVERY pending timer once the process settles, so a late SIGKILL cannot hit a reused pgid.
    clearTimeout(timer); for (const t of graceTimers) clearTimeout(t);
    opts.onCancel?.removeEventListener("abort", onAbort);
  }
}
```

`terminateProcessTree` must no-op when the process is already reaped (treat `ESRCH` as success), since `proc.done` may settle during the grace window.

- [ ] **Step 4: Run test** — `npx vitest run tests/runtime/process-supervisor.test.ts`. Expected: PASS (timeout case completes under 15s).

- [ ] **Step 5: Commit**

```bash
git add src/platform/process-supervisor.ts tests/runtime/process-supervisor.test.ts
git commit -m "feat(platform): add process supervisor with timeout and tree termination"
```

---

### Task 8: Git runner, repository precondition matrix, and WorktreeManager

**Files:**
- Create: `src/git/git-exec.ts`, `src/git/repo-preconditions.ts`, `src/git/worktree-manager.ts`
- Test: `tests/runtime/repo-preconditions.test.ts`, `tests/runtime/worktree-manager.test.ts`

**Interfaces:**
- Consumes: **C4**, `getPlatformServices`.
- Produces:
  - `git(cwd, args[]): Promise<{ stdout; stderr; exitCode }>` — argv-array only, **never** a shell string, resolved via `PlatformServices.resolveExecutable("git")`.
  - `checkPreconditions(repoRoot): Promise<{ ok: true; baseCommitOid; gitCommonDir } | { ok: false; reason: string }>` — enforces the spec's supported/rejected matrix.
  - `WorktreeManager` with `create(baseCommitOid): Promise<{ path; cleanup(): Promise<void> }>` (worktree under `${CLAUDE_PLUGIN_DATA}/worktrees/<runId>`) and `remove(path)`.

- [ ] **Step 1: Write the failing test for preconditions** — build a temp git repo in the test (`git init`, one commit) and assert `ok:true` with a `baseCommitOid`; assert a repo with a dirty file returns `ok:false, reason:"dirty-checkout"`; assert an unborn repo (init, no commit) returns `reason:"unborn-repository"`.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/git/git-exec.js";
import { checkPreconditions } from "../../src/git/repo-preconditions.js";

async function initRepo() {
  const dir = await mkdtemp(join(tmpdir(), "ca-repo-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@t"]); await git(dir, ["config", "user.name", "t"]);
  await writeFile(join(dir, "a.txt"), "hello\n");
  await git(dir, ["add", "-A"]); await git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}
describe("checkPreconditions", () => {
  it("accepts a clean repo with a commit", async () => {
    const r = await checkPreconditions(await initRepo());
    expect(r.ok).toBe(true); if (r.ok) expect(r.baseCommitOid).toMatch(/^[0-9a-f]{40}$/);
  });
  it("rejects a dirty checkout", async () => {
    const dir = await initRepo(); await writeFile(join(dir, "a.txt"), "changed\n");
    const r = await checkPreconditions(dir); expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dirty-checkout");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/git/git-exec.ts`**

```ts
import { getPlatformServices } from "../platform/select-platform.js";
import { supervise } from "../platform/process-supervisor.js";
// Resolve platform services LAZILY (not at module scope) so importing this on win32 does not throw.
export async function git(cwd: string, args: string[], indexFile?: string) {
  const ps = getPlatformServices();
  const exe = await ps.resolveExecutable({ name: "git" });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    // Pass HOME/XDG so global core.excludesFile (e.g. .DS_Store) is honored — else globally-ignored
    // files show as untracked and get mis-flagged out-of-scope during freeze.
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    // Deterministic, identity-independent authorship for commit-tree — a real user repo with ident only
    // in the global config must NOT fail "Please tell me who you are", and anchor commits must be reproducible.
    GIT_AUTHOR_NAME: "claude-architect", GIT_AUTHOR_EMAIL: "runtime@claude-architect.invalid",
    GIT_COMMITTER_NAME: "claude-architect", GIT_COMMITTER_EMAIL: "runtime@claude-architect.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),   // isolated index for candidate-tree construction
  };
  const exit = await supervise(ps, { executable: exe, args, cwd, env, timeoutMs: 60_000, maxOutputBytes: 8_000_000 }, {});
  return { stdout: exit.stdout, stderr: exit.stderr, exitCode: exit.exitCode };
}
```

> The fixed `GIT_*_DATE` makes `candidateCommitOid` reproducible for the same tree+base; drop the dates if you prefer real timestamps (the tree oid and manifest hash — the artifact's identity — are date-independent regardless).

- [ ] **Step 4: Write `src/git/repo-preconditions.ts`** — checks in order and returns the first failing `reason`:
  - bare repo (`git rev-parse --is-bare-repository` == true) → `"bare-repository"`
  - unborn (`git rev-parse --verify HEAD` fails) → `"unborn-repository"`
  - in-progress op (existence of `MERGE_HEAD`, `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `BISECT_LOG` under git dir) → `"in-progress-operation"`
  - dirty (`git status --porcelain` non-empty) → `"dirty-checkout"`
  - sparse checkout (`git config core.sparseCheckout` == true) → `"sparse-checkout"`
  - changed submodules (`git submodule status` shows `+`/`-`) → `"changed-submodule"`
  - `skip-worktree`/`assume-unchanged` entries (`git ls-files -v` shows `S`/`s`/`h`) → `"skip-worktree-entries"` (rejected — they hide real state)
  - nested repository inside the checkout that overlaps the write allowlist → `"nested-repository"` (rejected)
  Also **explicitly classify (supported)**, so they are never hit by accident: detached `HEAD` → supported; existing linked worktrees → supported (the runtime creates its own); Git LFS → supported (LFS pointers are ordinary blobs in the tree); a repo path reached through a symlink → supported **after** `canonicalizePath`. Each classification gets one test.
  Returns `{ ok:true, baseCommitOid: <rev-parse HEAD>, gitCommonDir: realpath(<rev-parse --path-format=absolute --git-common-dir>) }` — the common dir is `realpath`-normalized so aliases hash to one lock key (see Task 6, Step 6b).

- [ ] **Step 5: Write `src/git/worktree-manager.ts`** — `create(base)`: `git(repoRoot, ["worktree","add","--detach", worktreePath, base])`; `cleanup()`: `git(repoRoot, ["worktree","remove","--force", worktreePath])` then best-effort `rm -rf`. Worktree path under `${CLAUDE_PLUGIN_DATA}/worktrees/<runId>` (resolve `CLAUDE_PLUGIN_DATA`, fall back to `os.tmpdir()` in tests).

- [ ] **Step 6: Write the WorktreeManager test** — create repo, `create(base)`, assert the worktree dir exists and `HEAD` == base; `cleanup()`, assert `git worktree list` no longer contains it.

- [ ] **Step 7: Run both tests** — `npx vitest run tests/runtime/repo-preconditions.test.ts tests/runtime/worktree-manager.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/git/git-exec.ts src/git/repo-preconditions.ts src/git/worktree-manager.ts tests/runtime/repo-preconditions.test.ts tests/runtime/worktree-manager.test.ts
git commit -m "feat(git): add argv git runner, precondition matrix, and worktree manager"
```

---

### Task 9: Content-addressed Candidate Artifact construction

**Files:**
- Create: `src/git/candidate-tree.ts`
- Test: `tests/runtime/candidate-tree.test.ts`

**Interfaces:**
- Consumes: `git` (Task 8), **C3** (`CandidateArtifact`, `ChangedPath`), `redact`.
- Produces: `freezeCandidate(args): Promise<{ ok: true; artifact: CandidateArtifact } | { ok: false; reason: FreezeReject }>` where `args = { repoRoot, worktreePath, baseCommitOid, runId, writeAllowlist, forbiddenScope }`. `FreezeReject ∈ "out-of-scope-write" | "modified-symlink" | "empty-candidate"`.

**Construction algorithm (the runtime — not the Producer — builds the tree):**
1. Inventory the worktree: `git(worktree, ["status","--porcelain=v1","-z","--untracked-files=all"])` for tracked + untracked non-ignored entries, and a separate `git status --porcelain -z --ignored` to **record** ignored paths (recorded in freeze evidence / Run Manifest, **excluded** from the tree and patch — never included).
2. **Reject** any changed path outside `writeAllowlist` (glob match) or inside `forbiddenScope` → `out-of-scope-write`.
3. Fast-fail lstat scan for symlinks (advisory only). The **authoritative** symlink rejection happens at step 6b on the frozen tree, where TOCTOU is impossible.
4. Build an **isolated index** via the `git()` `indexFile` param: `git(worktree, ["read-tree", baseCommitOid], idx)` (seed with base), then stage the allowed changed paths with literal pathspecs so a producer file literally named `a*.txt` or `foo[1].ts` is not glob-expanded: feed NUL-separated paths to `git(worktree, ["add","--all","--pathspec-from-file=-","--pathspec-file-nul"], idx)` (or prefix each path with `:(literal)`). Captures adds, mods, and deletes within the allowlist.
5. `git(worktree, ["write-tree"], idx)` → `candidateTreeOid`.
6. **Reject** `empty-candidate` when `candidateTreeOid === baseTreeOid` (`git rev-parse <base>^{tree}`) — an empty candidate can never be `verified-candidate` when code changes are required.
6b. **Authoritative symlink rejection:** `git diff-tree -r <baseCommitOid> <candidateTreeOid>` — if any destination mode is `120000` (covers adds, modifications, and typechanges in one deterministic pass over the immutable tree), reject → `modified-symlink`.
7. **Anchor against GC:** `git commit-tree <candidateTreeOid> -p <baseCommitOid> -m "candidate <runId>"` → `candidateCommitOid`; `git update-ref refs/claude-architect/candidates/<runId> <candidateCommitOid>`. Keeps the tree reachable after worktree removal so verification and integration operate on the exact reviewed tree. (Ref lifecycle — deletion on applied/rejected/prune — per **C7**.)
8. Build `changedPaths[]` from `git diff-tree -r --name-status` + `git ls-tree -r <candidateTreeOid>`, recording `path, changeType, mode, contentHash (blob oid)`.
9. `manifestHash = sha256(JSON.stringify(sortedChangedPaths))`.
10. `patch = git diff --binary --full-index <baseCommitOid> <candidateTreeOid>` (review/portability only — not the artifact's identity).

- [ ] **Step 1: Write the failing test** — in a temp repo + worktree: modify an allowed file, add an out-of-scope file, run `freezeCandidate` with `writeAllowlist:["a.txt"]`; assert `out-of-scope-write` reject. Then a clean allowed edit → `ok:true` with a 40-hex `candidateTreeOid !== baseTreeOid`, a populated `changedPaths`, and a non-empty `patch`. Then a symlink add → `modified-symlink`. Then no change → `empty-candidate`.

```ts
import { describe, it, expect } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
// helper initRepo+worktree as in Task 8; write "a.txt" allowed edit, "b.txt" out-of-scope
it("rejects out-of-scope writes", async () => {
  const r = await freezeCandidate({ /* ...worktree with b.txt changed */ writeAllowlist: ["a.txt"], forbiddenScope: [] });
  expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toBe("out-of-scope-write");
});
it("freezes an allowed edit into a content-addressed tree", async () => {
  const r = await freezeCandidate({ /* ...only a.txt changed */ writeAllowlist: ["a.txt"], forbiddenScope: [] });
  expect(r.ok).toBe(true);
  if (r.ok) { expect(r.artifact.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(r.artifact.changedPaths[0]?.path).toBe("a.txt"); expect(r.artifact.patch).toContain("a.txt"); }
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/git/candidate-tree.ts`** implementing steps 1–10. Use `crypto.createHash("sha256")` for `manifestHash`; pass `GIT_INDEX_FILE` via the `git()` runner's env (extend `git()` to accept an `env` override, or add a `gitWithIndex(cwd, indexFile, args)` helper). Glob matching via a small matcher (support `**`, `*`, exact) or add `minimatch` to deps.

- [ ] **Step 4: Run test** — `npx vitest run tests/runtime/candidate-tree.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/candidate-tree.ts tests/runtime/candidate-tree.test.ts
git commit -m "feat(git): build content-addressed candidate tree anchored against GC"
```

---

### Task 10: EnvironmentPolicy (layered, allowlisted process environment)

**Files:**
- Create: `src/runtime/environment-policy.ts`
- Test: `tests/runtime/environment-policy.test.ts`

**Interfaces:**
- Consumes: **C5** (`ProducerInvocation.requiredEnv`), `redact`.
- Produces: `buildEnvironment(args): { env: Record<string,string>; provenance: EnvProvenance }` where `args = { os, adapterAllowlist: string[], specAdditions?: Record<string,string>, tempHome?: string }`. Host env is **not** inherited wholesale: only platform-essential vars (POSIX: `HOME`,`PATH`,`TMPDIR`,`LANG`,`LC_ALL`, selected `XDG_*`; Windows list deferred to P0-B) + `adapterAllowlist` names pulled from `process.env` + explicit `specAdditions`. Sets `CLAUDE_ARCHITECT_DELEGATED=1`. `provenance` records variable **names** and source (`platform`/`adapter`/`spec`), never values.

- [ ] **Step 1: Write the failing test** — assert an env-var not in any layer is absent; a platform-essential (`PATH`) is present; an adapter-allowlisted name present in `process.env` is passed through; `CLAUDE_ARCHITECT_DELEGATED` is `"1"`; `provenance` contains names only.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/runtime/environment-policy.ts`** — POSIX-essential constant list; filter `process.env` by allowlist; merge layers in order platform→adapter→spec; stamp `CLAUDE_ARCHITECT_DELEGATED=1`; build `provenance`.

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/environment-policy.ts tests/runtime/environment-policy.test.ts
git commit -m "feat(runtime): construct layered allowlisted producer environment"
```

---

### Task 11: ArtifactStore and RunManifest

**Files:**
- Create: `src/runtime/artifact-store.ts`, `src/runtime/run-manifest.ts`
- Test: `tests/runtime/artifact-store.test.ts`

**Interfaces:**
- Consumes: `redact`, **C2/C3**.
- Produces:
  - `ArtifactStore` bound to `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`: `writeLog(name, text) → ref`, `writeResult(AttemptResult)`, `writeManifest(RunManifest)`, `readResult(runId)`, `list()`, `prune({ maxAgeMs, maxBytes })`. All text passes through `redact` first; refs are relative archive paths. **Never** writes under `${CLAUDE_PLUGIN_ROOT}`.
  - `buildRunManifest(args): RunManifest` recording base commit, producer id/version/model, effective policy, repo-instruction paths+hashes, prompt hash, execution policy, runtime + schema versions, packaged-verifier version+hash. Env recorded as names + redacted provenance.

- [ ] **Step 1: Write the failing test** — point `CLAUDE_PLUGIN_DATA` at a temp dir; `writeResult` then `readResult` round-trips; `writeLog` redacts a token in the stored file; `prune` removes an over-age run dir.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write both modules.** Resolve data dir from `process.env.CLAUDE_PLUGIN_DATA` with a `os.tmpdir()` fallback for tests. `manifestHash`/`promptHash` via sha256.

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/artifact-store.ts src/runtime/run-manifest.ts tests/runtime/artifact-store.test.ts
git commit -m "feat(runtime): archive redacted run artifacts and manifests under plugin data"
```

---

### Task 12: ProducerAdapter contract and capability types

**Files:**
- Create: `src/producers/producer-adapter.ts` (contract **C5** verbatim, plus contexts)
- Test: `tests/runtime/producer-adapter.test.ts`

**Interfaces:**
- Consumes: **C4/C5**, **C2**.
- Produces: **C5** types plus `ProbeContext = { ps: PlatformServices; os; arch; environmentType: "native"|"wsl" }` and `InvocationContext = { worktreePath: string; runId: string; tempHome?: string }`. A `detectEnvironmentType(): "native"|"wsl"` helper (Linux + `/proc/version` containing `microsoft` ⇒ `wsl`). No adapter chooses its own Failure Classification — that stays in AttemptRuntime.

- [ ] **Step 1: Write the failing test** — assert `detectEnvironmentType()` returns `"native"` on macOS and that a trivial in-file `FakeAdapter implements ProducerAdapter` type-checks and its `probe` returns a `CapabilityReport` with `laneEligibility.edit` boolean.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/producers/producer-adapter.ts`** — export **C5** + contexts + `detectEnvironmentType`.

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/producers/producer-adapter.ts tests/runtime/producer-adapter.test.ts
git commit -m "feat(producers): define shared adapter contract and capability types"
```

---

### Task 13: CodexAdapter

**Files:**
- Create: `src/producers/codex-adapter.ts`
- Test: `tests/runtime/codex-adapter.test.ts`, `tests/runtime/fixtures/codex-*.json` (captured native-event fixtures)

**Interfaces:**
- Consumes: **C5**, `ProbeContext`, `InvocationContext`, `git`/`supervise` only through injected `ps`.
- Produces: `CodexAdapter: ProducerAdapter` with `producerId="codex"`. `probe`: resolve `codex` executable (`ResolvedExecutable`); `--version` for `version`; `authState:"unknown"` unless a documented local non-mutating probe exists (P0 contacts no remote service); `structuredOutput:true`; `writeConfinementBackend`: on macOS `"codex-native-sandbox"` **only if** Task 13's confinement test (below) proves it blocks an out-of-worktree write, else `null`; `laneEligibility.edit = available && writeConfinementBackend != null`. Per **C7**, if the confinement test cannot pass in P0-A, the adapter reports `writeConfinementBackend:null` + `laneEligibility.edit=false` and P0-A ships the delegate path as diagnostics-only. `buildInvocation`: one-shot non-interactive `codex exec` form with the objective+context+allowlist rendered into the prompt on **stdin**, `--sandbox`/reasoning flags as argv (never a shell string); `requiredEnv` = the minimal allowlist Codex needs. `normalizeEvents`: parse Codex's structured stdout into `AdapterEvent[]`; if it cannot, set `ok:false` (→ AttemptRuntime maps to `invalid-output`). `configurationProfile`: declares Codex credential vs behavior separation and `temporaryHomeStrategy`.

- [ ] **Step 1: Capture native-event fixtures** — record real `codex exec` stdout for a trivial task into `tests/runtime/fixtures/codex-success.json` and a malformed sample into `codex-garbage.txt`. (If `codex` is unavailable in CI, commit hand-authored fixtures matching the documented schema and note the source.)

- [ ] **Step 2: Write the failing test** — `normalizeEvents(codex-success)` → `ok:true`, non-null `producerSummary`, ≥1 event; `normalizeEvents(codex-garbage)` → `ok:false`. `buildInvocation` returns argv arrays with the prompt on `stdin` and **no** interpolated shell string. `probe` on a stubbed `ps` whose `resolveExecutable` throws → `available:false, reason:"missing-executable"`.

- [ ] **Step 3: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 4: Write `src/producers/codex-adapter.ts`.** Keep all Codex-specific CLI knowledge here; expose nothing Codex-shaped to the runtime beyond the **C5** contract.

- [ ] **Step 5: Confinement gate test (macOS)** — with a real `codex` available, run a spec whose producer attempts to write a file **outside** the attempt worktree; assert the write is blocked (Codex native sandbox). If it passes, `probe` may report `writeConfinementBackend:"codex-native-sandbox"`; if `codex` is unavailable or the write is not blocked, assert `probe` returns `writeConfinementBackend:null` + `laneEligibility.edit=false`. This is the P0-A implementation-Lane certification gate (**C7**).

- [ ] **Step 6: Run test** — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/producers/codex-adapter.ts tests/runtime/codex-adapter.test.ts tests/runtime/fixtures/codex-*
git commit -m "feat(producers): add Codex adapter with capability probe and event normalization"
```

---

### Task 14: ProducerRegistry, RoutingPolicy, and CapabilityProbe

**Files:**
- Create: `src/producers/producer-registry.ts`, `src/producers/routing-policy.ts`, `src/producers/capability-probe.ts`
- Test: `tests/runtime/routing-policy.test.ts`, `tests/runtime/capability-probe.test.ts`

**Interfaces:**
- Consumes: **C5**, `CodexAdapter`.
- Produces:
  - `registry`: `{ get(id): ProducerAdapter | undefined; all(): ProducerAdapter[] }` (machine facts only — no preferences).
  - `probeAll(ctx): Promise<CapabilityReport[]>` — runs each adapter's `probe`, **no side effects, not cached** across attempts.
  - `route(preferences: string[], reports: CapabilityReport[]): { producerId } | { producerId: null; reason }` — walks Host preference order; returns the first producer with `laneEligibility.edit === true`. **Stops without fallback** at the first preference whose report `reason` is `authentication-required`, returning `{ producerId: null, reason: "authentication-required" }` (the spec forbids auto-fallback in this case). Other pre-launch unavailability (missing executable, unsupported platform) **does** fall through to the next preference. All-ineligible → `{ producerId: null, reason: "no-eligible-producer" }`.

- [ ] **Step 1: Write the failing routing test** — preferences `["pi","codex"]`: (a) `pi.available=false, reason:"missing-executable"`, `codex` eligible → routes to `codex` (fallback allowed); (b) `pi` report `reason:"authentication-required"` → `{ producerId:null, reason:"authentication-required" }` (**no** fallback to codex); (c) all ineligible → `{ producerId:null, reason:"no-eligible-producer" }`; (d) preserves order (first eligible wins).

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write the three modules.** `probeAll` maps `registry.all()` through `probe(ctx)`. `route` is pure.

- [ ] **Step 4: Write the capability-probe test** — with a registry containing only `CodexAdapter` and a stubbed `ps`, `probeAll` returns one `CapabilityReport` and calling it twice re-probes (no caching).

- [ ] **Step 5: Run both tests** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/producers/producer-registry.ts src/producers/routing-policy.ts src/producers/capability-probe.ts tests/runtime/routing-policy.test.ts tests/runtime/capability-probe.test.ts
git commit -m "feat(producers): add registry, host-ordered routing, and per-attempt probe"
```

---

### Task 15: AttemptRuntime orchestration

**Files:**
- Create: `src/runtime/attempt-runtime.ts`
- Test: `tests/runtime/attempt-runtime.test.ts`

**Interfaces:**
- Consumes: everything above — `validateSpec`, `checkPreconditions`, `probeAll`, `route`, `WorktreeManager`, `buildEnvironment`, `supervise`, adapter `buildInvocation`/`normalizeEvents`, `freezeCandidate`, `AcceptanceVerifier` (Task 18, injected), `ArtifactStore`, `classifyFailure`.
- Produces: `runAttempt(checkoutPath: string, spec: DelegationSpec, deps): Promise<AttemptResult>`. Spec validation is already done by the Task 21 `delegate` handler; this function assumes a valid spec. Pipeline: nested-delegation guard (`CLAUDE_ARCHITECT_DELEGATED` present ⇒ **throw `NestedDelegationError`** — never an `AttemptResult`; the Task 21 handler maps it to `{ ok:false, error:"nested-delegation-denied" }`) → `canonicalizePath(checkoutPath)` → `checkPreconditions` → `probeAll` → `route` (→ `unavailable`/`authentication-required` per **C7** if none) → acquire checkout lock → **write `run-start.json` (lockKey, canonicalCommonDir, startedAt) before spawning** → `WorktreeManager.create(base)` → read `adapter.configurationProfile()` and apply its `temporaryHomeStrategy`/credential allowlist → `buildEnvironment` (with tempHome; record effective policy in Run Manifest) → `buildInvocation` → `supervise` producer (**record producer pid** into `run-start.json`) → **if `exit.spawnError` is set → `spawn-failure`** (skip freeze/verify); on `exit.timedOut` → `timeout`; on `exit.cancelled` → `cancelled`; on non-normalizable output `invalid-output`; on non-zero exit with normalizable output `producer-failure` → `freezeCandidate` → `AcceptanceVerifier.verify` → `classifyFailure` (mapping per **C7**) → build `AttemptResult` (candidate preserved on `verification-failure` per **C3/C7**) → archive → cleanup worktree + release lock. **Every terminal path archives and cleans up.** Freeze-reject mapping (from **C7**): `out-of-scope-write`/`modified-symlink` → `sandbox-violation`; `empty-candidate` → `verification-failure`.

- [ ] **Step 1: Write the failing test with a fake adapter** — add `tests/runtime/fixtures/edit-file.mjs` (writes an allowlisted file in cwd). Inject a `FakeAdapter` whose `buildInvocation` runs `edit-file.mjs` and whose `normalizeEvents` returns `ok:true`, plus a fake verifier returning `{ ok:true, evidence:{} }`. Assert:
  - happy path → `status:"verified-candidate"`, `failure:null`, non-null `candidate` with a 40-hex `candidateTreeOid`.
  - nested guard: with `CLAUDE_ARCHITECT_DELEGATED=1` in the constructed env, `runAttempt` **throws `NestedDelegationError`** (assert via `expect(...).rejects.toThrow(NestedDelegationError)`) — it does **not** return an `AttemptResult`. (The Task 21 handler maps the throw to `{ ok:false, error:"nested-delegation-denied" }`.)
  - unavailable: `route` returns none → `status:"unavailable"`, `failure:"unavailable"`.
  - sandbox: fake adapter writes outside the allowlist → `freezeCandidate` rejects → `status:"failed"`, `failure:"sandbox-violation"`.
  - spawn-failure: fake adapter's invocation resolves to a nonexistent path → `status:"failed"`, `failure:"spawn-failure"`.
  - producer-failure: fixture exits non-zero but `normalizeEvents` returns `ok:true` → `failure:"producer-failure"`.
  - invalid-output: `normalizeEvents` returns `ok:false` → `failure:"invalid-output"`.
  - config isolation: a fake `HOME`-reading producer under a `controlled-config-supported` profile does **not** see the real `HOME`; an `inherited-config-only` profile is recorded in the manifest, not silently applied.

```ts
import { describe, it, expect } from "vitest";
import { runAttempt } from "../../src/runtime/attempt-runtime.js";
import { NestedDelegationError } from "../../src/util/errors.js";
// repo = a temp git repo (as in Task 8); build deps with FakeAdapter + fake AcceptanceVerifier { ok:true, evidence:{} }
it("produces a verified candidate on the happy path", async () => {
  const result = await runAttempt(repo, validSpec, fakeDeps);
  expect(result.status).toBe("verified-candidate");
  expect(result.failure).toBeNull();
  expect(result.candidate?.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
});
it("reports unavailable when no producer is eligible", async () => {
  const result = await runAttempt(repo, validSpec, { ...fakeDeps, reports: [] });
  expect(result.status).toBe("unavailable");
  expect(result.failure).toBe("unavailable");
});
it("throws on nested delegation", async () => {
  await expect(runAttempt(repo, validSpec, { ...fakeDeps, env: { CLAUDE_ARCHITECT_DELEGATED: "1" } }))
    .rejects.toThrow(NestedDelegationError);
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/runtime/attempt-runtime.ts`.** Collect `FailureSignals` as the pipeline proceeds; call `classifyFailure` once at the end; `verified-candidate` only when signals are empty **and** a non-empty candidate verified. Guarantee cleanup in `finally`.

- [ ] **Step 4: Run test** — `npx vitest run tests/runtime/attempt-runtime.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/attempt-runtime.ts tests/runtime/attempt-runtime.test.ts
git commit -m "feat(runtime): orchestrate delegation attempt end to end with failure precedence"
```

---

### Task 16: Structural verifier (packaged, no candidate import)

**Files:**
- Create: `src/verify/structural-verifier.ts`
- Test: `tests/runtime/structural-verifier.test.ts`

**Interfaces:**
- Consumes: `git`, **C3** (`CandidateArtifact`).
- Produces: `structuralVerify(args): { ok: boolean; failures: string[]; manifestHash: string }` where `args = { repoRoot, worktreePath, baseCommitOid, artifact, writeAllowlist, forbiddenScope }`. Uses **only** trusted runtime + Git executables; never imports candidate code. Checks: (a) recompute the tracked + non-ignored manifest and compare to `artifact.changedPaths`/`manifestHash`; (b) every changed path within allowlist and outside forbidden scope; (c) no added/modified symlinks; (d) not an empty success when the spec requires code changes; (e) base commit still matches `baseCommitOid` and main checkout clean.

- [ ] **Step 1: Write the failing test** — a frozen artifact verifies `ok:true`; a tampered `manifestHash` → `ok:false` with a `"manifest-divergence"` failure; a changed base commit → `"base-changed"`.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/verify/structural-verifier.ts`.** Recompute via `git ls-tree -r <candidateTreeOid>` + `git diff-tree` against base; sha256 the sorted manifest; string-compare to `artifact.manifestHash`. **This detects tampering of the artifact record and base drift — it operates on the immutable tree object, so it is NOT the verification-mutation check.** The on-disk mutation rescan lives in Task 17 (a different computation over a different input: the materialized worktree).

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify/structural-verifier.ts tests/runtime/structural-verifier.test.ts
git commit -m "feat(verify): add packaged structural verifier over the frozen candidate"
```

---

### Task 17: Project verifier (Host-authorized commands under confinement)

**Files:**
- Create: `src/verify/project-verifier.ts`
- Test: `tests/runtime/project-verifier.test.ts`

**Interfaces:**
- Consumes: **C2** (`VerificationCommand`), `PlatformServices`, `supervise`, `structuralVerify` (Task 16), `redact`.
- Consumes also: `ArtifactStore` (Task 11) to store bounded, redacted stdout/stderr and stamp `CommandOutcome.stdoutRef`/`stderrRef` — or return raw bounded output and let Task 15 archive + stamp the refs (state which; the plan uses the latter to keep `projectVerify` free of the store).
- Produces: `projectVerify(args): Promise<{ commandOutcomes: CommandOutcome[]; mutated: boolean; failures: string[] }>`. Runs **only** commands from the validated spec (never producer-suggested ones); materializes the frozen candidate into a **disposable** worktree (`git worktree add --detach <tmp> <candidateCommitOid>`); resolves each executable via `PlatformServices.resolveExecutable`; records `confinement`/`networkPolicy` per **C7** (P0-A: unenforced, recorded honestly). **After each command**, run `git status --porcelain=v2 -z --untracked-files=all` **inside the materialized worktree** (its `HEAD` is `candidateCommitOid`, so **any** output means a command mutated the frozen tree) → set `mutated:true` (→ `verification-failure`). Records real exit codes and `expectedExitCodes` mismatches. Filters commands by `platform.os`/`arch`.

- [ ] **Step 1: Write the failing test** — a passing command (`node -e "process.exit(0)"` with `expectedExitCodes:[0]`) → outcome `exitCode:0`, `mutated:false`; a command that writes a file into the materialized worktree → `mutated:true`; a command exiting 1 when `expectedExitCodes:[0]` → recorded as a failure.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/verify/project-verifier.ts`.** Materialize → loop commands → supervise → **on-disk `git status` rescan of the materialized worktree** (not a tree-oid recompute) → clean up the disposable worktree in `finally`.

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify/project-verifier.ts tests/runtime/project-verifier.test.ts
git commit -m "feat(verify): run host-authorized checks on a disposable candidate materialization"
```

---

### Task 18: AcceptanceVerifier orchestration

**Files:**
- Create: `src/verify/acceptance-verifier.ts`
- Test: `tests/runtime/acceptance-verifier.test.ts`

**Interfaces:**
- Consumes: `structuralVerify` (Task 16), `projectVerify` (Task 17).
- Produces: `AcceptanceVerifier.verify(args): Promise<{ ok: boolean; failures: string[]; evidence: Record<string,unknown>; commandOutcomes: CommandOutcome[] }>`. Stage 1 structural (runs first; on failure, skip project verification and return). Stage 2 project. `ok = structural.ok && !project.mutated && all commands within expectedExitCodes && !empty-success`. Producer "tests pass" claims are recorded as evidence only and never substitute for verifier results.

- [ ] **Step 1: Write the failing test** — structural failure short-circuits (project verifier not called, asserted via a spy); both passing → `ok:true` with merged `evidence`.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/verify/acceptance-verifier.ts`.**

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify/acceptance-verifier.ts tests/runtime/acceptance-verifier.test.ts
git commit -m "feat(verify): orchestrate structural then project acceptance verification"
```

---

### Task 19: ControlledIntegrator

**Files:**
- Create: `src/integrate/controlled-integrator.ts`
- Test: `tests/runtime/controlled-integrator.test.ts`

**Interfaces:**
- Consumes: `git`, **C3** (`CandidateArtifact`), `checkPreconditions`, checkout lock.
- Produces: `applyCandidateTree(args): Promise<{ integration: "applied"|"conflicted"|"aborted"; detail: string }>` where `args = { repoRoot, artifact, expectedArtifactHash }`. (The MCP `integrateCandidate` tool — Task 21 — resolves the run record, enforces the host-decision gate, then calls this.) Steps: acquire checkout lock → revalidate base commit still `HEAD` **and** clean → revalidate `artifact.manifestHash === expectedArtifactHash` and that `refs/claude-architect/candidates/<runId>` still resolves to `candidateCommitOid` with matching `candidateTreeOid` → apply the **tree** with a two-tree merge that handles adds, modifications, **and deletions** atomically and aborts *before* touching the working tree if it diverges:

  ```
  git read-tree -m -u <baseCommitOid> <candidateTreeOid>   # against the repo's REAL index
  ```

  `read-tree -m -u` refuses (non-zero, no changes written) if the working tree is not clean at base, so combined with the earlier clean-at-base check every failure mode aborts *before* mutation — unlike `checkout-index -a -f`, which cannot delete files and rewrites the whole tree. The **pre-apply checks (base == HEAD, clean, `manifestHash` match, tree/ref match) are the guard**: any failure returns `aborted`/`conflicted` with the checkout **byte-unchanged** (nothing was written). The two-tree merge of the already-validated, content-addressed tree is deterministic, so no post-apply gate is needed; still run one `git status` sanity check, and on the should-be-impossible divergence roll back with `git reset --hard <base>` and return `aborted`. On success: delete the anchor ref (per **C7**) and report `applied`. Integration leaves the candidate **applied to the working tree and index (staged, not committed)** — Claude/the user commits. Lock released in `finally`.

  > If the seeded/real index lacks stat info, precede the merge with `git update-index -q --refresh` to avoid a spurious "not uptodate. Cannot merge." abort.

- [ ] **Step 1: Write the failing test** — happy path: freeze a candidate, `applyCandidateTree` with the correct hash → `applied` and the file content in the main checkout matches; **deletion** candidate (freeze a candidate that removes a file) → `applied` and the file is gone from the main checkout; **binary + mode-change** candidate → applied faithfully; stale base (advance `HEAD` after freeze) → `aborted`/`conflicted` and the working tree is untouched; wrong `expectedArtifactHash` → `aborted` and untouched.

```ts
it("applies the candidate tree when base and hash match", async () => {
  const r = await applyCandidateTree({ repoRoot, artifact, expectedArtifactHash: artifact.manifestHash });
  expect(r.integration).toBe("applied");
});
it("applies a deletion candidate", async () => {
  // artifact deletes a.txt
  const r = await applyCandidateTree({ repoRoot, artifact: delArtifact, expectedArtifactHash: delArtifact.manifestHash });
  expect(r.integration).toBe("applied");
  expect(existsSync(join(repoRoot, "a.txt"))).toBe(false);
});
it("refuses a stale base without mutating the checkout", async () => {
  await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "advance"]); // base moved
  const before = await readFile(join(repoRoot, "a.txt"), "utf8");
  const r = await applyCandidateTree({ repoRoot, artifact, expectedArtifactHash: artifact.manifestHash });
  expect(r.integration).not.toBe("applied");
  expect(await readFile(join(repoRoot, "a.txt"), "utf8")).toBe(before);
});
```

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/integrate/controlled-integrator.ts`** exporting `applyCandidateTree`. Use the `read-tree -m -u` two-tree merge; verify against Git behavior in the tests (the spec requires integration tests for binary files, modes, deletions, untracked files, and conflicts — the Step 1 matrix covers deletion/binary/mode/stale-base/hash-mismatch).

- [ ] **Step 4: Run test** — `npx vitest run tests/runtime/controlled-integrator.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrate/controlled-integrator.ts tests/runtime/controlled-integrator.test.ts
git commit -m "feat(integrate): apply the exact reviewed tree with base and hash revalidation"
```

---

### Task 20: MCP bootstrap contract

**Files:**
- Create: `runtime/bootstrap.mjs` (hand-written, committed — **not** bundled), `src/mcp/bootstrap-check.ts`
- Test: `tests/runtime/bootstrap-check.test.ts`, `tests/runtime/bootstrap.smoke.test.ts`

**Interfaces:**
- Consumes: **C1**, `getPlatformServices` (for node resolution).
- Produces: `runtime/bootstrap.mjs` is the process `.mcp.json` launches. Contract: verify `process.versions.node` major ≥ 22 (refuse Node 20 even if found first); if too old, resolve a ≥22 `node` on `PATH` and re-spawn `<node> runtime/server.mjs` inheriting stdio; if none, write an **actionable** diagnostic to **stderr** and exit non-zero (never a corrupt stdout stream); otherwise `import(process.env.CLAUDE_ARCHITECT_SERVER_PATH ?? "./server.mjs").then(m => m.start())` (the env override lets the smoke test substitute a fake server without overwriting the committed bundle). All diagnostics stderr-only; stdout carries protocol only. `bootstrap-check.ts` holds the testable pure helpers (`isNodeSupported(version)`, `formatMissingNodeDiagnostic()`).
- **Startup/crash/restart (defined here per spec):** the runtime exits non-zero on an unrecoverable bootstrap error; Claude Code owns MCP restart. Document that `.mcp.json` relies on host restart, that a startup that has not completed the MCP `initialize` handshake within the host's timeout is surfaced by the host, and that `runAttempt` is **not** auto-resumed after a crash (P0 has no resumable attempts) — recovery (Task 24) reclaims locks/worktrees on the next start. The residual dependency that `node` is resolvable on the host `PATH` *before* bootstrap runs is documented honestly (bootstrap can re-exec a better node but cannot find a first one).

- [ ] **Step 1: Write the failing unit test** — `isNodeSupported("v22.1.0") === true`, `isNodeSupported("v20.19.0") === false`; `formatMissingNodeDiagnostic()` mentions "Node.js 22".

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/mcp/bootstrap-check.ts` and `runtime/bootstrap.mjs`.** `bootstrap.mjs` is plain committed ESM (the committed `runtime/server.mjs` bundle exists on a fresh clone). Keep it dependency-free.

- [ ] **Step 4: Write a smoke test** — copy `bootstrap.mjs` + a fake `server.mjs` (prints a ready line to stderr) into a temp dir, or set `CLAUDE_ARCHITECT_SERVER_PATH` to the fake; spawn `node <tmp>/bootstrap.mjs`; assert stdout stays empty and the process starts. (Full protocol handshake is exercised in Task 21/25.)

- [ ] **Step 5: Run tests** — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add runtime/bootstrap.mjs src/mcp/bootstrap-check.ts tests/runtime/bootstrap-check.test.ts tests/runtime/bootstrap.smoke.test.ts
git commit -m "feat(mcp): add bootstrap with Node-22 floor and stderr-only diagnostics"
```

---

### Task 21: MCP server, tool registration, and per-repository serialization

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/serialize.ts`
- Modify: `src/index.ts` (call `start()`)
- Test: `tests/runtime/tools.test.ts`, `tests/runtime/serialize.test.ts`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk`, `validateSpec`, `runAttempt`, `AcceptanceVerifier`, `integrateCandidate`, `ArtifactStore`, **C6**.
- Produces: `start()` runs `recoverStaleRuns()` (Task 24), then builds an `McpServer({ name:"claude-architect", version: RUNTIME_VERSION })`, registers the **C6** tools, and connects a `StdioServerTransport`. It also refuses to serve and emits a stderr diagnostic naming the variable when `CLAUDE_ARCHITECT_DELEGATED` is present at startup. Tools (all take/resolve `checkoutPath` per **C6**):
  - `delegate(checkoutPath, spec)`: check protocol/schema-version compatibility (→ `{ ok:false, diagnostic }` on mismatch); `validateSpec`; on invalid → `{ ok:false, validationErrors }` (the **repair loop**, no producer touched); on valid → `canonicalizePath` → serialize per canonical common dir → `runAttempt(checkoutPath, spec, deps)` (wires `AcceptanceVerifier`); a caught `NestedDelegationError` → `{ ok:false, error:"nested-delegation-denied" }`; else `{ ok:true, result }`. The archived run record stores the canonical `repoRoot` so runId-only tools can rehydrate it.
  - `reviewCandidate(runId)`: load the `AttemptResult` + `repoRoot` from `ArtifactStore`; **regenerate the patch UNREDACTED from the anchored tree** (`git diff --binary --full-index <base> <candidateTree>`) so Claude reviews the exact integrated bytes; return `{ patch, changedPaths, evidence, executedVerification }`.
  - `decideCandidate(runId, decision)`: persist `${CLAUDE_PLUGIN_DATA}/runs/<runId>/decision.json` via `ArtifactStore`; on `rejected` delete the anchor ref (**C7**); return `{ recorded:true }`.
  - `integrateCandidate(runId, expectedArtifactHash)`: load run record; **refuse (`aborted`, detail `"no-accepted-decision"`) unless the latest recorded decision is `accepted`**; else resolve `{ repoRoot, artifact }` and call `applyCandidateTree` (Task 19); return `{ integration, detail }`.
  - `doctor()` (Task 22).
  - `serialize.ts`: `withRepoLock(key, fn)` — an async mutex keyed by the canonical Git common dir so concurrent tool calls against one repo run one-at-a-time (one-active-attempt).

- [ ] **Step 1: Write the failing tools test** — extract handlers into `tools.ts` as plain async functions the test can import. Assert: `delegate` with an invalid spec → `{ ok:false, validationErrors }`; `delegate` with a valid spec + fake deps → `{ ok:true, result.status:"verified-candidate" }`; `reviewCandidate(runId)` returns a `patch` regenerated from the tree; `decideCandidate(runId,"accepted")` → `{ recorded:true }` and writes `decision.json`; `integrateCandidate(runId, hash)` **without** a prior accepted decision → `{ integration:"aborted", detail:"no-accepted-decision" }`, and **with** it → `applied`.

- [ ] **Step 2: Write the failing serialize test** — two overlapping `withRepoLock(key, fn)` calls with the same key run sequentially (assert via timestamps); different keys run concurrently.

- [ ] **Step 3: Run to verify both fail** — Expected: FAIL.

- [ ] **Step 4: Write `src/mcp/tools.ts`, `src/mcp/serialize.ts`, `src/mcp/server.ts`.** Registration (verify `registerTool` signature against the installed SDK — inputSchema is a Zod raw shape in v1.x):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RUNTIME_VERSION } from "../protocol/versions.js";
export async function start() {
  const server = new McpServer({ name: "claude-architect", version: RUNTIME_VERSION });
  server.registerTool("delegate",
    { title: "Delegate an implementation subtask",
      description: "Validate a Delegation Spec and run one verified attempt.",
      // spec is validated by validateSpec (not zod) to keep the repair loop authoritative:
      inputSchema: { checkoutPath: z.string(), spec: z.unknown() } },
    async ({ checkoutPath, spec }) => {
      const out = await handleDelegate(checkoutPath, spec);
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    });
  // register reviewCandidate({ runId }), decideCandidate({ runId, decision }),
  // integrateCandidate({ runId, expectedArtifactHash }), doctor({}) — each with its handleX(...) from tools.ts
  await server.connect(new StdioServerTransport());
  console.error("claude-architect MCP server ready");   // stderr only
}
```

- [ ] **Step 5: Update `src/index.ts`** to `export { start } from "./mcp/server.js"` and call `start()` when run as the entry.

- [ ] **Step 6: Run tests + build** — `npx vitest run tests/runtime/tools.test.ts tests/runtime/serialize.test.ts && npm run build`. Expected: PASS; `runtime/server.mjs` rebuilt.

- [ ] **Step 6b: Real MCP-handshake smoke test** — spawn `node runtime/bootstrap.mjs`, drive an `initialize` + `tools/list` over stdio with the SDK client (or raw JSON-RPC), assert `delegate`/`reviewCandidate`/`decideCandidate`/`integrateCandidate`/`doctor` are listed and **stdout carried only protocol** (no stray bytes). This is the first time the real esbuild bundle runs end to end — it catches the `createRequire`/`Dynamic require` ESM trap immediately rather than at Task 25.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/mcp/serialize.ts src/index.ts runtime/server.mjs tests/runtime/tools.test.ts tests/runtime/serialize.test.ts tests/runtime/handshake.smoke.test.ts
git commit -m "feat(mcp): register delegation lifecycle tools with per-repo serialization"
```

---

### Task 22: Doctor tool and read-only Git tools for the advisor

**Files:**
- Create: `src/mcp/doctor.ts`, `src/mcp/git-read-tools.ts`
- Modify: `src/mcp/server.ts` (register them)
- Test: `tests/runtime/doctor.test.ts`, `tests/runtime/git-read-tools.test.ts`

**Interfaces:**
- Consumes: `probeAll`, `git`, `checkPreconditions`, `redact`, **C1**.
- Produces:
  - `doctor()` → `{ node: {version, ok}, git: {version, ok}, producers: CapabilityReport[], runtimeVersion, schemaVersion, protocolVersion, issues: string[] }`. Reachable over MCP so `/claude-architect:delegate` returns structured diagnostics when Node/Git/Producers are unavailable — **and it must respond on an unsupported Host platform** (via the `DiagnosticsOnlyPlatformServices` from **C7**), reporting `unsupported-platform` under `issues`, never crashing. Also reports a missing `CLAUDE_PLUGIN_DATA` and a stray `CLAUDE_ARCHITECT_DELEGATED` under `issues`.
  - Read-only git tools registered on the server: `gitStatus`, `gitDiff`, `gitLog`, `gitChangedFiles` — each **redacted**, argv-only, scoped for the advisor as `mcp__plugin_claude-architect_runtime__<tool>`.

- [ ] **Step 1: Write the failing tests** — `doctor()` returns `runtimeVersion === RUNTIME_VERSION`, a `protocolVersion`, and a `producers` array containing a `codex` report; with an injected `os:"win32"` platform stub, `doctor()` still returns and lists `unsupported-platform` under `issues` (no throw); `gitStatus` on a dirty temp repo returns porcelain lines with any token redacted.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/mcp/doctor.ts` and `src/mcp/git-read-tools.ts`; register in `server.ts`.**

- [ ] **Step 4: Run tests + build** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/doctor.ts src/mcp/git-read-tools.ts src/mcp/server.ts runtime/server.mjs tests/runtime/doctor.test.ts tests/runtime/git-read-tools.test.ts
git commit -m "feat(mcp): add doctor diagnostics and redacted read-only git tools"
```

---

### Task 23: Plugin wiring — `.mcp.json`, SKILL rewrite, advisor agent, manifests

**Files:**
- Create: `.mcp.json`, `agents/advisor.md`, `scripts/build-runtime.sh` (dev/CI only)
- Modify: `skills/delegate/SKILL.md`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`, `CHANGELOG.md`, `scripts/validate-release.sh`
- Test: `tests/runtime/plugin-wiring.test.mjs`

**Interfaces:**
- Consumes: `runtime/bootstrap.mjs`, the MCP tools.
- Produces: a plugin that starts the runtime MCP server and exposes `/claude-architect:delegate` driving the `delegate` tool.

- [ ] **Step 1: Write `.mcp.json`** (server key `runtime`; resolved through `${CLAUDE_PLUGIN_ROOT}`; **no** Bash-`PATH` dependency):

```json
{
  "mcpServers": {
    "runtime": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/runtime/bootstrap.mjs"]
    }
  }
}
```

> `"command": "node"` means the host resolves `node` on its `PATH` **before** bootstrap runs; bootstrap can re-exec a newer node but cannot conjure a first one. Document this residual dependency in the README and `doctor`. (A future option is a small native launcher; out of scope for P0-A.)

- [ ] **Step 2: Write the failing wiring test** — assert `.mcp.json` parses, its server `command` is `node`, its arg references `${CLAUDE_PLUGIN_ROOT}/runtime/bootstrap.mjs`, and `runtime/bootstrap.mjs` + `runtime/server.mjs` exist. Assert `agents/advisor.md` frontmatter `tools` includes `Read, Grep, Glob` and the scoped `mcp__plugin_claude-architect_runtime__gitStatus` (etc.) and **excludes** `Bash`, `Write`, `Edit`, and that it declares no `mcpServers`/`hooks`/`permissionMode` keys. Assert `skills/delegate/SKILL.md` carries the `PROTOCOL_VERSION` marker (frontmatter or a fenced marker the delegate flow echoes) so the runtime can detect a skill/runtime version mismatch.

- [ ] **Step 3: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 4: Write `agents/advisor.md`** — frontmatter:

```markdown
---
name: advisor
description: Strictly non-mutating commitment-boundary advisor. Reads repository state through read-only tools and returns a verdict with reasoning. Never edits.
tools: Read, Grep, Glob, mcp__plugin_claude-architect_runtime__gitStatus, mcp__plugin_claude-architect_runtime__gitDiff, mcp__plugin_claude-architect_runtime__gitLog, mcp__plugin_claude-architect_runtime__gitChangedFiles
model: opus
---
```

- [ ] **Step 5: Rewrite `skills/delegate/SKILL.md`** so `/claude-architect:delegate` has Main Claude construct a candidate Delegation Spec and call the `delegate` MCP tool; on `ok:false` repair from `validationErrors` and resubmit; on `verified-candidate` call `reviewCandidate` → present the diff/evidence → `decideCandidate` → on `accepted` `integrateCandidate`. Keep the legacy `*-implementer` Agent lanes documented as fallback (migration note). Never present bare `/delegate`.

- [ ] **Step 6: Bump versions to `0.8.0`** in `plugin.json`, `marketplace.json`, README badge, and add a `CHANGELOG.md` `0.8.0` entry (P0-A runtime). **Publish the reduced support matrix** in the README and marketplace metadata (per **C7**: macOS arm64 = certified; Linux + native Windows = pending P0-B; Codex edit-Lane eligibility contingent on the Task 13 confinement gate). Update `scripts/validate-release.sh` to also assert `runtime/server.mjs` + `runtime/bootstrap.mjs` are present and freshly built (`npm run build` produces no diff), that `.mcp.json` parses, and that the SKILL `PROTOCOL_VERSION` marker equals `src/protocol/versions.ts`.

- [ ] **Step 7: Run** — `npx vitest run tests/runtime/plugin-wiring.test.mjs && bash scripts/validate-release.sh`. Expected: PASS.

- [ ] **Step 8: Commit** (no Claude co-author trailer — see Global Constraints)

```bash
git add .mcp.json agents/advisor.md skills/delegate/SKILL.md .claude-plugin/ README.md CHANGELOG.md scripts/ tests/runtime/plugin-wiring.test.mjs
git commit -m "feat(plugin): wire MCP runtime, advisor allowlist, and delegate skill"
```

---

### Task 24: RecoveryManager (P0-A minimal)

**Files:**
- Create: `src/runtime/recovery-manager.ts`
- Test: `tests/runtime/recovery-manager.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore`, `WorktreeManager`, `PlatformServices.terminateProcessTreeByPid`, checkout lock.
- Produces: `recoverStaleRuns(): Promise<{ recovered: string[] }>` — on startup, scan **both** run dirs under `${CLAUDE_PLUGIN_DATA}/runs/*` with a `run-start.json` but no terminal `AttemptResult`, **and** `${CLAUDE_PLUGIN_DATA}/locks/*`. For each: `terminateProcessTreeByPid(pid)` for the recorded pid (if any), archive recoverable evidence, remove the stale worktree, and **reclaim any lock whose recorded owner pid is dead or whose run has no live record** (closing the crash-after-lock-before-run-dir permanent-brick hole). Delete anchor refs for pruned runs. (Full crash-recovery matrix — orphan escalation, cross-session races — is P0-B.)

- [ ] **Step 1: Write the failing test** — seed a fake stale run dir + stale lock; `recoverStaleRuns()` returns it in `recovered` and the lock file is gone.

- [ ] **Step 2: Run to verify it fails** — Expected: FAIL.

- [ ] **Step 3: Write `src/runtime/recovery-manager.ts`; call it from `start()` (Task 21) before serving.**

- [ ] **Step 4: Run test + build** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/recovery-manager.ts src/mcp/server.ts runtime/server.mjs tests/runtime/recovery-manager.test.ts
git commit -m "feat(runtime): recover stale runs and release locks on startup"
```

---

### Task 25: End-to-end vertical slice and P0-A release gate

**Files:**
- Create: `tests/runtime/e2e-vertical-slice.test.ts`
- Modify: `CHANGELOG.md` (finalize `0.8.0`)
- Test: the e2e suite itself

**Interfaces:**
- Consumes: the whole runtime through the MCP tool handlers (via `tools.ts` functions, or a spawned server over stdio using the SDK client).
- Produces: proof the full lifecycle works on one certified environment.

- [ ] **Step 1: Write the e2e test** — in a temp git repo, with a **fake Codex adapter** registered (its `buildInvocation` runs a fixture that edits an allowlisted file inside the worktree; `normalizeEvents` returns `ok:true`): call `delegate(repo, spec)` → assert `result.status === "verified-candidate"`; `reviewCandidate(runId)` → assert diff contains the edit; `integrateCandidate(runId, hash)` **before** deciding → `aborted`/`no-accepted-decision`; `decideCandidate(runId, "accepted")` → `recorded:true`; `integrateCandidate(runId, result.candidate.manifestHash)` → `integration:"applied"` and the file in the **main checkout** now contains the edit. Cover **all ten** `FAILURE_PRECEDENCE` members with the fake that triggers each: `invalid-specification` (bad spec), `unavailable` (empty reports), `authentication-required` (probe reason), `spawn-failure` (nonexistent resolved path), `cancelled` (Host `AbortSignal`), `timeout` (stubborn fixture past `timeoutMs`), `sandbox-violation` (writes outside allowlist), `invalid-output` (`normalizeEvents ok:false`), `producer-failure` (non-zero exit, normalizable), `verification-failure` (fake verifier fails or empty candidate). Also assert the nested-guard throw maps to `{ ok:false, error:"nested-delegation-denied" }`.

- [ ] **Step 2: Run to verify it fails, then implement any missing glue** — Expected: FAIL first, then PASS after wiring gaps closed.

- [ ] **Step 3: Full suite + typecheck + build + release validation**

```bash
npm run typecheck && npm test && npm run build && bash scripts/validate-release.sh
```

Expected: all green; `runtime/server.mjs` freshly built with no diff.

- [ ] **Step 4: P0-A release gate (checklist — do not tag until all pass on the certified env):**
  - `/claude-architect:delegate` visible and invokable after marketplace install (manual smoke on a `--plugin-dir` install).
  - `delegate → verified-candidate → review → decide(accepted) → integrate(applied)` works.
  - Every reachable `FAILURE_PRECEDENCE` path tested with fakes.
  - `doctor` reachable over MCP and returns structured diagnostics with Node/Git/Codex unavailable.
  - `integrateCandidate` refuses stale base / dirty checkout / mismatched hash without mutating the checkout.
  - MCP bootstrap: Node-22 floor, stdout-protocol / stderr-diagnostic separation.
  - Legacy shell surface still passes its existing tests (migration guardrail).

- [ ] **Step 5: Commit + release**

```bash
git add tests/runtime/e2e-vertical-slice.test.ts CHANGELOG.md
git commit -m "test(runtime): cover full delegate-to-integrate vertical slice"
# Release only after the gate checklist passes:
git tag v0.8.0
```

---

# Milestone P0-B — Cross-Platform Hardening (roadmap)

> **This milestone becomes its own detailed TDD plan (`docs/superpowers/plans/<date>-p0b-*.md`) once P0-A lands and the real interfaces are stable.** It reuses every contract in the Canonical Contracts section; only the platform seam and confinement backends are new. Ships as **`0.9.0`**.

**Goal:** Make the P0-A runtime honestly cross-platform: native Windows Platform Services, a native process-tree helper, concrete write-confinement Sandbox Backends per OS, and full crash recovery — so the claimed support matrix is backed by passing integration tests rather than assertions.

**Task outline (each a future bite-sized task):**

- **B1 — `WindowsPlatformServices` (`src/platform/windows-platform-services.ts`).** Implements **C4** for `win32`: `PATHEXT` resolution preferring `.exe`/`.com`, then the npm JS entry point invoked as `node.exe <entry> <args...>`, then a trusted fully-resolved `.cmd`/`.bat` via `cmd.exe /d /s /c` with user values kept out of the command string; case-insensitive `Path`/`PATH` key normalization emitting one canonical key; drive/UNC/Unicode path handling; Windows file locking for the checkout lock. *Acceptance:* resolution + spawn tests green on Windows x64 and arm64.
- **B2 — Native Windows process-tree helper (`native/`).** A small helper (Job Object ownership) so `terminateProcessTree` reliably kills the whole tree; `child.kill()` on the direct child is explicitly insufficient. Shipped as a native binary resolved through `${CLAUDE_PLUGIN_ROOT}`; **no** shell script in the shipped path. *Acceptance:* forced termination leaves no surviving descendants (tested with a fork-bomb-lite fixture).
- **B3 — `select-platform.ts` returns the Windows impl** and the environment-essential Windows var set (`SystemRoot`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, canonical `Path`) is added to `EnvironmentPolicy`.
- **B4 — Concrete Sandbox Backends (`src/platform/sandbox/`).** One **named, tested write-confinement backend per certified platform** (Producer-native confinement where documented, else an OS mechanism). The Attempt Runtime **selects** the backend from the execution policy and **fails closed** when none is available. Process-tree supervision alone does **not** satisfy write confinement. *Acceptance:* fail-closed selection + policy-enforcement tests per OS.
- **B5 — CRLF/LF structured-event parsing** in adapter `normalizeEvents` (accept both without changing semantics); **Windows env-key normalization** tests; **path-scope enforcement** with case differences, drive paths, and UNC paths.
- **B6 — Full crash recovery** extending Task 24: stale-run detection across sessions, orphan escalation through Platform Services, checkout-lock release keyed by canonical common dir, stale-worktree removal, and the update-during-active-attempt contract (previous `${CLAUDE_PLUGIN_ROOT}` stays live until `/reload-plugins`). *Acceptance:* the P0-B core-runtime gates (below).

**P0-B release gates (from `CONTEXT.md` → Core Runtime Gates):** integration tests pass on macOS, Linux, and native Windows for every claimed matrix entry; space/Unicode paths covered for project, plugin, temp, and Producer paths; cooperative cancellation and forced termination leave no descendants; worktree create/remove/stale-recovery/lock-release covered; native Windows locked-file behavior handled; path-scope enforcement tested with case/drive/UNC; Producer discovery covers native executables and trusted `.cmd` wrappers; CRLF/LF event parsing; Windows `Path`/`PATH` normalization; main-checkout integrity checks pass on all OSes; marketplace install/update tested on macOS, Linux, native Windows, and WSL (reported as Linux); native Windows tested with and without Git Bash.

---

# Milestone P0-C — Producer Completion & Universal Release (roadmap)

> **Its own detailed plan once P0-B lands.** Ships as **`0.10.0`** and lifts the "universal" claim only when every gate passes. Reuses the **C5** adapter contract — each new adapter is a self-contained module plus fixtures.

**Goal:** Complete the four-Producer matrix with certified per-platform capability, then pass the final universal release gates and cut over from the legacy shell surface.

**Task outline:**

- **C1 — `OpenCodeAdapter`, `PiAdapter`, `PythinkerAdapter`** (`src/producers/*-adapter.ts`), each implementing **C5** with: discovery + `CapabilityReport`, invocation fixtures, captured native-event fixtures, a `ProducerConfigurationProfile` proving controlled-config isolation (or honest downgrade), and a **published platform-capability matrix derived from real tests**. Each adapter implements the contract **even where its report returns unavailable**.
- **C2 — Per-platform capability certification.** Populate, from real test results only, the release table:

  ```text
  Producer    macOS       Linux       Windows native    WSL
  Codex       <result>    <result>    <result>          <result>
  OpenCode    <result>    <result>    <result>          <result>
  Pi          <result>    <result>    <result>          <result>
  Pythinker   <result>    <result>    <result>          <result>
  ```

  States: `certified | tested | conditional | unsupported | unknown` (+ reason). Native Windows and WSL are **never** merged. Every implementation-Lane-certified combination **names a proven write-confinement backend**; combinations without one publish as diagnostic-only.
- **C3 — Legacy cutover.** Remove the superseded `scripts/run-*-isolated.sh` launchers and the `*-implementer` prose lanes; update `validate-release.sh`; update docs/screenshots to the MCP path only. This is the only milestone that deletes v0.7.0 surface.
- **C4 — Final plugin-integration & producer gates** (from `CONTEXT.md`): `reviewCandidate`/`decideCandidate`/`integrateCandidate` end-to-end incl. stale/dirty/hash-mismatch refusals; `doctor` over MCP; plugin cache/install paths with spaces; update-during-active-attempt preserves evidence + integrity; uninstall retain-data vs delete-data behavior; advisor effective tool set verified to exclude Bash and all mutation tools; schema-compatibility tests for spec/result versioning.

**Universal-release rule:** Claude Architect must not be described as universal until all P0-A + P0-B + P0-C gates pass. The public release stays blocked until then regardless of stage.

---

## Self-Review: Spec Coverage Map

Each `CONTEXT.md` requirement area mapped to the P0-A task (or milestone) that implements it. Areas marked *(P0-B/C)* are intentionally roadmap-only per the scope decision.

| Spec area (`CONTEXT.md`) | Implemented by |
|---|---|
| Ubiquitous Language → Delegation Spec, validation authority | Tasks 2, 3, 21 |
| Attempt Runtime, deep-module orchestration | Task 15 |
| Producer Adapter seam (discovery, invocation, normalization) | Tasks 12, 13 |
| Attempt Result canonical shape + statuses | Tasks 4, 15 |
| Host Decision / Integration Result / Candidate lifecycle tools | Tasks 19, 21 |
| Acceptance Verification (structural + project, two stages) | Tasks 16, 17, 18 |
| Candidate Artifact = content-addressed base-bound Git tree + manifest + patch | Task 9 |
| Capability Report (facts, `unknown` not inferred, native vs WSL) | Tasks 12, 13, 14 |
| Run Manifest reproducibility record | Task 11 |
| Routing Policy (Host-ordered, capability-filtered, first available) | Task 14 |
| Failure Classification vocabulary + precedence | Tasks 4, 15 |
| Sandbox Backend / write confinement, fail-closed | *(P0-B, B4)*; P0-A rejects `win32` + records backend in `CapabilityReport` (Tasks 6, 13) |
| Platform Services seam (exec, spawn, cancel, lock, temp, canonical path) | Tasks 6, 7 *(Windows impl P0-B, B1–B3)* |
| Producer Configuration Profile (credential/behavior separation) | Tasks 12, 13 |
| Plugin surface / `/claude-architect:delegate` via MCP tool | Tasks 21, 23 |
| MCP bootstrap contract (Node ≥22, stdout/stderr separation, diagnostics) | Tasks 20, 21 |
| `reviewCandidate` / `decideCandidate` / `integrateCandidate` / `doctor` tools | Tasks 21, 22 |
| Non-mutating advisor with read-only Git tools, no Bash/mutation | Tasks 22, 23 |
| `${CLAUDE_PLUGIN_ROOT}` vs `${CLAUDE_PLUGIN_DATA}` state discipline | Tasks 8, 11, 23 |
| Worktree & write policy, repository precondition matrix | Tasks 8, 9 |
| Controlled Integration (revalidate base/clean/tree/hash; applied/conflicted/aborted) | Task 19 |
| Environment layering + allowlist + redaction | Tasks 5, 10, 11 |
| Process supervision (timeout, drain, limits, tree termination) | Tasks 6, 7 *(Windows tree helper P0-B, B2)* |
| Nested-delegation denial (`CLAUDE_ARCHITECT_DELEGATED=1`) | Tasks 10, 15 |
| One-active-attempt serialization + canonical-common-dir lock | Tasks 6, 21 |
| Retention & recovery (archive redacted, stale-run recovery) | Tasks 11, 24 *(full matrix P0-B, B6)* |
| Verification strategy (fake producers, fixtures, no prose tests) | Tasks 7, 13, 15, 25 |
| Cross-platform matrix, native Windows, capability certification | *(P0-B, P0-C)* |
| Four-adapter completion + universal release gates | *(P0-C)* |

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate error handling"/"similar to Task N" left in P0-A tasks; the one remaining `"as appropriate"` freeze-reject mapping was pinned to the **C7** table. P0-B/P0-C are explicitly labelled roadmap (not placeholders) per the scope decision.

**Type-consistency check:** all task steps consume the Canonical Contracts names exactly — `DelegationSpec` (incl. required `forbiddenScope`), `AttemptResult`, `AttemptStatus`, `FailureClassification`, `FAILURE_PRECEDENCE`, `CandidateArtifact`, `ChangedPath`, `CommandOutcome`, `PlatformServices` (+ its method names, incl. `terminateProcessTreeByPid`), `ProducerAdapter`/`CapabilityReport`, `VerificationCommand`. The MCP tool names `delegate`/`reviewCandidate`/`decideCandidate`/`integrateCandidate`/`doctor` are used identically in Tasks 21–23 and **C6**; the internal integration function is **`applyCandidateTree`** (Task 19), distinct from the `integrateCandidate` tool. `NestedDelegationError`/`SpawnFailureError` are defined in Task 1.

**Adversarial review:** a five-critic pass (spec-coverage, contract-consistency, API-accuracy, TDD-soundness, design-adversary) ran against this plan and `CONTEXT.md`. Its verified findings are folded in: `ajv/dist/2020` import, `child.on("error")` spawn handling + grace-timer cancellation, git identity/`HOME` env, `read-tree -m -u` integration (replacing the delete-incapable `checkout-index`), the on-disk verification-mutation rescan, required `forbiddenScope`, repo-identity `checkoutPath` threading, the host-decision gate, value-based redaction, `win32` diagnostics-only services, the explicit macOS-only P0-A scope reduction, esbuild `createRequire`/`.mjs`, and full `FAILURE_PRECEDENCE` test coverage. See **C7** for the cross-cutting decisions.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-14-p0-runtime-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. Given the cross-vendor implementer lanes available (`codex-implementer`, `opencode-implementer`, `pi-implementer`, `pythinker-implementer`), route each task's implementation to a lane and keep acceptance with the architect.

**2. Inline Execution** — execute tasks in this session using superpowers:executing-plans, batching with checkpoints for review.

**Before starting execution:** run `npm install` (Task 1), then confirm two verify-at-implementation points flagged inline: (1) the resolved `@modelcontextprotocol/sdk` version's `registerTool` `inputSchema` shape (ZodRawShape vs `z.object`); (2) the `git read-tree -m -u <base> <candidate>` behavior against the installed Git (adds/mods/deletions applied atomically; aborts before mutation on a dirty tree — the Task 19 deletion + stale-base tests are the gate).

