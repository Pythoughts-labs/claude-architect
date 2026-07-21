# Threat Model

This model covers every Producer adapter and the autopilot shipping path. It assumes the local OS, account, Claude Code host, Node.js, Git, and GitHub CLI are not already fully compromised. Repository text, generated code, Producer output, model responses, workflow state, and hosting observations are not assumed trustworthy. Claude Architect is a public beta; security-sensitive work still requires human review.

## Assets and authority

Assets include repository/history integrity and confidentiality; credentials; files outside delegated scope; candidate, eligibility, decision, and cumulative-review integrity; workflow branch/head identity; required-check evidence; durable recovery data; and the human's exclusive authority to merge or otherwise advance `main`.

A human may record any Candidate Decision. Autopilot Promotion may record `accepted` with authority `autopilot-policy` only from current hash-bound Autopilot Eligibility proving every review, verification, advisor, artifact, and base gate. That acceptance permits Controlled Integration only into the workflow branch. Producers, reviewers, advisors, skills, and MCP callers cannot construct or waive eligibility.

## Adversaries

1. A malicious or mistaken Producer changes forbidden files, creates traversal/symlink/case-collision paths, lies about tests, or injects commit trailers.
2. Repository content or a candidate injects instructions into implementers, reviewers, or advisors.
3. A compromised CLI/provider probes credentials, escapes confinement, emits oversized/truncated output, or forges structured evidence.
4. A local process tampers with state, journals, ownership, refs, branches, remotes, PR identity, or process tokens; races promotion, shipping, cleanup, or recovery; or reuses a PID.
5. Hosting returns stale/wrong-head checks, a duplicate PR, or changed identity between observations.
6. An operator grants broad scope/network access, trusts a workspace or permission unexpectedly, misconfigures required checks, or removes retained evidence too early.

## Attack surfaces and mitigations

| Surface | Principal mitigations | Residual risk |
|---|---|---|
| Autopilot input | Strict versioned schemas; fixed `origin/main` and GitHub draft/ready policy; no authority/hash/branch/argv overrides | A valid broad task still grants broad bounded authority |
| Producer process | Adapter-built argv, sanitized environment, eligible OS sandbox, timeouts/process-tree cleanup, nested-delegation denial | Compromised binaries retain permitted read authority |
| Candidate paths | Detached worktrees; canonicalization; traversal, absolute, symlink-escape, scope, submodule, and case-collision rejection | Sandbox defects can cause transient effects before detection |
| Evidence/eligibility | Frozen Git objects, content/manifest hashes, Host verification, read-only reviewers/advisor, schema/revision binding | Incomplete tests or reviewers can miss semantic flaws |
| Promotion | Promotion alone consumes current Eligibility and writes `autopilot-policy`; branch/base/head and intent checks; sanitized commit messages | Same-user compromise can deny service or attack trusted dependencies |
| Final review | Entire workflow branch plus cumulative cross-task evidence | Model review remains fallible and provider context retention is unknown |
| Shipping | GitHub CLI 2.96+; authenticated GitHub HTTPS origin; exact refspec; PR identity TOCTOU bracket; required checks bound to expected head | GitHub/account compromise and misconfigured checks remain possible |
| Permissions | Workspace trust required; project allow rules cannot override managed `ask`/`deny`; narrow autopilot MCP schemas | A compromised host/session can still call allowed tools |
| State/recovery | Bounded no-follow reads, schema/hash/revision checks, atomic writes, leases/registrations, PID+start-token liveness, journal plus direct observation | Abrupt failure or same-user tampering may require human judgment |
| Logs/privacy | Bounded output, truncation rejection at trusted seams, secret registration and redaction | Unknown/transformed/source secrets may remain |

## Shipping and terminal outcomes

**Accepted** means workflow-branch integration is authorized. **Shipped** means the exact workflow head was pushed and a draft PR identity was established. **Ready** means configured required checks were green for that exact head and the PR was marked ready for human review. **Merged** means a human advanced `main`.

Autopilot is autonomous only through ready. It never automatically merges, deploys, releases, closes the PR, or deletes the remote feature branch. `human-decision-required`, `failed`, and `cancelled` are fail-closed durable terminals. “No mid-loop prompts” applies only when workspace trust and effective permissions allow it and every runtime proof remains valid.

## Platform and retention residuals

Native macOS arm64 Codex editing is certified. Eligible Linux Codex editing is tested. Native Windows process/runtime supervision exists, but native Windows Codex editing is not certified. Other Producers and backends remain capability-specific.

Active and fail-closed workflows retain their worktree/branch and evidence as required for inspection or recovery. Ready-state cleanup removes temporary local worktrees, locks, and refs, but retains durable evidence and the remote workflow branch/PR. Local data persists until pruning or deliberate removal; provider data follows provider policy.

## Security conclusion

The strongest claim is containment and provenance through a human-review-ready PR, not proof of correctness. Required checks must be configured and green for the exact head. Human review and human merge authority remain the final boundary; no automatic merge, deployment, or release is in scope.
