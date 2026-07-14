# Domain Context

## Revised Verdict

Claude Architect must be a first-class, cross-platform Claude Code plugin whose trusted core runtime supports native macOS, native Linux, and native Windows from P0. WSL is a Linux execution environment and is not the implementation of native Windows support.

The protocol and orchestrator are universal; individual Producers are conditionally available. The plugin must always load, expose `/claude-architect:delegate`, inspect installed Producers, and return useful diagnostics on every supported Host platform. A Producer is eligible only where its CLI and the confinement required by the requested Lane are available.

The normal plugin path is a structured call from the Delegate Skill to a plugin-bundled MCP runtime. It must not depend on shell-generated command strings, the Bash tool's `PATH`, Bash shebangs, Unix file modes, or Unix-only process semantics.

## Ubiquitous Language

### Host

The environment that coordinates delegated work. The initial architecture has one Host: Claude Code. Claude Architect is a plugin running within that Host.

### Lane

The kind of work being delegated, such as implementation, review, investigation, testing, or planning. A Lane does not identify which external runtime performs the work.

### Producer

An external CLI runtime that performs delegated work. Codex, OpenCode, Pi, and Pythinker are Producers.

### Delegation Spec

Machine-readable intent, constraints, success criteria, verification, execution policy, and expected output for delegated work. A Delegation Spec must be valid before routing selects a Producer.

### Delegation Attempt

One execution of a valid Delegation Spec by a selected Producer under an explicit policy. An editing Delegation Attempt runs in its own isolated worktree.

### Attempt Runtime

The Producer-neutral module that executes a Delegation Attempt. It owns worktree allocation, environment construction, process supervision, timeout and cancellation, artifact collection, failure classification, and result verification orchestration.

### Producer Adapter

An adapter at the Producer seam. It owns Producer discovery, capability observations, invocation construction, and normalization of native events and errors. It does not choose the canonical Failure Classification.

### Attempt Result

The canonical, machine-readable outcome of a Delegation Attempt. It records artifacts, evidence, execution facts, and failure classification. An Attempt Result is a candidate outcome, not an accepted result.

### Host Decision

Claude's decision after reviewing a verified Candidate Artifact and its evidence. A Host Decision is `accepted`, `rejected`, or `revision-requested`.

### Integration Result

The outcome of applying an accepted Candidate Artifact to the main checkout through Controlled Integration. An Integration Result is `applied`, `conflicted`, or `aborted`.

### Acceptance Verification

Independent executable verification of an Attempt Result and its candidate artifacts. Acceptance Verification checks declared tests, changed paths, worktree state, command outcomes, and scope before controlled integration.

### Candidate Artifact

Output produced by an untrusted Producer, such as a patch, report, or review. For implementation work it is a base-bound binary patch plus a manifest of paths, modes, and content hashes. A Candidate Artifact cannot modify the main checkout until Acceptance Verification succeeds.

### Capability Report

A machine-readable observation of a Producer's availability, version, authentication state, supported execution modes, sandbox support, structured-output support, and other routing-relevant facts. Facts that cannot be observed safely are `unknown`, not inferred.

### Run Manifest

The reproducibility record for a Delegation Attempt. It identifies the base commit, Producer version and model, effective configuration policy, repository instruction paths and hashes, prompt hash, execution policy, and runtime version.

### Routing Policy

Host-owned rules that order Producer preferences and required capabilities. Routing Policy is distinct from the Producer registry, which contains machine facts rather than preferences.

### Failure Classification

The canonical reason a Delegation Attempt did not produce a verified Candidate Artifact. Native Producer errors are translated into this shared vocabulary.

### Sandbox Backend

An internal adapter used by the Attempt Runtime to enforce the execution policy on a supported operating system. Producer-native confinement may satisfy the policy; otherwise a configured operating-system mechanism must do so.

### Platform Services

The operating-system seam for executable resolution, supervised process creation, process-tree cancellation, checkout locking, secure temporary directories, and path canonicalization. P0 has distinct POSIX and native Windows implementations.

### Controlled Integration

A Host-owned action that revalidates a verified Candidate Artifact against the unchanged base commit and clean main checkout before applying it. Controlled Integration is outside the Attempt Runtime.

## Architectural Decisions In Force

### Core Model

- Claude Code is the only Host in the initial architecture.
- Lanes and Producers are independent dimensions.
- The Attempt Runtime is the primary deep module; Producer Adapters contain only Producer-specific variation.
- Routing occurs only after Delegation Spec validation and capability resolution.
- Producers are untrusted in the sense that their output, claims, path discipline, and failure reporting may be incorrect. P0 does not claim protection from a malicious installed CLI or kernel-level sandbox escape.
- A Producer is user-authorized to read repository content required by the Delegation Spec and to use network access needed for its model. P0 does not promise confidentiality from the selected Producer.
- Successful exit and self-reported verification do not imply acceptance.
- Agent prose provides guidance, not security enforcement.
- Host location and Producer discovery are separate modules. Host location finds packaged plugin assets; Producer discovery returns Capability Reports.
- The Producer registry contains machine facts and capability declarations only. Routing Policy remains Host-owned.
- Confinement policy belongs to the Attempt Runtime. Producer Adapters expose native capabilities and invocation facts but do not define the policy.

### P0 Scope

- The first trusted Attempt Runtime supports native macOS, native Linux, and native Windows. WSL 2 is treated as Linux and does not satisfy the native Windows requirement.
- The initial target matrix is macOS arm64 and x64; Linux x64 and arm64 on glibc and musl; and Windows x64 and arm64. Any reduction before release must be explicit in the published support matrix and cannot reduce native Windows to WSL-only support.
- The P0 Attempt Runtime supports the implementation Lane only. Other Lanes may reuse the protocol later but do not broaden the first trusted editing path.
- P0 includes shared-contract adapters for Codex, OpenCode, Pi, and Pythinker. Each adapter publishes a tested platform-capability matrix and reports honest unavailability when its Producer cannot satisfy the requested Lane on the current platform.
- Universal plugin availability does not imply universal Producer availability. The plugin remains operable and diagnostic when no Producer is eligible.
- The P0 Attempt Runtime is a TypeScript/Node executable and explicitly requires Node.js 22 or later, in addition to Claude Code, Git, and at least one eligible Producer CLI. Claude Architect must not be described as zero-dependency while this prerequisite remains.
- A small native helper is permitted where native Windows process-tree ownership requires it. Shell scripts may support repository development and CI but no shipped runtime feature may require them.
- P0 allows one active editing Delegation Attempt per base checkout. Parallel candidate generation and queueing are deferred.
- P0 requires a clean main checkout before an editing Delegation Attempt starts. Dirty-state snapshotting is deferred.

### Plugin Surface And Invocation

- The marketplace-installed public command is the namespaced Skill `/claude-architect:delegate`. Documentation, examples, and screenshots must not present plain `/delegate` as the normal plugin command.
- The Delegate Skill has Main Claude write a validated Delegation Spec and invoke the Claude Architect runtime through a structured plugin-bundled MCP tool.
- The plugin MCP server owns schema validation, capability probing, routing, worktree management, process supervision, artifact collection, recovery, and Acceptance Verification. It returns a structured verified-candidate result for Main Claude's review.
- Plugin configuration resolves packaged assets through `${CLAUDE_PLUGIN_ROOT}`. Runtime access must not depend on a bare command being added to the Bash tool's `PATH`.
- The shipped path must not depend on Bash versus PowerShell, Bash shebangs, `chmod +x`, `.sh` launchers, Unix-only path syntax, or Claude composing a shell command string.
- A development CLI may expose `claude-architect doctor`, `claude-architect probe`, `claude-architect run --spec spec.json`, and `claude-architect recover`, but it is not the normal `/claude-architect:delegate` transport.
- The plugin-bundled advisor is strictly read-only and uses an explicit `Read, Grep, Glob` tool allowlist. It does not receive Bash, Write, or Edit. Required Git observations are exposed through dedicated read-only operations such as status, diff, log, and changed-file queries.

The preferred shipped layout is:

```text
claude-architect/
|-- .claude-plugin/
|     `-- plugin.json
|-- skills/
|     `-- delegate/
|           `-- SKILL.md
|-- agents/
|     `-- advisor.md
|-- .mcp.json
|-- runtime/
|     |-- server.js
|     `-- schemas/
`-- native/
      `-- platform helpers
```

### Runtime Components

```text
Claude Code
|
|-- /claude-architect:delegate
|     Main Claude writes the Delegation Spec
|
|-- claude-architect:advisor
|     Strictly read-only Claude subagent
|
`-- Claude Architect MCP server
      |-- SpecValidator
      |-- ProducerRegistry
      |-- RoutingPolicy
      |-- CapabilityProbe
      |-- AttemptRuntime
      |     |-- WorktreeManager
      |     |-- EnvironmentPolicy
      |     |-- PlatformServices
      |     |     |-- PosixPlatformServices
      |     |     `-- WindowsPlatformServices
      |     |-- ProcessSupervisor
      |     |-- ArtifactStore
      |     `-- RecoveryManager
      |-- ProducerAdapters
      |     |-- CodexAdapter
      |     |-- OpenCodeAdapter
      |     |-- PiAdapter
      |     `-- PythinkerAdapter
      `-- AcceptanceVerifier
```

### Specification And Routing

- Delegation Specs and Attempt Results are versioned, machine-readable data validated against schemas.
- A Delegation Spec must identify its objective, relevant context, positive write allowlist, forbidden scope, success criteria, verification commands, execution mode, timeout, Producer preferences, and expected output.
- Repository-wide write scope must be explicit rather than implied by an absent allowlist.
- The Host supplies an ordered Producer preference list. The Attempt Runtime filters it by required capabilities and selects the first available Producer; learned quality, speed, and cost scoring are deferred.
- Local availability and version probing runs before each P0 attempt, has no intentional side effects, and is not cached across attempts.
- Authentication, model availability, and remote capabilities are reported as `unknown` unless the Producer offers a documented local, non-mutating probe. P0 does not contact a remote service merely to complete a Capability Report.
- Capability Reports identify the operating system, architecture, environment type such as native Windows or WSL, resolved executable form, and Lane-specific eligibility. Unsupported platforms are reported as `available: false` with a machine-readable reason such as `unsupported-platform`.
- Native Windows and WSL capabilities are probed and certified separately. A Producer's WSL support is not evidence of native Windows support.
- P0 may select a fallback Producer only when capability probing reports pre-launch unavailability. After a Producer process starts, every failure is returned honestly and retry requires a new Host decision and Delegation Attempt.

### Worktree And Write Policy

- Each editing Delegation Attempt receives a separate worktree created from the recorded base commit.
- The Attempt Runtime never modifies the main checkout. After Acceptance Verification, it returns a verified Candidate Artifact for Controlled Integration by the Host.
- Acceptance Verification rejects every tracked or untracked non-ignored changed path outside the positive write allowlist.
- P0 rejects new or modified symbolic links rather than attempting to prove that their targets remain confined.
- The Attempt Runtime inventories tracked, untracked, and ignored worktree paths before and after Producer execution and verification. Ignored artifacts are recorded but are not included in the candidate patch.
- The Attempt Runtime verifies that the main checkout's commit and clean state still match the recorded base before returning `verified-candidate`. A changed base preserves the Candidate Artifact but yields `verification-failed`.
- The Candidate Artifact records the base commit and contains a complete binary-capable patch for allowed tracked and untracked non-ignored changes, including file modes and deletions, plus content hashes in its manifest.
- The Candidate Artifact is frozen after Producer execution and structural inspection, before project verification begins.
- Controlled Integration rechecks the base commit, clean state, patch hash, and changed-path manifest immediately before applying the Candidate Artifact. A failed recheck leaves the main checkout unchanged.

### Producer Configuration And Environment

- The default Producer behavior policy is controlled configuration plus repository guidance. User-global behavior configuration is excluded.
- Producer credentials may come from documented credential stores or explicitly allowlisted environment variables without enabling unrelated user-global behavior configuration.
- Relevant repository instruction paths and content hashes are recorded in the Run Manifest.
- Producer subprocesses receive a minimal common environment plus variables allowlisted by the selected Producer Adapter and explicit Host-approved additions. The Host environment is not inherited wholesale.
- Sensitive environment values and known credential forms are redacted before any event, log, or result is persisted.
- The Attempt Runtime requires a Sandbox Backend or documented Producer-native confinement that satisfies the write policy. It fails closed when neither is available.
- Worktree checks detect policy violations but do not substitute for process confinement.
- P0 denies nested delegation unconditionally. The runtime sets `CLAUDE_ARCHITECT_DELEGATED=1` and refuses to start when that marker is already present.

### Process Supervision

- The Process Supervisor owns timeout validation and enforcement, Host cancellation, stream draining, output limits, exit normalization, and cleanup. Platform Services owns operating-system-specific executable and process-tree mechanics.
- The Attempt Runtime, not the Producer Adapter, selects and configures the Sandbox Backend from the execution policy and observed capabilities.
- Generic cancellation requests cooperative cancellation, waits for a bounded grace period, and then terminates the complete process tree. It does not require identical signal sequences on every operating system.
- `PosixPlatformServices` uses process groups, POSIX cancellation and termination signals, POSIX file modes, and Unix executable lookup.
- `WindowsPlatformServices` owns the process tree with a Windows Job Object or equivalent reliable mechanism, supports cooperative cancellation where available, forcibly terminates the complete tree when required, and implements Windows file locking, `PATHEXT` resolution, environment-key normalization, and drive, UNC, Unicode, and case-insensitive path handling.
- Calling `child.kill()` only on the direct Windows child does not satisfy process-tree supervision.
- Producer invocation uses executable and argument arrays. The Attempt Runtime does not use `eval`, interpolate untrusted values into command strings, or use `shell: true` with untrusted values.
- Windows executable resolution prefers a native `.exe` or `.com`. For an npm-installed CLI, it next resolves the underlying JavaScript entry point and invokes it as `node.exe <entrypoint> <args...>`.
- A trusted, fully resolved `.cmd` or `.bat` wrapper may be invoked through `cmd.exe /d /s /c` only when direct executable or Node entry-point resolution is unavailable. User-controlled values remain separate and are never concatenated into the command string.
- Windows discovery understands `.exe`, `.com`, `.cmd`, `.bat`, `.ps1`, `PATHEXT`, per-user npm locations, spaces and Unicode in paths, and case-insensitive `Path`/`PATH` keys. Environment construction emits one canonical path key rather than competing variants.
- Every Delegation Spec has a positive wall-clock timeout bounded by a runtime maximum. Cost-budget enforcement is deferred until Producers expose reliable usage facts.
- Stdout and stderr are always drained to prevent deadlock. Persisted output is bounded and includes explicit truncation facts while process supervision continues draining excess bytes.
- Network access follows the Producer Adapter's declared execution requirements. Acceptance Verification runs without network access unless the Delegation Spec explicitly authorizes it.

The Platform Services contract is:

```ts
interface PlatformServices {
  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable>;
  spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess>;
  requestCooperativeCancellation(process: SupervisedProcess): Promise<void>;
  terminateProcessTree(process: SupervisedProcess): Promise<void>;
  acquireCheckoutLock(checkout: string): Promise<CheckoutLock>;
  createSecureTempDirectory(): Promise<string>;
  canonicalizePath(path: string): Promise<CanonicalPath>;
}
```

### Result And Failure Policy

- The Attempt Runtime constructs the canonical Attempt Result from observed process facts, normalized Producer events, Candidate Artifacts, and Acceptance Verification evidence. Producer-authored summaries are untrusted fields.
- An Attempt Result records status, summary, changed files, candidate patch, requested and executed verification, command outcomes, unresolved issues, evidence, bounded logs, Producer version and model, duration, session identifier, and Failure Classification.
- Canonical Attempt Result statuses are `unavailable`, `failed`, `cancelled`, and `verified-candidate`.
- `verified-candidate` means Acceptance Verification passed and a verified Candidate Artifact was produced. It does not mean Claude accepted the candidate or that the main checkout was modified.
- `unavailable` means no process started because the selected Producer could not satisfy the requested Lane. Its Failure Classification distinguishes causes such as unsupported platform, missing executable, ineligible capability, or authentication required.
- `failed` covers invalid specification, spawn failure, timeout, sandbox violation, invalid output, Producer failure, and verification failure; the required Failure Classification preserves the precise reason.
- `invalid-output` means the selected Producer Adapter could not normalize required native output or required Producer-authored payload into the adapter event contract. The Producer never constructs the canonical Attempt Result.
- The Attempt Runtime owns Failure Classification precedence: invalid specification; pre-launch unavailability or authentication requirement; spawn failure; cancellation or timeout according to the initiating runtime event; sandbox violation; invalid output; Producer failure; verification failure. If no failure applies and Acceptance Verification passes, the status is `verified-candidate`.
- `authentication-required` never triggers automatic fallback. A zero exit code does not override invalid output, scope violations, or failed verification.
- A timeout, cancellation, Producer failure, invalid output, or verification failure never triggers automatic fallback in P0.

The lifecycle states remain distinct:

```text
Producer completed
        !=
Candidate verified: AttemptResult = verified-candidate
        !=
Claude accepted: HostDecision = accepted
        !=
Changes integrated: IntegrationResult = applied
```

### Acceptance Verification

- Acceptance Verification executes only commands authorized by the Host in the validated Delegation Spec. Producer-suggested commands may be recorded as evidence but are not executed automatically.
- Verification commands are structured executable-and-argument data, not shell command strings.
- Acceptance Verification has two stages. A packaged structural verifier uses trusted runtime and Git executables without importing candidate code; project verification then runs Host-authorized commands as untrusted code under the same confinement and minimal-environment policy.
- Project verification runs against a disposable materialization of the frozen Candidate Artifact, not the artifact-producing worktree.
- After each project verification command, the structural verifier recomputes the complete tracked and non-ignored manifest: paths, file types, modes, and content hashes. Any divergence from the frozen Candidate Artifact yields `verification-failed`; verification mutations never enter the Candidate Artifact.
- The Run Manifest records the packaged verifier version and content hash.
- Acceptance Verification independently reruns declared checks, records real exit codes, compares all changed paths with allowed scope, detects empty success, and inspects tracked, untracked, and ignored files.
- Project verification success is evidence that Host-authorized checks exited successfully; it is not a claim that candidate-controlled test code is trustworthy.
- If code changes are required, an empty candidate patch cannot yield `verified-candidate`.
- Producer claims such as "tests pass" are evidence only and never substitute for verifier results.

### Retention And Recovery

- Attempt finalization archives bounded redacted logs, the Run Manifest, Attempt Result, and candidate patch, then deletes the attempt worktree after every terminal Attempt Result.
- Crash recovery detects stale runs, terminates surviving process trees through Platform Services, archives recoverable evidence, releases the checkout lock, and removes stale worktrees.
- Archived artifacts have configurable size and age limits; truncation and cleanup are recorded rather than silent.

### Verification Strategy

- Attempt Runtime tests exercise its interface with fake Producer processes rather than inspecting agent prose.
- Each Producer Adapter has invocation fixtures, Capability Report tests, captured native-event fixtures, and a published platform-capability matrix derived from real tests rather than assumptions.
- Process Supervisor integration tests cover POSIX process-group and Windows process-tree cancellation, timeout escalation, stream saturation, truncation, and orphan cleanup.
- Acceptance Verification tests cover out-of-scope writes, untracked files, symbolic links, empty success, changed base commits, failed commands, and dishonest Producer claims.
- Sandbox Backend tests prove fail-closed selection and policy enforcement separately on each supported operating system.
- Controlled Integration tests cover stale bases, dirty checkouts, artifact tampering, binary files, modes, deletions, and untracked files.
- Acceptance Verification tests prove that commands cannot mutate the frozen Candidate Artifact or cause unverified bytes to reach Controlled Integration.
- Schema compatibility tests protect Delegation Spec and Attempt Result versioning.
- Existing CLI argument behavior tests move behind Producer Adapter interfaces. Prose-presence tests do not serve as executable behavior tests.

## Required Release Gates

Claude Architect must not be described as universal until these gates pass.

### Core Runtime Gates

- Integration tests pass on macOS, Linux, and native Windows for every platform claimed in the support matrix.
- Project, plugin, temporary, and Producer paths containing spaces and Unicode are covered.
- Cooperative cancellation and forced process-tree termination leave no surviving descendants.
- Worktree creation, removal, stale-run recovery, and checkout-lock release are covered.
- Native Windows locked-file behavior is handled and tested.
- Path-scope enforcement is tested with case differences, drive paths, and UNC paths on Windows.
- Producer discovery covers native executables and trusted `.cmd` wrappers.
- Structured event parsing accepts CRLF and LF without changing event semantics.
- Windows environment construction normalizes `Path` and `PATH` safely.
- Main-checkout commit and cleanliness integrity checks pass on all supported operating systems.

### Plugin Integration Gates

- Marketplace installation and update are tested on macOS, Linux, native Windows, and WSL where claimed.
- Plugin cache and installation paths containing spaces are tested.
- `/claude-architect:delegate` is visible and invokable after marketplace installation.
- The runtime is accessible through the plugin MCP configuration without depending on the Bash tool's `PATH`.
- Native Windows is tested both without Git Bash and with Git Bash installed.
- WSL installation is tested and reported as Linux rather than native Windows.
- Updating the plugin while a Delegation Attempt is active has a defined, tested outcome that preserves run evidence and checkout integrity.
- Plugin uninstall has defined, tested retain-data and delete-data behavior for archived run data.
- The advisor's effective tool set is verified to exclude Bash and all mutation tools.

### Producer Adapter Gates

- Codex, OpenCode, Pi, and Pythinker each implement the shared adapter contract even where their Capability Report returns unavailable.
- Each adapter publishes tested values for macOS, Linux, native Windows, and WSL, using states such as `certified`, `tested`, `conditional`, `unsupported`, or `unknown` with a reason.
- Native Windows and WSL results are never merged into one Windows claim.
- Producer availability reflects the tested CLI version, authentication state, requested Lane, structured-output support, and required confinement backend.

The release evidence includes a table in this form, populated only from real test results:

```text
Producer    macOS       Linux       Windows native    WSL
Codex       <result>    <result>    <result>          <result>
OpenCode    <result>    <result>    <result>          <result>
Pi          <result>    <result>    <result>          <result>
Pythinker   <result>    <result>    <result>          <result>
```

## Product Description

Claude Architect is a cross-platform Claude Code plugin for macOS, Linux, and Windows. It adds `/claude-architect:delegate`, which lets Claude route well-scoped implementation subtasks to supported installations of Codex, OpenCode, Pi, or Pythinker.

Claude remains the architect. It creates a versioned Delegation Spec, selects an available Producer based on required capabilities, and runs the task inside an isolated Git worktree. The plugin supervises the delegated process, enforces timeouts and scope constraints, records a reproducible Run Manifest, and independently verifies the resulting diff and authorized checks.

External agents are untrusted Producers. Their output is returned as a verified Candidate Artifact, not automatically accepted work. Claude reviews the diff and verification evidence before deciding whether the changes should be integrated.

Claude Architect also includes a strictly read-only Claude advisor, cross-platform process supervision, crash recovery, bounded and redacted run logging, and Producer Adapters for Codex, OpenCode, Pi, and Pythinker. Producer availability depends on the operating system, installed CLI version, authentication state, requested Lane, and required execution capabilities.

The central architectural rule is: make the protocol universal, make native Windows part of P0, and allow individual Producers to be conditionally available. Plugin availability must not depend on every external CLI being equally portable.

## Reference Sources

- [Claude Code advanced setup](https://code.claude.com/docs/en/setup) defines supported installation environments and native Windows behavior.
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference) defines plugin MCP configuration, `${CLAUDE_PLUGIN_ROOT}`, agent fields, and path behavior.
- [Claude Code plugin guide](https://code.claude.com/docs/en/plugins) defines namespaced plugin Skills, plugin structure, and the Bash-specific `bin/` `PATH` behavior.
- [Node.js child process documentation](https://nodejs.org/api/child_process.html) defines cross-platform spawn, detached-process, signal, Windows wrapper, and case-insensitive environment behavior.
- [OpenCode documentation](https://opencode.ai/docs/) documents native Windows installation options and its WSL recommendation.

## Deferred Decisions

- Bundling the TypeScript runtime into standalone platform executables and the associated artifact selection, signing, and release process.
- Dirty-checkout baseline snapshots.
- Read-only and non-implementation Lanes.
- Parallel attempts, queueing, and integration-race policy.
- Learned quality, speed, and cost routing.
- Automatic retry after a Producer process starts.
- Cost-budget enforcement and historical Producer scoring.
- Bounded nested delegation.
- Resumable attempts.
