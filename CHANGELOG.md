# Changelog

All notable changes to Claude Architect are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.27.0] - 2026-07-21

### Added

- Added the controller-owned autopilot workflow and its three narrow MCP tools:
  `autopilotStart`, read-only `autopilotStatus`, and `autopilotResume`. A
  versioned Autopilot Spec drives ordered fresh-context tasks, policy-gated
  promotion to a workflow-owned feature branch, cumulative whole-branch review,
  exact-head GitHub shipping, configured required-check polling, PR readiness,
  cleanup, and four durable terminal classifications. Autopilot is autonomous
  only through a pull request ready for human review; it never automatically
  merges, deploys, releases, or deletes the remote feature branch.
- Added workflow crash recovery for lifetime leases, bootstrap orphans, intent
  journals, branch/worktree ownership, interrupted cleanup, and byte-idempotent
  resume/finalize/dispose dispositions. Ambiguous state fails closed as
  `human-decision-required`; a phase string alone is never completion evidence.
- Extended `doctor` with stable autopilot lock, worktree, branch, promotion,
  shipping-recovery, and malformed-state diagnostics using bounded no-follow,
  read-only scans.

### Changed

- **Breaking CandidateDecision v2 semantics:** an accepted decision now records
  an explicit authority. A human may record any Candidate Decision after
  reviewing evidence. The trusted Promotion module may record `accepted` with
  authority `autopilot-policy` only from a current hash-bound Autopilot
  Eligibility record proving all required review, verification, advisor,
  artifact, and base gates. Producers, reviewers, advisors, skills, and MCP
  callers cannot construct or waive eligibility. Existing v1 decision records
  are migration provenance only and are not silently upgraded to
  `autopilot-policy`; callers must rerun under protocol 2.0.0/current evidence or
  use the explicit human-directed manual lifecycle.
- The delegate skill protocol marker now matches MCP protocol `2.0.0` and drives
  the AutopilotController lifecycle by default. The manual candidate lifecycle
  is used only when a human explicitly chooses it.
- Release/runtime/plugin/marketplace version surfaces advance to `0.27.0`.

### Fixed

- Bound required-check observations to the exact expected head commit and
  bracketed GitHub check retrieval with stable PR-identity observations, so
  stale CI for an earlier head cannot mark a PR ready.
- Preserved mid-phase cancellation as the durable terminal `cancelled`
  classification, with no post-cancellation push, PR creation, or mark-ready
  mutation.
- Rejected changed paths that collide under Unicode-aware case folding both
  when constructing changed-path manifests and during independent structural
  verification, including collisions with untouched candidate-tree paths.

## [0.26.0] - 2026-07-19

### Changed

- Toolchain to latest: TypeScript 7.0.2 (stable native Go compiler), Vitest 4,
  esbuild 0.28. `zod` deliberately stays on latest v3 while the runtime uses
  `@modelcontextprotocol/sdk` v1.x (which pins `zod ^3`); see the dependency
  version policy in `AGENTS.md`.

## [0.25.0] - 2026-07-19

### Removed

- Removed the packaged legacy implementation/advisor lanes and their compatibility fallbacks from the documented workflow. All supported Producers now use the validated MCP lifecycle, fail closed when edit eligibility or confinement cannot be proven, and recovery no longer accepts PID-only checkout-lock ownership.

## [0.24.0] - 2026-07-19

### Added

- Optional top-level and per-slice `allowedTestDeletions` globs let architects
  authorize intentional test-file removals while preserving the pipeline's
  fail-closed guard and recording each authorized deletion in verification evidence.

## [0.23.0] - 2026-07-19

### Fixed

- Cleanup convergence when a delegating repository is deleted. Previously a
  vanished `repoRoot` made `canonicalizePath` throw: normal-path prune caught it
  and retained the run forever (its bytes never reclaimed, so `maxBytes`/`maxAge`
  could not converge), and — more seriously — a repo-gone *pending* cleanup intent
  made `validateRepositoryRoot` throw outside the per-record guard in
  `replayInterruptedPrunes`, aborting the entire crash-recovery pass on every run
  (a permanent block). Both paths now reconcile a repository-absent run without
  Git: prune reclaims the archive directly (no lease, no ref cleanup — the
  candidate and backup refs died with the repository, and no live checkout can
  integrate from a vanished repository), and recovery detects the absent
  repository before validation and completes or rolls back the archive by disk
  state, converging instead of aborting.

## [0.22.0] - 2026-07-19

### Fixed

- Crash-recovery cleanup journal: close a cross-process race where recovery's
  torn-tail truncation could erase a cleanup intent a concurrent process had just
  appended and fsynced. All journal appends (prune and recovery) and the torn-tail
  repair now hold a new state-dir-scoped cross-process mutex
  (`acquireCleanupJournalLock`), and recovery reads and repairs the journal as one
  critical section under that mutex. The mutex is a leaf lock — never held while
  acquiring the checkout lease or recovery lock, so ordering stays deadlock-free —
  and is reclaimed like any other lock when its owner dies.

## [0.21.0] - 2026-07-19

### Added

- Sliced delegation: a spec may carry a top-level `slices` array that decomposes
  the task into ordered, independently testable steps. Each slice is a scoped
  mini-spec with its own `writeAllowlist` (a subset of the spec's),
  `forbiddenScope`, `successCriteria`, and required `verification`, and runs
  fresh with no context from prior slices. A deterministic wayfinder routes each
  completed slice advance/repair/halt from its verification result alone. Review
  and the advisor judge the composed candidate over the whole slice branch at the
  end; per-slice review is opt-in via `review.perSlice: true`. A mid-run halt
  after at least one slice has advanced yields a partial `human-decision-required`
  candidate — the promoted advanced-slice branch, which the human may accept,
  reject, or revise — carrying `haltedSliceIndex` and each slice's route in
  `slices`; a halt on the first slice with nothing advanced is reported `failed`
  with the slice evidence retained.

### Changed

- The `delegatePipeline` result now exposes `slices` (per-slice routes) and
  `haltedSliceIndex` on the MCP wire. The MCP tool protocol advances 1.2.0 to
  1.3.0 (additive).

## [0.20.0] - 2026-07-18

### Added

- Fresh-context increment loop: `runPipeline` can drive multiple bounded
  implementation increments, each in a fresh isolated worktree working from the
  prior candidate toward a structured completion report, with every increment
  independently frozen and verified and recorded in the pipeline result.

### Changed

- Candidate lifecycle MCP tools (`reviewCandidate`, `decideCandidate`,
  `integrateCandidate`) now require an explicit `checkoutPath` whose canonical
  git-common-dir identity must equal the run's repository, and fail closed with
  `run-checkout-mismatch` otherwise. This closes a cross-project authority hole
  in the shared plugin state directory where any session could review, reject,
  accept, or integrate another project's candidate by run id alone. The MCP tool
  protocol advances 1.1.0 to 1.2.0; `decideCandidate` now records its decision
  under the cross-process checkout lock and `ArtifactStore.writeDecision` is an
  atomic compare-and-set that rejects contradictory decisions.
- Verification mutation scanning now permits writes to git-ignored paths by
  default. Because verification runs in a disposable worktree, git-ignored
  artifacts (build caches, virtualenvs, `__pycache__`, `.pytest_cache`) can
  never reach the frozen candidate tree or the primary checkout, so they no
  longer fail a command. This removes the recurring false-positive where a
  `uv`/`pytest` verification command was marked `verification-mutated` despite
  exiting 0. Strict all-mutations scanning remains available per command via
  `allowedMutations: "none"`; tracked-file, untracked non-ignored, index, and
  HEAD changes are still detected regardless.

### Fixed

- A failed implement phase now surfaces the attempt's own failure
  classification (for example `verification-failure` when a candidate is
  invalidated by an external base change) instead of flattening every
  non-verified implement phase to `producer-failure`, so a blameless checkout
  drift is triageable from `failure` alone.
- Attempts that end in a timeout or cancellation without a frozen candidate now
  archive a bounded, redacted worktree status+diff snapshot into evidence
  (`evidence.worktreeSnapshot`) before the disposable worktree is removed,
  preserving salvage evidence of finished-but-discarded producer work.
- The delegate skill now matches the closed Delegation Spec schema, documents
  exact command/network/timeout and Producer override fields, supports
  reviewer-only `review.focus`, and explains the clean-checkout precondition.
- Repository preflight now accepts tracked relative symlinks to direct contained
  regular files while continuing to reject absolute, symlink-chained, directory,
  external, broken, untracked, and Git-metadata links in write scope.
- The legacy Codex wrapper now owns read-only versus edit sandbox selection and
  physical cwd binding, so implementation lanes receive `workspace-write`
  without permitting caller scope overrides.

## [0.19.0] - 2026-07-17

Deferred-work remediation release: the confinement and reproducibility
redesigns deferred from the 0.16.0 scout pass, plus the remaining
robustness and hygiene items. Every fix was driven through the `delegate`
MCP lifecycle (Codex GPT-5.6 Sol) and independently verified.

### Security

- The pipeline fixer no longer receives the shared Git object database as a
  writable sandbox root. Fixer object writes go to a per-run private object
  directory (with the shared store as a read-only alternate), and trusted
  promotion imports exactly the promoted commit's objects via bounded
  `pack-objects` plumbing, verifying shared-store reachability without
  alternates before publishing the anchor; import failure fails closed.
- Aux verification worktrees no longer receive a live writable
  `node_modules` symlink/junction into the primary checkout. Matching
  lockfile sets produce a copy-on-write clone (APFS clonefile on macOS,
  reflink on Linux); platforms or filesystems without CoW fail closed to a
  new `skipped-cow-unsupported` dependency-link state instead of a
  writable link. Windows and non-reflink Linux therefore no longer inherit
  dependencies into aux worktrees; dependent verification commands fail
  visibly as environment defects.
- Checkout-lock release now verifies the lock file still records the
  releasing holder's pid and process token before deleting it, closing the
  ABA race where a stale former holder could remove a legitimately
  reclaimed and re-acquired lock.

### Fixed

- Run manifests written in production now record real reproducibility
  provenance: repository instruction files (`AGENTS.md`, `CLAUDE.md`)
  hashed from the committed base tree and the installed verifier bytes at
  the current runtime version. The silent `pending`/empty defaults are
  removed; unresolvable verifier bytes fail the attempt closed.
- Candidate freezing rejects any truncated Git output instead of
  publishing an incomplete review patch or changed-path listing.
- `verifyRunManifest` treats the archived `protocolVersion` as provenance
  with same-major compatibility, so protocol upgrades keep existing
  archives reviewable; different-major or malformed values are rejected
  with both versions named.

### Changed

- The `.opencode` lane mirrors now carry the full operating contract
  (foreground-only execution, bounded stall relaunch, worktree isolation,
  Git-state prohibitions, action-first preamble, failure-classification
  vocabulary), and stall handling is normalized everywhere to at most one
  relaunch — two producer invocations total — with the lane's outer
  timeout authoritative.
- Lane-contract tests reject negated normative text and permissive
  background-wait mentions, and the failure-precedence end-to-end test
  pins an explicit eleven-classification literal instead of comparing the
  production constant against itself.

## [0.18.0] - 2026-07-17

Second trust-hardening release from the same dogfood scouting pass, continuing
where 0.17.0 left off. Every fix was driven through the `delegate` /
`delegatePipeline` MCP lifecycle and independently verified.

### Changed

- Protocol contract advanced to `1.1.0` (the `environment-defect` classification
  and per-command `expectBaselineFailure` were added without a marker bump in
  0.17.x). `protocolVersion` is now a required strict literal on `delegate` /
  `delegatePipeline`, unknown MCP input keys are rejected, and a mismatch yields a
  diagnostic naming both versions.

### Fixed

- Pipeline fix rounds now validate fixer commit provenance (worktree HEAD match,
  descent from the reviewed candidate, disposition OIDs bound to real in-lineage
  objects), route the final verification through the AcceptanceVerifier so
  per-command logs are archived, and reject a zero-executed (all-skipped)
  verification instead of passing it.
- Non-Codex fixer roles now run inside a write-confined Seatbelt profile and fail
  closed with `sandbox-violation` when no usable confinement backend exists.
- Schema boundaries are closed (`additionalProperties: false`), the edit timeout
  floor is encoded in the delegation-spec schema with the env override honored
  only under test, run manifests are validated on write, archived
  `runtimeVersion` is treated as provenance instead of an upgrade-bricking
  equality gate, 64-hex SHA-256 commit OIDs are accepted, and
  `expectBaselineFailure` is per verification command so one expected-failing
  reproducer no longer suppresses unrelated baseline failures.
- Isolation scripts escalate a timed-out process tree with `timeout
  --kill-after` (mapping exit 137 to the timeout result), the Codex wrapper
  rejects sandbox-bypass and scope-expanding caller flags (including attached
  short-option forms), and runtime `git` invocations are insulated from host
  global/system/local/worktree config, hooks, fsmonitor, attributes, and content
  filters (failing closed on a corrupting filter-driver name).
- Persisted pipeline artifacts are redacted, doctor output no longer leaks
  absolute home paths, and baseline/verify auxiliary worktrees use
  run-id-derived names so crash recovery can reclaim them.
- Structural verification rejects gitlink (mode 160000) tree entries and enforces
  `forbiddenScope` for nested-repository paths; environment secret discovery now
  covers `DATABASE_URL`, `*_PAT`, `*_COOKIE`, and `*_DSN`; the verification
  mutation scan detects skip-worktree/assume-unchanged index bits that would hide
  a mutation; and Linux WSL detection fails closed on an ambiguous probe.
- Capability probes treat a timed-out or signal-terminated `--version` run as
  probe-failed, and producer routing screens out unavailable producers and those
  with no resolved executable.

### Known limitations

- Deferred to a later release: mandatory populated `packagedVerifier` /
  `repositoryInstructions` (fail-closed reproducibility provenance), the fixer
  private object store and read-only dependency mount (write-confinement
  redesign), portable candidate-patch handling, and the checkout-lock ABA guard.

## [0.17.0] - 2026-07-17

Trust-hardening release from a six-agent dogfood scouting pass (Codex GPT-5.6
Sol) that surfaced a large finding set across the runtime, pipeline, verifier,
and protocol layers. Every fix in this release was itself driven through the
`delegate`/`delegatePipeline` MCP lifecycle and independently verified.

### Fixed

- Candidate promotion: when a `delegatePipeline` fix round changes bytes, the
  runtime now promotes the fixer's final tree into a canonical single-parent
  candidate (re-frozen artifact, re-pointed anchor, re-archived result and
  manifest via a bounded `ArtifactStore` promotion that fails closed after a
  decision). Previously review, decision, and integration operated on the
  pre-fix tree and silently dropped the reviewed fix.
- Linked-worktree writable-root pointers are validated (plain-file `.git`,
  realpath'd containment under the common gitdir's `worktrees/`, plain objects
  directory); a tampered or malformed pointer makes the fixer fail closed with
  `sandbox-violation` instead of crashing or running unconfined.
- Dependency inheritance compares the full recognized lockfile set (not just the
  first) and refuses to inherit on any divergence; the recorded `dependencyLink`
  is surfaced in acceptance evidence.
- Baseline verification threads cancellation (a cancelled baseline yields
  `cancelled`, not `environment-defect`), detects command-induced worktree
  mutations, and reserves `environment-defect` for a completed baseline report
  with a failed command — operational errors now propagate as runtime errors.
- The cross-process checkout lock is acquired before repository preconditions and
  baseline verification (released on every path), and a verification command
  `cwd` that is absolute or escapes the checkout is rejected as
  `invalid-specification` up front.
- The review pipeline requires a clean final review before decision-ready: a fix
  applied on the final round without re-review now requires a human decision.

### Known limitations

- Fixer private object-store isolation and read-only dependency mounting (full
  prevention of writes to the shared object DB / primary `node_modules`) are
  deferred as a dedicated write-confinement change; lockfile-divergence skipping
  reduces the dependency exposure in the interim.

## [0.16.0] - 2026-07-16

Hardening release from a full-day dogfooding session that surfaced eleven
delegation-lane and runtime defects; every fix in this release was itself
implemented through `delegatePipeline`.

### Added

- Pre-dispatch verification baseline: the runtime now runs every spec
  verification command against clean HEAD in a disposable worktree before
  probing producers; unexpected failures stop the attempt with the new
  `environment-defect` classification (distinct from `verification-failure`),
  and `expectBaselineFailure: true` opts intentional bug-reproducer specs out.
  Read-only specs skip the baseline with explicit evidence.
- Clean-room dependency inheritance: verification and baseline worktrees
  symlink `node_modules` from the primary checkout when the lockfile is
  byte-identical, recorded as `dependencyLink` evidence — dependency-requiring
  verification commands (`npx tsc`, `vitest`) no longer fail falsely.
- Fixer commit capability: fix-round producers receive the linked worktree's
  private gitdir and shared object database as sandbox writable roots, so a
  `git commit` inside the sandbox succeeds instead of every fix round ending
  `blocked` on a denied `index.lock` (refs and config stay read-only).
- Action-first edit prompts: `CODEX_EDIT_ACTION_PREAMBLE` is prepended to all
  non-read-only codex prompts, forbidding rule/skill-file ingestion and
  plan-only zero-edit exits; the delegate skill requires distilled constraints
  in `context`.
- Edit timeout floor: `RUNTIME_MIN_EDIT_TIMEOUT_MS` (10 minutes) — edit-mode
  specs below it are rejected, not clamped; the isolated codex runner defaults
  `CODEX_TIMEOUT_SECONDS` to 600.
- Codex lane failure classification: reports carry `FAILURE CLASSIFICATION`
  (`sandbox-attributable | real | mixed | unresolved | not-applicable`) with a
  per-gate basis; a failing gate may be reported real only when the wrapper's
  outside-sandbox rerun also fails.
- Delegate skill gains **Verification preflight** and **Coordinator duties**
  sections (two lanes reporting the same blocker means the architect pauses
  lanes and repairs the environment centrally).

### Fixed

- Implementer lanes could end their turn "waiting" on a background monitor,
  completing with zero work product: all four lanes now mandate one foreground
  blocking Bash call (600000ms), exactly two valid turn endings, and
  PID-rejoin loops with 10-minute stall detection (kill, then one fresh
  relaunch or a concrete blocker report).
- Parallel legacy lanes shared one checkout, and one lane's `git stash` cycle
  destroyed another lane's uncommitted work: worktree isolation is now
  unconditional, tree-wide git-state mutations are forbidden on shared
  checkouts (propagated verbatim into producer prompts), pre-existence checks
  use a disposable worktree, and overlapping `writeAllowlist`s serialize with
  central integration.
- Verification ordering: lint/format gates must precede the final type-check,
  formatters run in non-mutating check mode, and the type-check covers all
  touched typed files including new tests.
- Producers never create commits (sandbox `.git/index.lock` denials are
  expected confinement, classified sandbox-attributable); the 600000ms
  lifetime must be the Bash tool's explicit `timeout` parameter; per-run
  private `mktemp -d` spec directories eliminate cross-lane temp collisions.
- The lane-contract test pins all of the above across both hosts.

## [0.15.0] - 2026-07-16

### Fixed

- **The review pipeline could never execute.** Dogfooding `delegatePipeline` end-to-end against real Codex exposed four stacked defects that each blocked the review/fix/verify roles from running at all; every one had escaped the suite because all pipeline tests used a fake adapter:
  - Read-only roles gated on the *selected producer's* write-confinement backend being OS-kind, but Codex always reports its own producer-native sandbox, so every review failed with `sandbox-violation`.
  - `macos-seatbelt` was still marked `unsupported`; certified darwin/arm64 via the opt-in confinement gate (worktree write permitted, outside write blocked).
  - The read-only Seatbelt profile denied all network, so reviewer/verifier model sessions could not reach the provider API.
  - Wrapping Codex in an outer read-only Seatbelt profile crashed its own sandbox init (`Operation not permitted`); producers with a native sandbox now confine read-only roles themselves via `--sandbox read-only`, and only backend-less producers get the host Seatbelt wrap.
- The Windows CI leg (red since 0.13.0): the Seatbelt profile builder joined paths with platform-dependent `node:path`, emitting backslash subpaths on Windows; switched to `node:path/posix`.

### Added

- Producer watchdog (`runtime/watchdog.mjs`): producers are spawned through a wrapper that polls the MCP server PID and terminates the producer's process group when the server dies, closing the orphaned-producer window.
- Pipeline role outputs are archived per round (`logs/role-<role>-round<N>.log`, redacted) whether or not structured-output parsing succeeds, and parse-failure gate reasons name the exact log reference.
- Reviewer prompts require a per-success-criterion verdict (`met | not-met | cannot-verify`) with cited diff-line evidence and explicit disclosure of anything unverifiable.
- Delegation specs now require a non-empty objective, at least one success criterion, and at least one verification command; the delegate skill documents the acceptance-criteria rules.
- Enabling the OpenCode, Pi, and Pythinker edit lanes on certified darwin/arm64 under Seatbelt confinement.

### Changed

- Pre-push gate (`.githooks/pre-push`): every push runs typecheck and the full suite; main/tag pushes also run the release validator and refuse a tag push while origin/main CI is red. CI workflow moved to least-privilege permissions and current action versions.

## [0.14.0] - 2026-07-16

### Added

- Routing failures now return a per-producer `considered` trail (selected / unknown-producer / authentication-required / ineligible with a reason) in attempt evidence and unresolved issues, so `no-eligible-producer` explains itself.
- Delegation-spec enum validation errors list the allowed values (e.g. `verification[].network` reports `allowed values: denied, allowed`).
- Repository precondition failures name the offending paths (dirty files, changed submodules, nested repositories), bounded to 20 entries.
- Prompt-injection hardening in the review pipeline: candidate diffs, test evidence, and consolidated findings are wrapped in explicit untrusted-data fences with a data-not-instructions preface, a 200k-character cap with truncation evidence, and fence-forgery neutralization.
- The pythinker implementer lane forwards a caller-supplied `TIMEOUT_SECONDS` (default 1800s) to the adapter and forbids background waits.

### Fixed

- The committed `runtime/server.mjs` bundle shipped with 0.13.0 was stale: it lacked the `delegatePipeline` tool, pinned `RUNTIME_VERSION` at 0.12.1, and a fresh rebuild broke schema resolution. Role-prompt schemas now resolve from both the source and bundled layouts, and the regenerated bundle actually exposes all ten MCP tools. Installed copies must update and reload to receive `delegatePipeline`.

## [0.13.0] - 2026-07-16

### Added

- `delegatePipeline` MCP tool: a deterministic delegate → review → fix → verify loop that runs the full lifecycle in one call, with a fail-closed gate evaluation, clean-room verify, and an evidence bundle per round.
- Fresh-context review pipeline: fresh-session role runner with fail-closed confinement, role prompt templates and role-spec builder, structured-output schemas with a single repair retry, and a deterministic finding consolidator.
- Optional `review` block on the delegation spec (including `maxRounds`) to configure the pipeline from the protocol side.
- Native producer adapters for OpenCode (plain-text contract), Pi (inherited-config profile, multi-provider), and Pythinker — all registered in the producer registry with per-producer certification smokes.
- macOS Seatbelt os-kind write-confinement backend, per-producer Seatbelt writable paths with Pythinker MCP isolation, and a read-only Seatbelt policy for review roles.
- End-to-end pipeline lifecycle test running against a temporary git repository, plus an opt-in Seatbelt certification gate.

### Changed

- The delegate skill now routes non-trivial delegations through `delegatePipeline` instead of the manual lifecycle tools.
- Lane docs: progress streams via the FINAL file (caller-supplied progress log), and the Pi lane is documented as multi-provider rather than local-only.

## [0.12.1] - 2026-07-15

### Added

- The Codex capability report's `authState` now reflects auth-store presence: `authenticated` or `unauthenticated` from a presence-only check of `auth.json` in the `CODEX_HOME`-or-`~/.codex` store (contents are never read). Unavailable producers keep `unknown`; doctor now shows whether the Codex lane is credentialed before a delegation.

## [0.12.0] - 2026-07-15

### Added

- Recorded real-Linux evidence from the opt-in confinement gate on arm64, kernel 7.0.11-orbstack, a `node:22` container, and codex-cli 0.144.4: the inside-worktree write succeeded with exact content and the outside-home write was blocked.
- Confirmed that the Codex Linux sandbox uses bubblewrap and requires unprivileged user namespaces. Where they are blocked, such as by Docker's default seccomp profile, Codex refuses to execute commands and provides no unsandboxed fallback.

### Changed

- Promoted the Linux native `codex-native-sandbox` backend to `tested`, enabling the Codex edit Lane on Linux.

## [0.11.1] - 2026-07-15

### Added

- Doctor now reports host-applicable sandbox backend states in `sandboxBackends` (`id`, `kind`, and `state` resolved for the current host with the same matching semantics as `selectSandboxBackend`), making edit-lane eligibility diagnosable from diagnostics output.

## [0.11.0] - 2026-07-15

### Added

- Added a 3-OS GitHub Actions CI matrix covering macOS 14, Ubuntu, and Windows, with the Windows leg compiling the native helper with MSVC. Evidence: [first fully green run](https://github.com/Pythoughts-labs/claude-architect/actions/runs/29451055892).
- Committed `native/bin/win32-job-kill-x64.exe` (SHA-256 `a96636f4d9e564b978172662e005e2a521205dd3b2eaea271b511854a05ccd10`), including its new `token <pid>` creation-FILETIME mode for process-identity tokens without PowerShell.
- Enabled Windows worktrees with removal retries for transient Windows file locking.

### Fixed

- Made candidate materialization byte-exact under hostile `core.autocrlf` settings by pinning Git runs to `-c core.autocrlf=false`.
- Gave Win32 verification commands the Windows essential environment set. They previously ran without an essential environment, which could leave repository mutations undetected; verification now fails closed.
- Made release validation fail when the native helper binary is missing or empty, or when release version pins drift.

### Notes

- Sandbox backend states are intentionally unchanged: Linux and native Windows remain `unsupported` for the edit Lane because no real confinement evidence exists for them yet.

## [0.10.0] - 2026-07-15

### Added

- P0-B Windows groundwork now ships in the runtime: native Windows platform services (PATHEXT-aware executable resolution, supervised spawning, checkout locking, canonical paths, PowerShell process-start tokens), Job Object process-tree helper resolution that fails closed when the helper binary is absent, first-class win32 platform selection with the Windows essential environment set (canonical `Path` casing, `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` isolation under a temporary home), and a named write-confinement backend registry — edit attempts fail closed before spawning when the capability report names no recognized, supported backend. The Windows helper binary and CI promotion land with the P0-B release gate.

### Fixed

- A freeze rejected for out-of-scope writes now names the offending repository paths (bounded to 25) in `evidence.freezeRejectPaths`, so a sandbox violation is diagnosable from the archived result instead of only reporting `out-of-scope-write`.
- Archived attempt results now preserve each verification command's `allowedMutations` policy, restoring post-hoc auditability of the effective verification policy.

## [0.9.3] - 2026-07-15

### Added

- `delegate` now streams MCP progress notifications while an attempt runs — probing, producer running, freezing, verifying, archiving — with elapsed seconds and a 15-second heartbeat, so the Host spinner shows live phase information instead of a silent multi-minute call.

### Fixed

- Delegate and review tool results bound `evidence.ignoredPaths` to 50 entries plus an `ignoredPathsOmitted` count. A repository with installed dependencies previously returned ~230 KB of ignored-path names in every result, overflowing the Host's tool-output limit; archived artifacts still record the complete list.

## [0.9.2] - 2026-07-15

### Added

- Verification commands may opt into `allowedMutations: "ignored-paths"`, permitting Git-ignored byproducts such as `node_modules` from a dependency install. Tracked, untracked, submodule, and HEAD mutations still fail verification, and the default remains strict (`none`). Verification runs in a clean materialization, so real projects need an install step before typechecks or tests can run.

## [0.9.1] - 2026-07-15

### Fixed

- Codex authentication now survives HOME isolation. When the Host has not set `CODEX_HOME`, the Codex adapter defaults it to the real `~/.codex` auth store (only when `auth.json` exists), supplied through a new adapter-values environment layer that never overrides a host-provided allowlisted value. Previously every sandboxed invocation failed with 401 Unauthorized because the per-attempt temporary HOME hid the auth store.

## [0.9.0] - 2026-07-15

### Fixed

- `delegate` now accepts a JSON-encoded string Delegation Spec. The tool declares `spec` as an untyped value, so schemaless MCP clients serialize the nested spec object as a string; the handler parses it before validation instead of rejecting every delegation with `#/type must be object`.

## [0.8.0] - 2026-07-14

### Added

- Added the trusted Node.js MCP runtime for the versioned delegation lifecycle: validated specs, isolated Codex production, content-addressed Candidate Artifacts, independent structural/project verification, explicit review decisions, and controlled integration.
- Added a strictly non-mutating `claude-architect:advisor` with only file reads and redacted read-only Git observations.

### Changed

- `/claude-architect:delegate` now drives the MCP `delegate` → `reviewCandidate` → `decideCandidate` → `integrateCandidate` flow. Legacy lane definitions remain packaged for migration; OpenCode, Pi, and Pythinker use them while their runtime adapters are pending, but Codex cannot bypass a failed confinement/edit-eligibility gate.
- Published the reduced P0-A support matrix: macOS arm64 is certified only when Codex reports its proven native sandbox; Linux and native Windows remain pending P0-B and diagnostics-only.
- Codex runtime invocations explicitly disable multi-agent behavior. Installed marketplace copies must update and reload Claude Code before the new runtime and controls take effect.
- Runtime startup now recovers interrupted attempts and prune transactions before serving, while the release gate exercises every canonical failure classification and the complete review/decision/integration lifecycle.

## [0.7.0] - 2026-07-14

### Added

- The shared process-isolation lifecycle now records every delegated run. `run-isolated.sh` appends one atomic line per run to `runs.log` under `${TMPDIR:-/tmp}/claude-architect-runs` (override with `RUN_ISOLATED_LOG_DIR`), capturing the delegated program's basename, argument count, duration, exit status, and result category (`ok`, `failed`, `timeout`, `signal`) so a failed delegation is diagnosable after the fact. Argument values are never logged, since a spec or prompt can travel in argv. Codex — the only lane whose stderr streams to the caller rather than into its result file — additionally mirrors stderr to a per-run `codex-<timestamp>-<pid>.stderr` file (override with `CODEX_LOG_DIR`). Logging is skipped silently when the host lacks the required utilities, and can never alter a delegation's exit status.

## [0.6.0] - 2026-07-14

### Changed

- Renamed the project, plugin, runtime namespace, documentation, and visual assets to Claude Architect (`claude-architect`). Existing installations under the previous identity must add the renamed marketplace and reinstall the plugin or OpenCode assets.
- Added Claude Code marketplace display metadata and an append-only plugin rename map for automatic settings migration on Claude Code 2.1.193 and later.

## [0.5.0] - 2026-07-13

### Added

- Each implementation lane now resolves its adapter script through a shared runtime resolver instead of hardcoding `$CLAUDE_PLUGIN_ROOT`, which subagent shells often don't export. The resolver walks up from the working directory for a plugin checkout, falls back to the newest installed copy under `~/.claude/plugins/cache`, and reports a structured error instead of failing silently.

### Changed

- `/delegate` now asks the user to choose Codex, OpenCode, Pi, or Pythinker when no CLI or agent is named instead of silently defaulting to Codex, and the question documents each lane's model and reasoning controls. GPT-5.6 Sol now defaults to low reasoning.
- Codex lanes now leave long tasks uncapped by default. The isolated runner enforces an explicit positive `CODEX_TIMEOUT_SECONDS` only when a timeout binary is available and rejects invalid values before Codex starts. Release validation now reports actionable diagnostics when the Claude Code or Node.js CLI is missing.
- Every implementation lane now uses one shared process-isolation lifecycle through its own CLI-specific adapter. Codex remains uncapped by default; Pi, Pythinker, and OpenCode default to a fail-closed 900-second cap, which their respective `PI_TIMEOUT_SECONDS=0`, `PYTHINKER_TIMEOUT_SECONDS=0`, or `OPENCODE_TIMEOUT_SECONDS=0` setting disables.
- Harness model, thinking, and variant overrides are optional. When absent, the adapters omit the relevant flags and defer to CLI configuration without a plugin-level default.
- OpenCode project and global installation now package the shared runtime and CLI adapters through `scripts/install-opencode.sh`.

## [0.4.0] - 2026-07-13

### Fixed

- Preserved standard input when the isolated Codex runner starts its process group, restoring the documented prompt-file invocation in both `setsid` and Perl fallback environments.

## [0.3.0] - 2026-07-13

### Fixed

- Corrected the Claude Code plugin manifest to use a string `repository` URL and removed the unsupported npm-style `bugs` field.

## [0.2.0] - 2026-07-13

### Fixed

- Routed all delegated Codex work away from the persistent rescue companion and isolated each run from user MCP configuration, preventing completed tasks from accumulating `node_repl` and other MCP worker subprocesses under the Codex app-server.

## [0.1.0] - 2026-07-12

Initial public release.

### Added

- `delegate` skill that turns a request into a five-part spec, routes it to a lane, and requires the architect to review the diff before accepting.
- Four implementation lanes: `codex-implementer` (GPT-5.6 Sol via the Codex CLI), `opencode-implementer` (any authenticated OpenCode provider), `pi-implementer` (local open-weight model at zero marginal token cost), and `pythinker-implementer` (autonomous, headless `--yolo`).
- `claude-advisor`, a read-only advisor for commitment-boundary decisions.
- Native OpenCode assets under `.opencode/` and `opencode.json`, so the same lanes and skill work outside Claude Code.
- SVG banner and shields badges for the README.

[Unreleased]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.6.0
[0.5.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.5.0
[0.4.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.4.0
[0.3.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.3.0
[0.2.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.2.0
[0.1.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.1.0
