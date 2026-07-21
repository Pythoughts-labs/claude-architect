# Plugin Components

This inventory describes Claude Architect 0.27.0 surfaces relevant to marketplace review. The release manifest is `.claude-plugin/plugin.json`; the plugin is MIT licensed and remains a public beta.

## Skill and advisor

`skills/delegate/SKILL.md` defines `/claude-architect:delegate`. It authors a versioned Autopilot Spec, chooses a Producer explicitly, starts the controller, monitors durable status, resumes interrupted non-terminal workflows, and explains all terminal states. It uses the manual candidate lifecycle only when the human explicitly chooses it. The skill has no authority to construct eligibility, record `autopilot-policy`, push, manipulate PRs directly, merge, deploy, release, or delete branches.

`agents/advisor.md` declares only read-only repository tools. Its whole-branch report is one hash-bound eligibility input; it cannot edit, delegate, decide, promote, integrate, ship, or waive a gate.

## MCP tools

`src/mcp/server.ts` exposes narrow tools over stdio:

| Tool | Authority |
|---|---|
| `autopilotStart` | Validate an Autopilot Spec and start controller-owned implementation, promotion, whole-branch review, shipping, and cleanup. |
| `autopilotStatus` | Read-only durable workflow state. |
| `autopilotResume` | Resume a non-terminal workflow from corroborated durable state. |
| `delegate` | Run one isolated Producer attempt, freeze, and independently verify a candidate. |
| `delegatePipeline` | Run fresh-context implement/review/repair/verification without acceptance authority. |
| `reviewCandidate` | Read-only exact anchored patch, changed-path manifest, and evidence. |
| `decideCandidate` | Manual human-directed accepted/rejected/revision-requested Candidate Decision. |
| `integrateCandidate` | Manual hash-bound tree staging; no commit or shipping. |
| `doctor` | Read-only runtime, Git, Producer, platform, workflow ownership, and recovery diagnostics. |
| `gitStatus`, `gitDiff`, `gitLog`, `gitChangedFiles` | Bounded, redacted, non-mutating Git evidence. |

The autopilot input schemas expose no eligibility, authority, gate, hash, branch, or arbitrary argv controls. Project settings allow only the three autopilot tools, require Claude Code workspace trust, and cannot override managed `ask`/`deny`; “no mid-loop prompts” is conditional on those effective permissions and continued objective proof.

## Authority modules

- `src/runtime/*`, `src/git/*`, and `src/verify/*`: attempt isolation, frozen artifacts, scope/path/case-collision enforcement, independent verification, bounded evidence, and manual recovery.
- `src/pipeline/*`: fresh implement/review/fix rounds and gates; roles cannot accept their own output.
- `src/autopilot/autopilot-eligibility.ts`: constructs current hash-bound eligibility from every required review, verification, advisor, artifact, and base gate.
- `src/autopilot/candidate-promoter.ts`: the only autopilot authority that consumes eligibility, records `accepted` with authority `autopilot-policy`, and performs Controlled Integration into the workflow branch.
- `src/autopilot/final-branch-reviewer.ts`: reviews the whole workflow branch and evidence from cumulative task interactions.
- `src/autopilot/autopilot-controller.ts`: phase machine through exact-head shipping, cleanup, and the four terminal classifications.
- `src/autopilot/workflow-store.ts`, `branch-manager.ts`, and `src/runtime/recovery-manager.ts`: durable journals/leases/ownership plus fail-closed workflow recovery.
- `src/ship/*`: GitHub preflight, exact push, draft PR identity, head-bound required checks, and mark-ready. Shipping v1 requires GitHub CLI 2.96+ and authenticated GitHub HTTPS `origin`.
- `runtime/bootstrap.mjs` and `runtime/server.mjs`: packaged JavaScript loaded by Claude Code.

## Lifecycle and retention

**Accepted** permits controlled integration into the workflow feature branch. **Shipped** proves the exact head was pushed and draft PR established. **Ready** proves configured required checks were green for that head and the PR was marked ready for human review. **Merged** is a human action advancing `main`.

Autopilot is autonomous only through ready. It never automatically merges, deploys, releases, closes the PR, or deletes the remote branch. Active and fail-closed workflows retain worktree/branch/evidence as required for inspection and recovery. Ready-state cleanup removes temporary local worktrees, locks, ownership, and refs while retaining durable evidence and the remote feature branch/PR.

## Executables, platforms, and hooks

The runtime may invoke Node.js, Git, configured verification executables, the selected Producer CLI, eligible OS confinement/process helpers, and GitHub CLI for shipping. It has no unrestricted shell endpoint. GitHub shipping requires configured required checks to become green for the exact expected head.

Native macOS arm64 Codex editing is certified. Eligible Linux Codex editing is tested. Native Windows process/runtime supervision is supported, but native Windows Codex editing is not certified. OpenCode, Pi, Pythinker, and other platform/backend combinations remain individually capability-gated.

The marketplace plugin declares no runtime hook. `.githooks/pre-push` is contributor tooling used only when a developer configures Git's `core.hooksPath`.
