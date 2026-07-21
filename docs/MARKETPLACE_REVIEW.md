# Marketplace Review Summary

Claude Architect 0.27.0 is maintained by Mohamed Elkholy (`elkaix`), published from `Pythoughts-labs/claude-architect`, and MIT licensed. It is a public-beta Claude Code plugin for verified delegation to external coding CLIs. Autopilot is autonomous only through a pull request ready for human review; only a human may merge or otherwise advance `main`.

## What the plugin does

The plugin validates an ordered Autopilot Spec, selects eligible Producers, creates isolated worktrees, freezes and independently verifies candidates, runs fresh-context review/fix rounds, and records durable evidence. For each task, current hash-bound Autopilot Eligibility must prove every review, verification, advisor, artifact, and base gate before the trusted Promotion module can record `accepted` with authority `autopilot-policy` and perform Controlled Integration into the workflow-owned feature branch. Producers, reviewers, advisors, skills, and MCP callers cannot construct or waive eligibility.

After all task commits, a final reviewer evaluates the whole workflow branch and evidence from cumulative interactions. Shipping v1 pushes the exact head, creates a draft PR, waits for configured required checks that are green for that exact head, marks the PR ready, and cleans temporary local workflow resources. It never automatically merges, deploys, releases, closes the PR, or deletes the remote branch.

The manual candidate lifecycle remains available only by explicit human choice. A human may record any Candidate Decision after evidence review; manual Controlled Integration stages a hash-matched accepted candidate without committing or shipping.

## Component inventory

- Skill: `/claude-architect:delegate`, which authors an Autopilot Spec and drives `autopilotStart`, `autopilotStatus`, and `autopilotResume`.
- Agent: strictly read-only `advisor`, whose report is evidence rather than authority.
- Autopilot MCP tools: validated start, read-only status, and resume. Their schemas expose no eligibility, authority, gate, hash, branch, or argv override.
- Manual MCP tools: `delegate`, `delegatePipeline`, `reviewCandidate`, `decideCandidate`, and `integrateCandidate`.
- Diagnostics: read-only `doctor` and bounded read-only Git tools.
- Runtime modules: protocol validation, Producer routing, sandbox/process supervision, Git candidate/workflow management, independent verification, policy eligibility, Promotion, final branch review, GitHub shipping, durable stores, cleanup, doctor, and crash recovery.
- Packaged runtime: `runtime/bootstrap.mjs`, `runtime/server.mjs`, schemas, and Windows watchdog/helper support.
- Plugin hooks: none. The repository `.githooks/pre-push` is contributor tooling, not marketplace-installed behavior.

## Executables and network destinations

The runtime may invoke a suitable Node.js, Git, the selected `codex`/`opencode`/`pi`/`pythinker` CLI, eligible confinement/process helpers, Host-authorized verification executables, and GitHub CLI. Commands use executable and argument arrays; there is no unrestricted shell MCP tool.

Shipping v1 requires GitHub CLI 2.96 or newer, authenticated for an `origin` that is a GitHub HTTPS remote. It communicates branch, commit, PR, and required-check data to GitHub. Producer/reviewer CLIs communicate with the cloud or local provider configured by the user. Verification can use network only as declared and effectively enforced. The plugin has no universal provider destination allowlist and does not control provider telemetry or retention.

## Permission model and prompts

The committed project settings allow exactly the three autopilot MCP tools. Claude Code workspace trust is required before project settings apply; managed `ask` or `deny` policy takes precedence. “No mid-loop prompts” is conditional on effective permission policy and every runtime gate remaining proven. A permission prompt, cancellation, ambiguity, or `human-decision-required` outcome stops autonomous progress.

Producers receive sanitized environments, isolated worktrees, explicit write allowlists/forbidden scopes, and eligible confinement. Candidate freezing rejects traversal, absolute paths, symlink escapes, unsafe submodules, out-of-scope changes, and case-folding collisions. Reviewers/advisor are read-only. The controller accepts required checks only for the expected workflow head and fails closed on PR/branch/ref/remote/repository mismatch.

## Lifecycle vocabulary and human approval

- **Accepted**: a Candidate Decision permits hash-bound Controlled Integration into the workflow branch.
- **Shipped**: the exact workflow head was pushed and a draft PR identity was established.
- **Ready**: configured required checks were green for that head and the PR was marked ready for human review.
- **Merged**: a human advanced `main`; this is outside plugin authority.

Autopilot terminals are `ready-for-human-review`, `human-decision-required`, `failed`, and `cancelled`. Cancelled is durable and terminal. The runtime does not cryptographically authenticate a human instruction; control of the Claude/MCP session remains a trust assumption. Final merge, deployment, and release are always human-controlled external actions.

## Supported operating systems and Producers

Basic runtime/process support covers macOS, Linux, and native Windows, but edit eligibility is narrower. Native macOS arm64 Codex with `codex-native-sandbox` is certified. Eligible native Linux Codex is tested. Native Windows Codex editing is not certified. OpenCode, Pi, Pythinker, and every platform/backend combination must pass their own capability checks; certification is not transferable and unavailable lanes fail closed.

## Persistent state and recovery

Production state is rooted at `$CLAUDE_PLUGIN_DATA`; no implicit fallback is used. Attempt archives retain manifests, frozen candidates, decisions, bounded redacted logs, and pipeline evidence. Workflow directories retain state, intent journals, leases, task promotions, whole-branch final evidence, CI observations, cleanup outcomes, and recovery metadata. Branch ownership records and Git refs/worktrees preserve exact identities.

Active and fail-closed workflows retain their workflow worktree/branch and evidence when inspection or recovery requires them. Ready-state cleanup removes temporary local worktrees, locks, ownership records, and workflow refs, while preserving durable evidence and the remote feature branch/PR. Recovery correlates PID plus process-start token, leases/bootstrap ownership, journal intent, and direct Git/filesystem observations; ambiguity fails closed. No universal local retention period is promised, and provider/GitHub records follow their own policies.

## Threats and limitations

Primary threats include malicious Producer output, prompt injection, compromised CLIs/providers, scope/path escapes, case collisions, forged or stale checks, candidate/branch/remote substitution, state races, cancellation, credential leakage, and unauthorized acceptance. Mitigations include strict schemas, eligible sandboxing, detached worktrees, environment minimization, process supervision, path/case checks, Git/hash anchoring, independent verification, read-only review, current eligibility, sanitized Promotion, whole-branch final review, exact-head shipping, bounded/redacted persistence, and ownership-aware recovery.

Known limitations remain material: this is a public beta; prompt injection and subtle malicious code can pass review/tests; required checks can be incomplete or misconfigured; provider retention is outside plugin control; redaction is best effort; same-user/host/account compromise is out of scope; native Windows Codex editing is not certified; and no autopilot action proves business or deployment safety.

## Installation and removal

1. Install/enable Claude Architect through Claude Code and reload it.
2. Grant workspace trust only after reviewing project settings; managed policy still applies.
3. Install/authenticate an eligible Producer. For shipping, install GitHub CLI 2.96+ and authenticate the repository's GitHub HTTPS `origin`.
4. Configure required checks and run `doctor` before autopilot.
5. Invoke `/claude-architect:delegate`, review its Autopilot Spec, and monitor the durable workflow.

To remove data, first stop Claude Code and confirm no workflow owner is live. Disable the plugin, then deliberately remove `$CLAUDE_PLUGIN_DATA`, candidate/workflow refs, Producer caches, provider records, or GitHub branches/PRs only when their audit/recovery value is no longer required. Uninstalling plugin code alone removes none of those records.
