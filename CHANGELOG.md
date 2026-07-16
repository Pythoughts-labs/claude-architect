# Changelog

All notable changes to Claude Architect are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.13.0...HEAD
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
