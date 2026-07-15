# Changelog

All notable changes to Claude Architect are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Pythoughts-labs/claude-architect/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.6.0
[0.5.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.5.0
[0.4.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.4.0
[0.3.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.3.0
[0.2.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.2.0
[0.1.0]: https://github.com/Pythoughts-labs/claude-architect/releases/tag/v0.1.0
