@AGENTS.md

## Claude Code repository checks

```bash
npx tsgo --noEmit   # TypeScript-Go (primary); npx tsc --noEmit remains the CI cross-check
npx vitest run
bash scripts/validate-release.sh
claude plugin validate .
```
