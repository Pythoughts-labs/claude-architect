# Security Model

Claude Architect treats repository content, Producer output, model text, command output, and hosting observations as untrusted. The Host runtime and human-controlled Claude Code session form the control plane. Autopilot may operate through a pull request ready for human review, but only a human may merge or otherwise advance `main`. The product remains a public beta and is not an unattended security-review, deployment, or release system.

## Components that execute code

`runtime/bootstrap.mjs` starts the MCP server. The Host runtime may invoke `git`, Node.js, a selected Producer CLI (`codex`, `opencode`, `pi`, or `pythinker`), eligible confinement/process helpers, validated verification executables, and GitHub CLI for shipping v1. Commands use executable-plus-argument arrays, not interpolated shell programs. There is no general MCP shell tool and no autopilot schema field for arbitrary argv, merge, deployment, release, or branch deletion.

Shipping v1 requires GitHub CLI 2.96 or newer, its authenticated account, an authenticated GitHub HTTPS `origin`, and configured required checks. PR identity is observed before and after check retrieval; a passing result is accepted only for the exact expected head. The controller never force-pushes, bypasses hooks, merges, closes a PR, deploys, releases, or deletes the remote branch.

## Authorization and write confinement

The architect supplies explicit write allowlists and forbidden scopes. Producers work in isolated worktrees. Candidate inventory rejects traversal, absolute paths, symlink escapes, unauthorized changes, unsafe submodules, and case-folding collisions. This post-run validation complements but does not replace eligible OS confinement. Nested delegation is denied.

Native macOS arm64 Codex editing with `codex-native-sandbox` is certified. Eligible native Linux Codex editing is tested. Windows watchdog/process supervision supports native Windows runtime operation, but native Windows Codex editing is not certified. Every Producer/platform/backend combination must independently prove eligibility; failure never enables an unconfined substitute.

## Candidate decisions and promotion authority

A human may record any Candidate Decision after reviewing evidence. Autopilot is the sole exception to human-recorded acceptance: the trusted Promotion module may record `accepted` with authority `autopilot-policy` only when a current, hash-bound Autopilot Eligibility record proves every required review, verification, advisor, artifact, and base gate. Producers, reviewers, advisors, skills, and MCP callers cannot construct or waive that eligibility.

Autopilot acceptance authorizes Controlled Integration only into the workflow-owned feature branch. It is neither push nor merge authority. The lifecycle distinctions are:

- **accepted**: the exact candidate may be integrated into the workflow branch;
- **shipped**: the exact workflow head was pushed and a draft PR was established;
- **ready**: configured required checks passed for that head and the PR was marked ready for human review;
- **merged**: a human advanced `main` outside the controller.

The manual lifecycle still requires a human Candidate Decision and stages accepted bytes in the human checkout without committing or shipping.

## Fresh-context review and cumulative evidence

Pipeline implementers, fixers, reviewers, and final verifiers are separate invocations. Reviewers and the advisor are read-only and cannot create eligibility or decisions. Before shipping, the final branch reviewer evaluates the entire workflow branch and durable evidence from all promoted commits and cumulative task interactions. “Fresh context” limits conversational coupling; it does not prove provider-side statelessness or semantic correctness.

## Permissions and prompts

The committed project settings allow only `autopilotStart`, `autopilotStatus`, and `autopilotResume`. Claude Code must first grant workspace trust. Project settings cannot override higher-precedence managed `ask` or `deny` policy. “No mid-loop prompts” is conditional on those effective permissions and uninterrupted objective proof; a permission prompt, failed gate, ambiguity, or `human-decision-required` outcome stops autonomy.

## Network access and data exposure

Codex edit/review sandboxes request no tool-side network. Verification declares `network: denied` or `allowed`, and evidence reports effective enforcement. Cloud Producer and reviewer CLIs necessarily communicate with their configured model providers; local harnesses may use local endpoints. GitHub shipping communicates through the authenticated CLI. The plugin has no universal destination allowlist and does not control provider telemetry, authentication, transport, or retention.

Repository files visible to a Producer may reach its provider. Redaction is bounded and best effort, not data-loss prevention. Do not include credentials, production secrets, deployment commands, or sensitive arguments in specs, repositories, prompts, or test fixtures.

## Workflow state, retention, and recovery

Production state is rooted only at `$CLAUDE_PLUGIN_DATA`. Attempt archives contain manifests, frozen artifacts, bounded redacted logs, decisions, and pipeline evidence. Workflow directories contain state, an intent journal, lease ownership, final whole-branch evidence, and head-bound CI observations; branch registrations live under `autopilot-branches/`. Git candidate and workflow refs keep exact objects reachable as required.

Active and fail-closed workflows retain owned worktrees, branches, and evidence when inspection or recovery requires them. Successful ready-state cleanup removes temporary local worktrees, locks, and workflow refs while retaining durable evidence and the remote feature branch/PR. Recovery uses PID plus process-start-token liveness, ownership records, journal entries, and direct Git/filesystem observation; ambiguity becomes `human-decision-required` rather than inferred success.

Archives use restrictive modes, bounded no-follow reads, atomic writes, and integrity hashes. They are not encrypted at rest. Local evidence remains until pruning or deliberate removal; provider-side records follow provider policy. Stop active workflows before removing plugin data or refs.

## Known limitations

- Public beta safeguards do not prove business correctness or eliminate prompt injection, supply-chain, same-user, or host compromise.
- Only native macOS arm64 Codex editing is certified; Linux is tested when eligible; native Windows Codex editing is not certified.
- Producer availability and confinement are capability-specific and fail closed.
- Required checks can be incomplete or misconfigured; shipping requires configured checks that are green for the exact expected head.
- Redaction is best effort, and readable repository secrets may reach a provider.
- A compromised Claude Code session, Node.js, Git, GitHub CLI, Producer binary, OS account, or model provider is outside important assumptions.
- Autopilot never automatically merges, deploys, releases, or deletes the remote feature branch.
