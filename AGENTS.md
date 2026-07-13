# Project Instructions

## Releases

- Advance the minor version for every marketplace release: `0.3.0` -> `0.4.0` -> `0.5.0`. Do not publish patch-version tags.
- Keep `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, the README version badge, and `CHANGELOG.md` on the same version.
- Run `bash scripts/validate-release.sh` before every release push.
- Do not commit a release tag or push it when validation fails.
