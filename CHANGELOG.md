# Changelog

All notable changes to Claude Master are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `/delegate` now asks the user to choose Codex, OpenCode, Pi, or Pythinker when no CLI or agent is named instead of silently defaulting to Codex.

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

[0.3.0]: https://github.com/Pythoughts-labs/claude-master/releases/tag/v0.3.0
[0.2.0]: https://github.com/Pythoughts-labs/claude-master/releases/tag/v0.2.0
[0.1.0]: https://github.com/Pythoughts-labs/claude-master/releases/tag/v0.1.0
