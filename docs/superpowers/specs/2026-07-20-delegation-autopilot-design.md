# Delegation Autopilot — Contract-First Design

**Date:** 2026-07-20
**Status:** Approved for implementation planning
**Supersedes:** the policy-only design previously stored at this path

## Goal

Provide one durable Claude Architect workflow that can take an ordered feature
brief from a clean checkout through fresh-context implementation, independent
review, repair, verification, evidence-bound automatic promotion, one commit per
task, whole-branch final review, push, draft pull request creation, required-CI
observation, and readiness for human review without pausing for approval between
those steps.

The workflow is autonomous only up to a pull request that is ready for review.
Only a human may merge the pull request or otherwise advance `main`.

## Why the previous design is replaced

The previous design attempted to move acceptance authority with skill prose and
project Bash allow rules while declaring that no runtime or protocol change was
needed. That cannot enforce the intended trust properties:

- `delegatePipeline` currently returns no advisor verdict.
- `decideCandidate("accepted")` currently proves only that a verified candidate
  exists; it does not prove that the pipeline was `decision-ready`.
- a caller can invoke lifecycle tools separately, so prose ordering is not a
  security property;
- the proposed loop did not take the required hash-bound `reviewCandidate`
  snapshot before deciding;
- `doctor` reports checkout locks but does not prove that workflow worktrees
  were removed;
- `.claude/settings.json` and `scratchpad.md` are ignored by this repository;
- broad Bash patterns for `git switch`, `git add`, `git commit`, `git push`, and
  `gh pr create` admit flags the policy meant to forbid, including amend,
  hook-bypass, force, destructive switch, and unintended ref operations;
- project permission allow rules require workspace trust and cannot override a
  higher-precedence ask or deny rule, so a repository cannot promise literally
  zero prompts on an untrusted or managed Host;
- the live README, security documentation, marketplace review, tests, and
  protocol all define human-only candidate acceptance.

Autonomy therefore becomes a trusted runtime capability with versioned inputs,
durable evidence, fixed-argument adapters, and fail-closed state transitions.

## Ubiquitous language

**Autopilot Spec**
A versioned, validated description of an ordered feature workflow. It contains
task Delegation Specs, exact commit messages, final branch criteria,
cross-platform final verification, and shipping policy.

**Autopilot Workflow**
One durable execution of an Autopilot Spec. A workflow owns one fresh workflow
worktree and one fresh feature branch for its entire lifetime.

**Workflow worktree**
A trusted-runtime-owned Git worktree used as the integration target for an
Autopilot Workflow. It is never a Producer worktree and never aliases the
human's checkout.

**Autopilot Eligibility**
A durable runtime verdict bound to one frozen candidate manifest hash, base
commit, final review evidence, verification evidence, advisor report, and
policy version. It is derived by trusted code; callers cannot submit it.

**Candidate Decision**
Authorization for Controlled Integration. Version 2 decisions record the
decision, authority (`human` or `autopilot-policy`), candidate manifest hash,
evidence hash, policy version, and timestamp. `accepted` does not mean merged.
For a human decision, `evidenceHash` identifies the regenerated review snapshot;
for an autopilot-policy decision, it identifies the current Autopilot Eligibility
record that the Promotion module reloaded and proved.

**Promotion**
The evidence-bound transaction that records an autopilot Candidate Decision,
applies the exact candidate to the workflow worktree, creates a commit from the
verified tree, advances the workflow branch with an expected-old-head guard,
and records the resulting commit.

**Shipped**
The workflow branch exists on its validated remote and a draft pull request
exists for the exact local head. Shipped does not mean ready or merged.

**Ready for human review**
The draft pull request's required checks are green and the runtime has marked
the pull request ready. This is the successful terminal workflow state.

**Merged**
A human-controlled GitHub action that advances `main`. The runtime has no merge
operation and no permission to invoke one.

## Trust invariants

All existing isolation, frozen-artifact, independent-review, rerunnable
verification, durability, and whole-branch-review invariants remain. The
candidate-decision invariant becomes:

- A human may record any Candidate Decision after reviewing the evidence.
- The trusted runtime may record `accepted` with authority
  `autopilot-policy` only through the Promotion module and only when a current,
  hash-bound Autopilot Eligibility record exists.
- Producers, reviewers, advisors, skills, MCP callers, and shipping adapters
  cannot construct or waive Autopilot Eligibility.
- An autopilot decision authorizes integration only into its workflow worktree
  and branch. It cannot authorize direct mutation of `main`.
- Only a human may merge the pull request or advance `main`.

The workflow never treats model prose, a Producer self-report, an exit-code-zero
alone, a branch name, or possession of a run id as authority.

## Deep-module shape

`AutopilotController` is the deep module. Its external interface is intentionally
small:

```ts
interface AutopilotController {
  start(checkoutPath: string, spec: unknown): Promise<AutopilotResult>;
  status(checkoutPath: string, workflowId: string): Promise<AutopilotResult>;
  resume(checkoutPath: string, workflowId: string): Promise<AutopilotResult>;
}
```

The MCP server exposes those three operations as `autopilotStart`,
`autopilotStatus`, and `autopilotResume`. It does not expose internal methods for
eligibility creation, branch advancement, commit creation, pushing, pull-request
creation, CI gating, or marking a pull request ready.

Internal seams:

- `CandidatePromoter` — loads durable artifacts, proves eligibility, performs
  Controlled Integration, creates the exact commit, and advances the workflow
  branch;
- `WorkflowBranchManager` — creates a unique branch/worktree from a fetched,
  exact base and validates ref/head/repository identity;
- `FinalBranchReviewer` — reviews and verifies the cumulative branch and all
  task interactions;
- `HostingAdapter` — fixed-operation remote publication seam;
- `WorkflowStore` — atomic state, journal, evidence references, and recovery.

The production hosting adapter uses GitHub CLI executable-plus-argument arrays.
Tests use an in-memory adapter. No shell command string crosses the seam.

## Versioned contracts

### Protocol

The MCP protocol advances from `1.3.0` to `2.0.0`. This is a major change
because Candidate Decision semantics and the `decideCandidate` input become
hash-bound, even though the existing manual lifecycle remains available.

The release carrying this feature is `0.27.0`, the next permitted marketplace
minor after `0.26.0`.

### Autopilot Spec v1

An Autopilot Spec contains:

```ts
interface AutopilotSpecV1 {
  specVersion: "1";
  topic: string;
  base: { remote: "origin"; branch: "main" };
  tasks: Array<{
    id: string;
    commitMessage: string;
    delegation: DelegationSpecV1;
  }>;
  finalSuccessCriteria: string[];
  finalVerification: VerificationCommand[];
  shipping: {
    provider: "github";
    draft: true;
    markReadyWhenRequiredChecksPass: true;
    requiredChecksTimeoutMs: number;
    pullRequestTitle: string;
    pullRequestBody: string;
  };
}
```

Validation requirements:

- `topic` is a lowercase slug of 3–48 characters; the runtime derives the
  branch as `feat/<topic>-<workflow-id-prefix>`;
- a branch is always fresh and is never reused;
- `tasks` contains 1–32 uniquely identified tasks;
- every embedded Delegation Spec is independently canonical-schema valid and
  has `executionMode: "edit"`;
- every task has a one-line commit message of 1–200 bytes with no control
  characters, no `Co-Authored-By`, and no generated-by footer;
- final criteria and final verification are non-empty;
- final verification uses executable/argument arrays and supports `darwin`,
  `linux`, and `win32` selectors exactly as Delegation Spec verification does;
- shipping is GitHub-only in v1, draft is always true, and readiness requires
  green required checks;
- CI observation is bounded to 10–60 minutes;
- unknown properties are rejected at every level.

### Candidate Decision v2

```ts
interface CandidateDecisionV2 {
  decisionVersion: "2";
  decision: "accepted" | "rejected" | "revision-requested";
  authority: "human" | "autopilot-policy";
  candidateManifestHash: string;
  evidenceHash: string;
  policyVersion: "1";
  recordedAt: string;
}
```

Manual `decideCandidate` calls always record `authority: "human"` and now
require `expectedArtifactHash`. The runtime accepts historical v1 decision
records for their existing manual integrations but never treats them as
Autopilot Eligibility.

### Advisor Report v1

The final per-candidate advisor is a fresh, read-only role with a strict
structured report:

```ts
interface AdvisorReportV1 {
  reportVersion: "1";
  verdict: "approve" | "human-decision-required";
  rationale: string;
  risks: Array<{
    severity: "blocker" | "major" | "minor" | "nit";
    claim: string;
    evidence: string;
  }>;
  coverageGaps: string[];
}
```

An advisor approval is necessary but not sufficient. Any blocker/major risk or
coverage gap prevents Autopilot Eligibility even if `verdict` says `approve`.
The report and role log are durable artifacts.

### Workflow state v1

Workflow state records repository identity, exact fetched base, workflow branch
and worktree identity, task cursor, every task run/manifest/commit, current
phase, promotion journal, final-review evidence, remote head, pull-request
identity, CI observations, cleanup outcome, and terminal reason.

Canonical phases are:

```text
preflighting
running-task
promoting-task
final-review
pushing
creating-draft-pr
waiting-required-checks
marking-ready
cleaning-up
ready-for-human-review
human-decision-required
failed
cancelled
```

Only the last four are terminal. The controller does not enter
`ready-for-human-review` until successful workflow-worktree and lock cleanup has
been recorded. State writes are atomic and every external or Git mutation has a
durable intent/completion journal pair.

## Per-task flow

For each ordered task:

1. Revalidate workflow lock, repository identity, workflow worktree identity,
   clean status, exact branch, and expected `HEAD`.
2. Run the embedded Delegation Spec through `delegatePipeline`. Every attempt,
   reviewer, fixer, and advisor starts fresh and receives only its bounded
   durable package.
3. Build and persist the exact `reviewCandidate` snapshot from the final frozen
   bytes. Bind its manifest and evidence hash to the candidate.
4. Run the final read-only advisor over the exact candidate, final independent
   reviews, verifier output, and success criteria.
5. Derive and persist Autopilot Eligibility only if all of these hold:
   - pipeline status is `decision-ready`;
   - gate reasons are empty and `requiresHumanDecision` is false;
   - the attempt is `verified-candidate`;
   - final verification passes with at least one applicable executed command,
     a clean worktree, no unauthorized test deletion/skip, no scope violation,
     no baseline drift, and valid artifacts;
   - the final correctness and systems reports approve the final frozen bytes;
   - no blocker or major finding remains;
   - the final fix, if any, was independently re-reviewed;
   - the advisor report approves, has no blocker/major risk, and has no coverage
     gap;
   - candidate manifest, tree, base, review snapshot, and archived pipeline
     result hashes all agree.
6. Promote through `CandidatePromoter`. The module reloads eligibility and all
   referenced evidence itself; it never trusts a caller-supplied boolean or
   report.
7. Apply the candidate to the workflow worktree under the workflow and checkout
   locks without deleting its anchor prematurely.
8. Prove the staged tree equals the candidate tree, create a commit with
   `git commit-tree`, and advance `HEAD` with `git update-ref` using the expected
   old commit. Repository commit hooks do not execute; the verified tree is the
   commit tree by construction.
9. Record the promotion commit, delete the candidate anchor, prove the workflow
   worktree is clean at the new `HEAD`, and continue to the next task.

The controller never runs `git add`, `git commit`, `git switch`, or another
free-form shell operation.

## Whole-branch final gate

After the last task, the runtime constructs one cumulative branch artifact from
the exact fetched base to the workflow head. The evidence package includes all
task specs, candidate hashes, per-round reviews, fixes/dispositions, advisor
reports, verification reports, promotion records, and commit ids.

`FinalBranchReviewer` then:

1. runs the Autopilot Spec's final verification in a fresh materialization;
2. runs fresh correctness and systems reviews over the complete branch diff and
   cumulative interactions;
3. runs a fresh read-only advisor over the same final evidence;
4. fails closed on any red condition or evidence mismatch;
5. persists a hash-bound final-branch eligibility record.

The final gate does not automatically invent or authorize new scope for repair.
A final blocker produces `human-decision-required` with the workflow branch and
all evidence preserved.

## Trusted shipping

Shipping begins only with a current final-branch eligibility record.

`GitHubCliAdapter` preflight proves:

- `gh` exists and meets the documented minimum version;
- authentication is usable without exposing credentials;
- `origin` is an HTTPS GitHub remote whose canonical `owner/repo` identity is
  recorded;
- the target is exactly `main` in that repository;
- the feature branch does not already exist remotely;
- the workflow head and final eligibility hashes still agree.

It then invokes only fixed executable/argument arrays equivalent to:

```text
git push <validated-canonical-https-url>
         refs/heads/<exact-feature-branch>:refs/heads/<exact-feature-branch>
gh pr create --repo <exact-owner/repo> --base main --head <exact-feature-branch>
             --title <validated-title> --body <validated-body> --draft
gh pr checks <exact-pr-number> --repo <exact-owner/repo>
             --required --json bucket,name,state,link
gh pr ready <exact-pr-number> --repo <exact-owner/repo>
```

No remote alias, force, delete, wildcard refspec, `--no-verify`, merge, close,
auto-merge, or arbitrary additional argument is representable. The adapter
rejects URL rewrite rules and other Git configuration that could redirect the
validated HTTPS target. The push runs the repository's normal pre-push hook.

The adapter creates a draft PR idempotently: recovery first queries for an
existing open PR with the exact repository, base, head, and head commit. A
conflicting or ambiguous external state halts for a human instead of creating a
second PR.

Required checks are polled as structured JSON with bounded intervals. Pending
checks remain draft. A failed, cancelled, skipped, missing-required-check
configuration, authentication failure, or timeout produces
`human-decision-required` and leaves the PR draft. Only a non-empty, all-`pass`
required-check set permits `gh pr ready`.

## Permissions

The shared project `.claude/settings.json` allowlist contains only the exact
MCP tools needed to start, inspect, and resume the workflow:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "mcp__plugin_claude-architect_runtime__autopilotStart",
      "mcp__plugin_claude-architect_runtime__autopilotStatus",
      "mcp__plugin_claude-architect_runtime__autopilotResume"
    ]
  }
}
```

No Bash, PowerShell, broad MCP namespace, manual decision, manual integration,
or merge tool is allowlisted. `.gitignore` makes this one shared settings file
trackable while continuing to ignore `.claude/settings.local.json`, temporary
Claude worktrees, and other local state.

The product promises **no mid-loop Claude Code permission prompts after the
user trusts the workspace and when no higher-precedence ask/deny policy blocks
the exact tools**. It does not promise to bypass workspace trust, managed
settings, connector-required interaction, or organization policy.

## Failure and recovery

The controller halts before the next mutation on any non-green signal. It never
silently retries with reduced confinement, broader scope, another remote, a
different base, a reused branch, skipped hooks, force, or an unreviewed patch.

Recovery is idempotent and phase-aware:

- before a promotion decision, rerun only from a new Producer attempt;
- after a decision but before apply, reload eligibility and resume apply;
- after apply but before branch advance, compare the staged tree and journal;
- after branch advance but before promotion completion, prove the exact commit
  and finalize the record;
- after push, compare local and remote heads;
- after PR creation, recover the exact PR by repository/base/head/head commit;
- during CI wait, resume polling within the original absolute deadline;
- after ready, report the existing successful terminal state.

If the state cannot be proven, the workflow becomes
`human-decision-required`. Cleanup errors are appended to evidence and never
erase the primary outcome.

`doctor` gains read-only workflow diagnostics for held/leaked workflow locks,
orphan workflow worktrees, inconsistent branch/worktree ownership, unfinished
promotion journals, remote/PR recovery requirements, and retained terminal
workflow data. It does not mutate during diagnosis.

## Platform and Producer implications

- The controller, workflow store, Git operations, GitHub adapter, and MCP tools
  are TypeScript/Node and executable-plus-argument based on macOS, Linux, and
  native Windows. No shipped step depends on Bash, a shebang, Unix file modes,
  or a shell command string.
- Producer edit eligibility remains capability-gated per existing policy.
  Native Windows Codex editing remains unavailable until its confinement is
  proven; autonomy never weakens that gate. Other Producers remain eligible only
  when their own adapter and platform report an enforceable edit lane.
- A missing/old/unauthenticated `gh`, a non-GitHub remote, unsupported required
  checks, or a platform-specific process/confinement gap makes the shipping or
  edit lane unavailable before unsafe mutation.
- Tests cover paths with spaces/Unicode, CRLF, case-insensitive paths, SHA-1 and
  SHA-256 object ids, native Windows process semantics, and POSIX behavior.

## Verification strategy

The interface is the test surface:

- contract tests for every new schema, strict unknown-key rejection, protocol
  mismatch, decision-v1 compatibility, and decision-v2 hash/authority rules;
- unit tests for eligibility derivation and every state transition;
- integration tests for workflow worktree/branch creation, exact-tree commits,
  expected-old-head guards, lock races, recovery at every journal cut point,
  and terminal cleanup;
- adversarial tests proving callers cannot forge eligibility, substitute a
  candidate/hash/base, reuse a branch, inject a commit message/argument, bypass
  hooks, push another ref/repository, create duplicate PRs, or mark ready on
  missing/red/pending checks;
- in-memory Hosting Adapter tests for controller behavior and opt-in real `gh`
  smoke tests against an isolated test repository;
- full per-task and whole-branch reviews over frozen bytes;
- macOS, Linux, and native Windows CI for the platform-neutral controller and
  Git/adapter contracts, with real Producer smoke tests only where the reported
  edit lane is eligible;
- TypeScript, full Vitest, byte-stable runtime rebuild, release validation, and
  strict plugin validation.

## Documentation and release

This is a release-facing trust-model change. The same implementation release
updates `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`,
`docs/SECURITY_MODEL.md`, `docs/TRUST_BOUNDARIES.md`, `docs/THREAT_MODEL.md`,
`docs/PRIVACY.md`, `docs/operations.md`, `docs/PLUGIN_COMPONENTS.md`,
`docs/MARKETPLACE_REVIEW.md`, plugin/marketplace descriptions, the README
version badge, protocol marker, runtime bundle, and version-pinning tests.

The release is not complete until all version surfaces say `0.27.0`, protocol
surfaces say `2.0.0`, the full candidate branch has received security review,
all local gates pass, and claimed macOS/Linux/Windows CI is green.

## Explicit non-goals

- automatic merge, auto-merge enablement, merge queue submission, deployment,
  release publication, tag creation, branch deletion, or PR closure;
- bypassing workspace trust, managed permissions, required user interaction,
  repository protection, pre-push hooks, or required CI;
- falling back to shell-interpolated Git/gh commands or a less isolated
  Producer;
- auto-waiving a reviewer/advisor finding or auto-expanding write scope;
- claiming business correctness, supply-chain safety, or security proof from a
  green automated workflow.
