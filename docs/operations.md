# Operations

## Autopilot prerequisites

Autopilot shipping v1 requires GitHub CLI 2.96 or newer, authenticated for the selected repository; `origin` must be an authenticated GitHub HTTPS remote; the clean checkout must correspond to `origin/main`; and repository required checks must be configured and able to become green. `doctor` reports runtime, Producer, workflow ownership, and recovery diagnostics, but it is read-only and does not repair state.

The committed `.claude/settings.json` allows only `autopilotStart`, `autopilotStatus`, and `autopilotResume`. Claude Code must grant workspace trust before those project permissions apply, and managed `ask` or `deny` rules take precedence. “No mid-loop prompts” is conditional on effective permission policy and continued gate success.

Use `autopilotStart` once with the validated spec, retain its workflow ID, use `autopilotStatus` for read-only observation, and use `autopilotResume` only for a non-terminal interrupted workflow. Terminal states mean:

- `ready-for-human-review`: exact-head required checks were green, the PR was marked ready, and local cleanup succeeded; a human may now review and decide whether to merge;
- `human-decision-required`: preserve evidence and ownership for human inspection;
- `failed`: the workflow failed closed before reaching a review-ready PR — during task execution, verification, promotion, final review, or shipping-authority establishment; preserved evidence identifies the failing stage;
- `cancelled`: cancellation is durable and terminal, not resumable.

Accepted, shipped, ready, and merged are distinct. Acceptance authorizes only workflow-branch integration. Shipped establishes the pushed head and draft PR. Ready establishes configured green checks for that exact head and marks the PR ready for review. Only a human can merge or advance `main`. The controller never automatically merges, deploys, releases, or deletes the remote workflow branch.

## Update during an active workflow

The installed `${CLAUDE_PLUGIN_ROOT}` remains live for a running MCP server until `/reload-plugins`. `${CLAUDE_PLUGIN_DATA}` remains stable across versions. Avoid updating mid-workflow when possible. After update/reload, startup recovery inspects unfinished attempts, pipelines, workflow leases, bootstrap ownership, journals, worktrees, and refs before choosing a disposition.

Attempt checkout locks and workflow owners record both `pid` and `processToken`. A dead PID is stale; a live PID with a mismatched start token is also stale; only a live PID with a matching token is live. Recovery never signals a dead/reused PID and preserves a provably live workflow byte-for-byte. Missing, malformed, conflicting, or ambiguous ownership fails closed.

For a dead non-terminal workflow owner, recovery records resume disposition; the controller performs replay from durable observed state. Cleanup finalization requires the expected cleanup journal intent plus direct observation that the workflow worktree and owned refs are absent. Bootstrap orphans may be disposed only when ownership is provably dead. A phase string alone never proves completion.

## Retention and cleanup

Active and fail-closed workflows retain their workflow worktree/branch, journal, evidence, and recovery metadata when inspection or safe recovery requires them. Successful ready-state cleanup removes temporary local worktrees, locks, ownership records, and workflow refs, while preserving durable workflow/final-review/CI evidence and the remote feature branch/PR. Local evidence remains until pruning or deliberate removal; no universal retention period is promised.

Before deleting local state, stop Claude Code and confirm no workflow owner is live. Removing plugin data or refs can destroy audit/recovery evidence. Remote branch and PR removal is always an explicit human operation outside autopilot.

## Support boundary

Claude Architect remains a public beta. Native macOS arm64 Codex editing is certified; eligible Linux Codex editing is tested; native Windows runtime/process supervision exists but native Windows Codex editing is not certified. Producer eligibility is specific to each CLI/platform/backend. Do not run unattended production, destructive, deployment, release, or security-sensitive workflows.
