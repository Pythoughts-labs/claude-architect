# Project Instructions
 This is a CLaude Code Plugin : 
 Claude Architect is a cross-platform Claude Code plugin for macOS, Linux, and Windows. It adds `/claude-architect:delegate`, which lets Claude route well-scoped implementation subtasks to supported installations of Codex, OpenCode, Pi, or Pythinker.

Claude remains the architect. It creates a versioned Delegation Spec, selects an available Producer based on required capabilities, and runs the task inside an isolated Git worktree. The plugin supervises the delegated process, enforces timeouts and scope constraints, records a reproducible run manifest, and independently verifies the resulting diff and authorized checks.

External agents are treated as untrusted producers. Their output is returned as a verified candidate artifact, not automatically accepted work. Claude reviews the diff and verification evidence before deciding whether the changes should be integrated.

Claude Architect also includes a strictly read-only Claude advisor, cross-platform process supervision, crash recovery, bounded and redacted run logging, and native Producer adapters for Codex, OpenCode, Pi, and Pythinker. Producer availability depends on the operating system, installed CLI version, authentication state, and required execution capabilities.


## Releases

- Advance the minor version for every marketplace release: `0.3.0` -> `0.4.0` -> `0.5.0`. Do not publish patch-version tags.
- Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README version badge, and `CHANGELOG.md` on the same version.
- Run `bash scripts/validate-release.sh` before every release push.
- Do not commit a release tag or push it when validation fails.
