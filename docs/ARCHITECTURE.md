# Architecture

Claude Architect is a Claude Code plugin that turns an ordered Autopilot Spec into a workflow-owned feature branch and a pull request ready for human review. Claude authors the spec and selects Producers; the trusted runtime owns policy, promotion, cumulative review, shipping, cleanup, and recovery. External coding CLIs remain untrusted Producers. Only a human may merge or otherwise advance `main`.

## Runtime shape

The plugin manifest is `.claude-plugin/plugin.json`; `runtime/bootstrap.mjs` locates Node.js and starts the packaged `runtime/server.mjs` over MCP stdio. TypeScript source lives under `src/`. The server exposes the autopilot tools `autopilotStart`, read-only `autopilotStatus`, and `autopilotResume`, plus the manual candidate tools, `doctor`, and bounded read-only Git tools. Handlers validate inputs and delegate workflow policy to `AutopilotController`.

The autopilot flow is:

1. `autopilotStart` validates the Autopilot Spec, clean repository identity, `origin/main`, shipping prerequisites, and Producer eligibility. It creates a workflow-owned worktree, feature branch, lifetime lease, durable state, and intent journal.
2. Each task runs the real delegation pipeline in a fresh isolated worktree. Candidate freezing rejects scope/path escapes and case collisions; independent verification and review produce durable, hash-bound evidence.
3. `src/autopilot/autopilot-eligibility.ts` proves the current candidate, reviews, verification, advisor report, artifact identity, and base. Only `src/autopilot/candidate-promoter.ts` may consume that record, write an `accepted` Candidate Decision with authority `autopilot-policy`, and perform Controlled Integration into the workflow branch. No Producer, reviewer, advisor, skill, or MCP caller can construct or waive eligibility.
4. Each promoted task becomes one sanitized commit on the workflow branch. `src/autopilot/final-branch-reviewer.ts` evaluates the entire branch and evidence from cumulative task interactions, not only the latest patch.
5. Shipping v1 pushes the exact reviewed head, creates a draft PR, polls configured required checks bound to that head, and marks the PR ready. It requires GitHub CLI 2.96 or newer and an authenticated GitHub HTTPS `origin`; mismatched PR identity, remote, branch, or head fails closed.
6. Successful cleanup removes temporary local workflow resources and reaches `ready-for-human-review`. The remote feature branch, PR, and durable evidence remain. The controller never merges, deploys, releases, or deletes the remote branch.

`autopilotStatus` reads persisted state. `autopilotResume` replays a non-terminal workflow from journaled intent plus direct Git/filesystem observations; it never infers success from a phase string. Terminal outcomes are `ready-for-human-review`, `human-decision-required`, `failed`, and `cancelled`.

## Lifecycle vocabulary

- **Accepted**: a Candidate Decision authorizes hash-bound Controlled Integration into the workflow-owned feature branch. It may be human-recorded, or recorded by Promotion with authority `autopilot-policy` from current Autopilot Eligibility.
- **Shipped**: the exact workflow head was pushed and the draft PR identity was established.
- **Ready**: configured required checks were green for that exact head and the PR was marked ready for human review.
- **Merged**: a human advanced `main`. This is outside runtime authority.

The manual candidate lifecycle remains available only when the human explicitly chooses it. It freezes, reviews, decides, and stages a candidate in the human checkout; it does not commit or ship.

## Permission and prompt boundary

The repository's `.claude/settings.json` grants only the three autopilot MCP calls. Project settings take effect only after Claude Code workspace trust and cannot override managed `ask` or `deny` policy. Therefore “no mid-loop prompts” is conditional on effective permission policy and continued objective proof; a policy prompt, `human-decision-required`, cancellation, or ambiguity stops unattended progress.

## Platform and Producer model

The Codex adapter requests its native sandbox, disables network and nested multi-agent delegation, and uses ephemeral configuration. Native macOS arm64 Codex editing is certified. Native Linux is tested where the required sandbox is eligible. Native Windows process supervision is supported, but native Windows Codex editing is not certified. OpenCode, Pi, and Pythinker are independently capability-gated; certification is never inferred across Producers, operating systems, or backends.

## State, retention, and recovery

`CLAUDE_PLUGIN_DATA` is mandatory outside tests. Attempt archives live under `runs/`; autopilot state/journals/leases live under `workflows/`; branch ownership records live under `autopilot-branches/`; managed worktrees, locks, cleanup journals, and recovery records remain local. Archives use restrictive modes, no-follow bounded reads, atomic writes, and integrity hashes.

Active or fail-closed workflows retain their owned worktree/branch and evidence when inspection or recovery requires them. Ready-state cleanup removes temporary local worktrees, locks, and workflow refs but does not delete the remote feature branch or durable workflow evidence. Startup recovery validates PID plus process-start tokens, journal intent, ownership, and direct Git/filesystem state before preserving, resuming, finalizing, disposing, or requesting human judgment.

This architecture reduces Producer authority; it does not make generated code trustworthy. The product remains a public beta for security-sensitive work, and human review plus human merge authority remain essential.
