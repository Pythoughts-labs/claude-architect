# Changelog

All notable changes to Claude Master are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-12

Initial public release.

### Added

- `delegate` skill that turns a request into a five-part spec, routes it to a lane, and requires the architect to review the diff before accepting.
- Four implementation lanes: `codex-implementer` (GPT-5.6 Sol via the Codex CLI), `opencode-implementer` (any authenticated OpenCode provider), `pi-implementer` (local open-weight model at zero marginal token cost), and `pythinker-implementer` (autonomous, headless `--yolo`).
- `claude-advisor`, a read-only advisor for commitment-boundary decisions.
- Native OpenCode assets under `.opencode/` and `opencode.json`, so the same lanes and skill work outside Claude Code.
- SVG banner and shields badges for the README.

[0.1.0]: https://github.com/Pythoughts-labs/claude-master/releases/tag/v0.1.0
