# Delegation Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runtime-enforced autonomous workflow that implements, independently reviews, verifies, promotes, commits, whole-branch reviews, pushes, opens a draft pull request, waits for required CI, and marks the pull request ready for human review without permitting an agent to merge or advance `main`.

**Architecture:** A deep `AutopilotController` module owns one durable workflow and exposes only start/status/resume. It coordinates existing `delegatePipeline` attempts with new hash-bound eligibility, advisor, promotion, workflow-worktree, whole-branch-review, recovery, and GitHub shipping modules. All Git and GitHub mutations use executable-plus-argument arrays behind trusted interfaces; Claude project permissions allow only the three exact autopilot MCP tools.

**Tech Stack:** TypeScript 7, Node.js 22+, Zod 3, Ajv/JSON Schema 2020-12, MCP SDK 1.x, Git plumbing, GitHub CLI 2.96+ as the first `HostingAdapter`, Vitest 4, esbuild, Claude Code project settings.

**Design:** `docs/superpowers/specs/2026-07-20-delegation-autopilot-design.md`

**External contract references (re-check at implementation time):**

- Claude Code project permission matching, workspace trust, and precedence:
  <https://code.claude.com/docs/en/permissions>
- Claude Code shared/local settings locations and schema behavior:
  <https://code.claude.com/docs/en/settings>
- GitHub CLI required-check fields, buckets, and exit behavior:
  <https://cli.github.com/manual/gh_pr_checks>
- GitHub CLI non-interactive draft creation and readiness operations:
  <https://cli.github.com/manual/gh_pr_create> and
  <https://cli.github.com/manual/gh_pr_ready>

These references establish syntax and observable CLI behavior, not trust. The
runtime still parses structured output, constrains every argument, pins its
tested CLI floor, and fails closed on unknown or changed behavior.

## Global Constraints

- Protocol version is `2.0.0`; Autopilot Spec, Advisor Report, Eligibility Record, Workflow State, and Final Branch Report start at version `1`; Candidate Decision advances to version `2`.
- Marketplace/runtime release is `0.27.0`; all release-version surfaces advance together in the release task.
- `accepted` means authorized for Controlled Integration, not merged. Candidate Decision v2 records `authority: "human" | "autopilot-policy"` and hash-bound evidence.
- Only the trusted Promotion module may record `authority: "autopilot-policy"`; MCP callers never submit eligibility, authority, gate booleans, advisor verdicts, or evidence hashes.
- Only a human may merge, enable auto-merge, submit a merge queue entry, advance `main`, close the pull request, or delete branches.
- Every Producer attempt, reviewer, fixer, advisor, and final-branch reviewer starts with fresh context and the minimum durable package required for its role.
- Every reviewer and advisor is independently read-only; implementers and fixers cannot review, decide, promote, ship, or accept their own work.
- The workflow uses one fresh runtime-owned workflow worktree and one fresh derived `feat/<topic>-<workflow-prefix>` branch. It never reuses a branch or targets `main` directly.
- The human checkout remains unchanged. Producers write only to disposable isolated attempt worktrees; promotion applies only to the workflow worktree.
- Git/gh invocations are executable-plus-argument arrays. Do not add Bash or PowerShell permission rules, shell command strings, `shell: true`, `eval`, command interpolation, force, amend, `--no-verify`, ref deletion, or wildcard refspecs.
- Commit messages are validated one-line inputs, 1–200 UTF-8 bytes, with no control characters, `Co-Authored-By`, generated-by footer, or AI attribution.
- The commit tree must equal the frozen candidate tree. Create commits with `git commit-tree` and advance the exact workflow ref with `git update-ref <ref> <new> <expected-old>`.
- Autopilot Eligibility requires a decision-ready pipeline, final verified candidate, exact review snapshot, empty gate reasons, approving final reviewers, no unresolved blocker/major, an approving advisor with no blocker/major risk or coverage gap, and agreeing hashes/base/tree.
- The whole-branch final gate reviews the complete base-to-head diff plus cumulative task interactions and reruns non-empty final verification in a fresh materialization.
- Shipping creates a draft PR first. Empty, pending, failed, cancelled, skipped, unavailable, ambiguous, or timed-out required checks leave it draft and halt. Only a non-empty required-check set whose every bucket is `pass` may mark it ready.
- Push uses the validated canonical HTTPS repository URL and one exact full source/destination refspec. It never relies on a remote alias, upstream configuration, wildcard refspec, or URL rewrite rule.
- Project permission claims are conditional: no mid-loop prompts after workspace trust and only when no higher-precedence ask/deny or required-interaction policy blocks the exact MCP tools.
- Any ambiguity, platform/Producer ineligibility, stale base/head/hash, scope violation, dirty state, lock conflict, journal mismatch, cleanup error, remote mismatch, duplicate/ambiguous PR, red CI, or unsupported environment fails closed with durable redacted evidence.
- Source changes require `npx tsc --noEmit`, the full `npx vitest run`, a byte-stable `runtime/server.mjs` rebuild, `bash scripts/validate-release.sh`, and `claude plugin validate .`.
- Native Windows remains capability-gated; no autonomy feature may turn an unproven Producer/confinement combination into an eligible edit lane.

---

## File and Module Map

### Versioned contracts

- Create `runtime/schemas/autopilot-spec.v1.json` — strict ordered workflow input.
- Create `runtime/schemas/advisor-report.v1.json` — strict read-only advisor output.
- Create `runtime/schemas/autopilot-eligibility.v1.json` — hash-bound derived gate record.
- Create `runtime/schemas/autopilot-workflow-state.v1.json` — durable workflow state.
- Create `runtime/schemas/final-branch-report.v1.json` — cumulative final gate evidence.
- Create `runtime/schemas/candidate-decision.v2.json` — authority/evidence-bound decision.
- Create `src/protocol/autopilot-spec.ts` — canonical TypeScript input types.
- Create `src/protocol/candidate-decision.ts` — v1 compatibility and v2 types.
- Modify `src/protocol/versions.ts`, `src/protocol/schema-loader.ts`, `src/protocol/spec-validator.ts` — load/validate contracts and bump protocol.

### Review and eligibility

- Create `src/runtime/review-snapshot.ts` — one implementation shared by manual review and autopilot.
- Create `src/pipeline/advisor-stage.ts` — fresh read-only advisor execution.
- Create `src/autopilot/autopilot-eligibility.ts` — pure deterministic eligibility derivation.
- Modify `src/pipeline/report-types.ts`, `src/pipeline/role-prompts.ts`, `src/pipeline/role-runner.ts` — structured advisor role support.
- Modify `src/runtime/artifact-store.ts` — persist the post-pipeline advisor and eligibility records without changing the existing `PipelineResult` meaning.

### Durable autonomous workflow

- Create `src/autopilot/types.ts` — workflow/result/promotion/final-gate types.
- Create `src/autopilot/workflow-store.ts` — atomic state and intent/completion journal.
- Create `src/autopilot/branch-manager.ts` — fresh branch/worktree/base ownership.
- Create `src/autopilot/candidate-promoter.ts` — eligibility-bound decision/apply/commit transaction.
- Create `src/autopilot/final-branch-reviewer.ts` — cumulative branch artifact/review/verify/advisor.
- Create `src/autopilot/autopilot-controller.ts` — deep orchestration module.
- Create `src/ship/hosting-adapter.ts` — remote publication interface.
- Create `src/ship/github-cli-adapter.ts` — fixed-argv GitHub production adapter.
- Modify `src/runtime/artifact-store.ts`, `src/runtime/recovery-manager.ts`, `src/mcp/doctor.ts` — decision compatibility, workflow recovery, diagnostics.

### Trusted Host surface and release

- Modify `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/index.ts` — three exact autopilot MCP tools.
- Create `.claude/settings.json`; modify `.gitignore` — track only shared exact-tool permissions under `.claude/`.
- Modify `skills/delegate/SKILL.md`, `agents/advisor.md`, `AGENTS.md`, live user/security/operations documentation, plugin manifests, `CHANGELOG.md`, version-pinning tests, and generated runtime assets.

---

### Task 1: Versioned Autopilot Spec and wire-contract foundation

**Files:**
- Create: `runtime/schemas/autopilot-spec.v1.json`
- Create: `src/protocol/autopilot-spec.ts`
- Modify: `src/protocol/versions.ts`
- Modify: `src/protocol/schema-loader.ts`
- Modify: `src/protocol/spec-validator.ts`
- Test: `tests/runtime/protocol/autopilot-schema.test.ts`
- Test: `tests/runtime/schema-loader.test.ts`
- Test: `tests/runtime/mcp-input-schema.test.ts`

**Interfaces:**
- Produces: `AutopilotSpec`, `AutopilotTaskSpec`, `AutopilotShippingSpec`, `validateAutopilotSpec(value)`.
- Consumes: the existing canonical `DelegationSpec` validator for every embedded task; do not duplicate or weaken Delegation Spec validation.

- [ ] **Step 1: Write the failing strict-schema tests**

Create a valid fixture with two independently valid embedded Delegation Specs and assert strict failures for duplicate task ids, invalid topic, empty final criteria, empty final verification, non-`origin` remote, non-`main` base, non-draft shipping, CI timeout outside 600000–3600000 ms, multiline/AI-attributed commit messages, and unknown keys.

```ts
import { describe, expect, it } from "vitest";
import { validateAutopilotSpec } from "../../../src/protocol/spec-validator.js";

const verification = [{
  id: "typecheck",
  executable: "npx",
  args: ["tsc", "--noEmit"],
  cwd: ".",
  timeoutMs: 120_000,
  network: "denied" as const,
  expectedExitCodes: [0],
}];

function delegation(objective: string) {
  return {
    specVersion: "1",
    objective,
    context: "Repository contracts are authoritative.",
    writeAllowlist: ["src/**", "tests/**"],
    forbiddenScope: [".git/**"],
    successCriteria: ["The named behavior is covered by a failing-first test."],
    verification,
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

export function validAutopilotSpec() {
  return {
    specVersion: "1",
    topic: "delegation-autopilot",
    base: { remote: "origin", branch: "main" },
    tasks: [
      { id: "contracts", commitMessage: "feat(runtime): add autopilot contracts", delegation: delegation("Add contracts") },
      { id: "controller", commitMessage: "feat(runtime): add autopilot controller", delegation: delegation("Add controller") },
    ],
    finalSuccessCriteria: ["The complete branch passes every release gate."],
    finalVerification: verification,
    shipping: {
      provider: "github",
      draft: true,
      markReadyWhenRequiredChecksPass: true,
      requiredChecksTimeoutMs: 1_800_000,
      pullRequestTitle: "Add delegation autopilot",
      pullRequestBody: "Implements the reviewed autonomous workflow.",
    },
  };
}

describe("Autopilot Spec v1", () => {
  it("accepts the canonical fixture", () => {
    expect(validateAutopilotSpec(validAutopilotSpec())).toMatchObject({ ok: true });
  });

  it.each([
    ["unknown key", (s: any) => { s.extra = true; }],
    ["duplicate task", (s: any) => { s.tasks[1].id = s.tasks[0].id; }],
    ["unsafe commit trailer", (s: any) => { s.tasks[0].commitMessage = "feat: x\n\nCo-Authored-By: model"; }],
    ["empty final checks", (s: any) => { s.finalVerification = []; }],
    ["non-main target", (s: any) => { s.base.branch = "develop"; }],
  ])("rejects %s", (_name, mutate) => {
    const spec = validAutopilotSpec();
    mutate(spec);
    expect(validateAutopilotSpec(spec)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run the new contract test and confirm red**

Run: `npx vitest run tests/runtime/protocol/autopilot-schema.test.ts`

Expected: FAIL because `validateAutopilotSpec` and the Autopilot Spec contract do not exist.

- [ ] **Step 3: Add the canonical TypeScript types**

```ts
import type { DelegationSpec } from "./delegation-spec.js";

export interface AutopilotTaskSpec {
  id: string;
  commitMessage: string;
  delegation: DelegationSpec;
}

export interface AutopilotShippingSpec {
  provider: "github";
  draft: true;
  markReadyWhenRequiredChecksPass: true;
  requiredChecksTimeoutMs: number;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface AutopilotSpec {
  specVersion: "1";
  topic: string;
  base: { remote: "origin"; branch: "main" };
  tasks: AutopilotTaskSpec[];
  finalSuccessCriteria: string[];
  finalVerification: DelegationSpec["verification"];
  shipping: AutopilotShippingSpec;
}
```

- [ ] **Step 4: Add and load the strict JSON schema**

Encode the exact design contract with `additionalProperties: false` at every object, `tasks` length 1–32, unique task ids enforced after schema validation, topic pattern `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`, exact base/provider constants, non-empty final arrays, bounded strings, and shipping timeout 600000–3600000. Reference the canonical Delegation Spec through Ajv's registered schema key; do not copy its fields into the new schema.

Add the loader entry:

```ts
export const AUTOPILOT_SPEC_VERSION = "1" as const;
export const PROTOCOL_VERSION = "2.0.0" as const;
```

Add semantic validation after Ajv:

```ts
const ids = new Set<string>();
for (const task of spec.tasks) {
  if (ids.has(task.id)) errors.push({ path: "#/tasks", message: `duplicate task id: ${task.id}` });
  ids.add(task.id);
  const delegated = validateSpec(task.delegation);
  if (!delegated.ok) prefixDelegationErrors(task.id, delegated.validationErrors, errors);
  if (!isSafeCommitMessage(task.commitMessage)) {
    errors.push({ path: `#/tasks/${task.id}/commitMessage`, message: "unsafe commit message" });
  }
}
```

- [ ] **Step 5: Add schema-loader and MCP protocol assertions**

Assert every new schema is found from source and packaged runtime paths and that an MCP call with `protocolVersion: "1.3.0"` receives an actionable mismatch naming expected `2.0.0`.

- [ ] **Step 6: Run the contract suites green**

Run: `npx vitest run tests/runtime/protocol/autopilot-schema.test.ts tests/runtime/schema-loader.test.ts tests/runtime/mcp-input-schema.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the contract foundation**

```bash
git add runtime/schemas/autopilot-spec.v1.json src/protocol/autopilot-spec.ts src/protocol/versions.ts src/protocol/schema-loader.ts src/protocol/spec-validator.ts tests/runtime/protocol/autopilot-schema.test.ts tests/runtime/schema-loader.test.ts tests/runtime/mcp-input-schema.test.ts
git commit -m "feat(protocol): add versioned autopilot spec"
```

### Task 2: Candidate Decision v2 with authority and evidence binding

**Files:**
- Create: `runtime/schemas/candidate-decision.v2.json`
- Create: `src/protocol/candidate-decision.ts`
- Modify: `src/runtime/artifact-store.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/runtime/candidate-decision.test.ts`
- Test: `tests/runtime/artifact-store.test.ts`
- Test: `tests/runtime/e2e-vertical-slice.test.ts`
- Test: `tests/runtime/mcp-input-schema.test.ts`

**Interfaces:**
- Produces: `CandidateDecisionV2`, `readCandidateDecision`, `writeHumanDecision`, internal-only `writeAutopilotDecision`.
- Preserves: historical v1 `{ decision, recordedAt }` decisions for manual integration only.

- [ ] **Step 1: Write failing v1/v2 compatibility and forgery tests**

```ts
it("requires the exact candidate hash for a human accepted decision", async () => {
  await expect(handleDecideCandidate(repo, runId, "accepted", "0".repeat(64)))
    .resolves.toMatchObject({ ok: false, error: "artifact-hash-mismatch" });
});

it("does not expose autopilot authority through the MCP input", () => {
  expect(decideCandidateInputSchema.safeParse({
    checkoutPath: repo,
    runId,
    decision: "accepted",
    expectedArtifactHash: HASH,
    authority: "autopilot-policy",
  }).success).toBe(false);
});

it("reads a legacy accepted decision but never upgrades its authority", async () => {
  await writeLegacyDecision(store, { decision: "accepted", recordedAt: NOW });
  expect(await store.readDecision(runId)).toEqual({
    decisionVersion: "1",
    decision: "accepted",
    authority: "human",
    recordedAt: NOW,
  });
});
```

- [ ] **Step 2: Run the decision tests and confirm red**

Run: `npx vitest run tests/runtime/candidate-decision.test.ts tests/runtime/artifact-store.test.ts tests/runtime/mcp-input-schema.test.ts`

Expected: FAIL because decisions have no version, authority, candidate hash, or evidence binding.

- [ ] **Step 3: Define Candidate Decision v2**

```ts
export type CandidateDecisionValue = "accepted" | "rejected" | "revision-requested";

export interface CandidateDecisionV2 {
  decisionVersion: "2";
  decision: CandidateDecisionValue;
  authority: "human" | "autopilot-policy";
  candidateManifestHash: string;
  evidenceHash: string;
  policyVersion: "1";
  recordedAt: string;
}

export interface LegacyCandidateDecisionV1 {
  decisionVersion: "1";
  decision: CandidateDecisionValue;
  authority: "human";
  recordedAt: string;
}

export type CandidateDecision = CandidateDecisionV2 | LegacyCandidateDecisionV1;
```

Keep the autopilot writer unexported from MCP modules. Its parameters are the already-loaded candidate and eligibility record, not raw caller strings.

- [ ] **Step 4: Make manual decisions hash-bound**

Change the input to:

```ts
export const decideCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  decision: z.enum(["accepted", "rejected", "revision-requested"]),
  expectedArtifactHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();
```

Before writing any v2 human decision, regenerate the review snapshot, require the expected hash to equal the archived candidate hash, and use the snapshot hash as `evidenceHash`.

- [ ] **Step 5: Preserve idempotence and conflict detection across versions**

Same-decision idempotence must also require identical authority, candidate hash, evidence hash, and policy version. Any field difference returns stable `decision-conflict`; it never overwrites the first record.

- [ ] **Step 6: Run decision and existing lifecycle tests green**

Run: `npx vitest run tests/runtime/candidate-decision.test.ts tests/runtime/artifact-store.test.ts tests/runtime/e2e-vertical-slice.test.ts tests/runtime/mcp-input-schema.test.ts`

Expected: PASS, including historical-decision fixtures.

- [ ] **Step 7: Commit decision provenance**

```bash
git add runtime/schemas/candidate-decision.v2.json src/protocol/candidate-decision.ts src/runtime/artifact-store.ts src/mcp/server.ts src/mcp/tools.ts tests/runtime/candidate-decision.test.ts tests/runtime/artifact-store.test.ts tests/runtime/e2e-vertical-slice.test.ts tests/runtime/mcp-input-schema.test.ts
git commit -m "feat(runtime): bind candidate decisions to authority and evidence"
```

### Task 3: Exact review snapshots shared by manual and autonomous paths

**Files:**
- Create: `src/runtime/review-snapshot.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/runtime/artifact-store.ts`
- Test: `tests/runtime/review-snapshot.test.ts`
- Test: `tests/runtime/review-manifest-echo.test.ts`

**Interfaces:**
- Produces: `createReviewSnapshot(run): Promise<ReviewSnapshot>` and `reviewSnapshotHash(snapshot): string`.
- Consumers: manual `reviewCandidate`, Candidate Decision v2, advisor stage, Autopilot Eligibility, final branch evidence.

- [ ] **Step 1: Write the failing equivalence and tamper tests**

```ts
it("returns byte-identical snapshots through manual review and internal review", async () => {
  const internal = await createReviewSnapshot(await loadArchivedRun(repo, runId));
  const manual = await handleReviewCandidate(repo, runId);
  expect(manual).toMatchObject(internal);
  expect(reviewSnapshotHash(internal)).toMatch(/^[0-9a-f]{64}$/u);
});

it.each(["anchor", "tree", "manifest", "patch-truncation"])("fails closed on %s mismatch", async fault => {
  const run = await archivedRunWithFault(fault);
  await expect(createReviewSnapshot(run)).rejects.toMatchObject({
    detail: { toolError: expect.stringMatching(/candidate|review/) },
  });
});
```

- [ ] **Step 2: Run snapshot tests and confirm red**

Run: `npx vitest run tests/runtime/review-snapshot.test.ts tests/runtime/review-manifest-echo.test.ts`

Expected: FAIL because review regeneration lives inside the MCP handler.

- [ ] **Step 3: Extract the deep snapshot implementation**

```ts
export interface ReviewSnapshot {
  runId: string;
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  manifestHash: string;
  patch: string;
  changedPaths: CandidateArtifact["changedPaths"];
  evidence: AttemptResult["evidence"];
  executedVerification: AttemptResult["executedVerification"];
}
```

The implementation reloads the archive, verifies repository identity, candidate status, manifest coherence, anchor, tree, regenerated full-index binary patch, output bounds, and redaction invariants. Hash canonical JSON with sorted object keys; never hash a redacted substitute for identity fields.

- [ ] **Step 4: Make `reviewCandidate` a thin adapter**

The MCP handler calls `createReviewSnapshot`, removes only internal `runId`/commit/tree fields from its public compatibility shape where required, and returns the same patch/manifest/evidence bytes.

- [ ] **Step 5: Persist snapshot records atomically**

Add `writeReviewSnapshot`/`readReviewSnapshot` under the run archive. Repeated writes are idempotent only when their canonical hash matches.

- [ ] **Step 6: Run snapshot tests green**

Run: `npx vitest run tests/runtime/review-snapshot.test.ts tests/runtime/review-manifest-echo.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the shared review module**

```bash
git add src/runtime/review-snapshot.ts src/mcp/tools.ts src/runtime/artifact-store.ts tests/runtime/review-snapshot.test.ts tests/runtime/review-manifest-echo.test.ts
git commit -m "refactor(runtime): centralize exact candidate review snapshots"
```

### Task 4: Fresh structured advisor stage and deterministic eligibility

**Files:**
- Create: `runtime/schemas/advisor-report.v1.json`
- Create: `runtime/schemas/autopilot-eligibility.v1.json`
- Create: `src/pipeline/advisor-stage.ts`
- Create: `src/autopilot/autopilot-eligibility.ts`
- Modify: `src/pipeline/report-types.ts`
- Modify: `src/pipeline/role-prompts.ts`
- Modify: `src/pipeline/role-runner.ts`
- Modify: `src/runtime/artifact-store.ts`
- Test: `tests/runtime/pipeline/advisor-stage.test.ts`
- Test: `tests/runtime/pipeline/autopilot-eligibility.test.ts`
- Test: `tests/runtime/role-prompts.test.ts`
- Test: `tests/runtime/artifact-store.test.ts`

**Interfaces:**
- Produces: `AdvisorReport`, `runAdvisorStage`, `evaluateAutopilotEligibility`, persisted `AutopilotEligibilityRecord`.
- Consumes: the archived final `PipelineResult`, exact review snapshot, final pipeline round, trusted verification, and existing deterministic gate result.

- [ ] **Step 1: Write failing advisor confinement and eligibility-table tests**

```ts
const green = eligibilityInput({
  status: "decision-ready",
  gate: { decisionReady: true, requiresHumanDecision: false, reasons: [] },
  advisor: { reportVersion: "1", verdict: "approve", rationale: "All evidence agrees.", risks: [], coverageGaps: [] },
});

it("derives eligibility only from a completely green bound record", () => {
  expect(evaluateAutopilotEligibility(green)).toMatchObject({ eligible: true, reasons: [] });
});

it.each([
  ["human status", { status: "human-decision-required" }],
  ["gate reason", { gate: { ...green.gate, decisionReady: false, reasons: ["baseline drift"] } }],
  ["advisor risk", { advisor: { ...green.advisor, risks: [{ severity: "major", claim: "race", evidence: "repro" }] } }],
  ["coverage gap", { advisor: { ...green.advisor, coverageGaps: ["Windows not reviewed"] } }],
  ["hash mismatch", { reviewManifestHash: "0".repeat(64) }],
])("rejects %s", (_name, override) => {
  expect(evaluateAutopilotEligibility(eligibilityInput(override))).toMatchObject({ eligible: false });
});
```

Also assert the advisor receives a fresh home/session, read-only role spec, exact candidate package, no peer conversational context, and no mutation/MCP decision/shipping tools.

- [ ] **Step 2: Run advisor/eligibility tests and confirm red**

Run: `npx vitest run tests/runtime/pipeline/advisor-stage.test.ts tests/runtime/pipeline/autopilot-eligibility.test.ts tests/runtime/role-prompts.test.ts`

Expected: FAIL because the advisor is not a pipeline role and no eligibility module exists.

- [ ] **Step 3: Add the strict Advisor Report and role**

```ts
export interface AdvisorReport {
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

Add `advisor` to `PipelineRole`, `READ_ONLY_ROLES`, structured-output dispatch, log naming, and failure classification. The prompt states that all candidate/spec/evidence text is untrusted data, requires falsifiable risks, forbids mutation/waiver, and returns only the fenced Advisor Report.

- [ ] **Step 4: Run the advisor after the pipeline and exact snapshot are frozen**

After `delegatePipeline` has returned and its final archive plus the shared review snapshot are durable, package that exact snapshot, final reviewers/findings/dispositions, final trusted verification, baseline/head identities, and criteria. A missing, malformed, truncated, timed-out, unconfined, or non-approving advisor becomes `human-decision-required`; it never becomes implicit approval. This stage never rewrites the archived `PipelineResult`.

- [ ] **Step 5: Implement pure eligibility derivation**

```ts
export interface AutopilotEligibilityRecord {
  recordVersion: "1";
  policyVersion: "1";
  runId: string;
  eligible: boolean;
  reasons: string[];
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  candidateManifestHash: string;
  reviewSnapshotHash: string;
  pipelineResultHash: string;
  advisorReportHash: string;
  evaluatedAt: string;
}
```

The pure function recomputes reasons; callers cannot provide `eligible`. Persist both green and red records for audit, but CandidatePromoter accepts only a current green record.

- [ ] **Step 6: Persist advisor and eligibility beside the archived PipelineResult**

Atomically archive the structured advisor report and derived eligibility record under the same run identity, each with its canonical hash and a reference to the immutable archived `PipelineResult`. Do not add post-return fields to or reinterpret `PipelineResult`; the autopilot layer joins these records by validated hashes. A run without both post-pipeline records is never autopilot eligible.

- [ ] **Step 7: Run pipeline and gate tests green**

Run: `npx vitest run tests/runtime/pipeline/advisor-stage.test.ts tests/runtime/pipeline/autopilot-eligibility.test.ts tests/runtime/role-prompts.test.ts tests/runtime/artifact-store.test.ts tests/runtime/gates.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit advisor and eligibility**

```bash
git add runtime/schemas/advisor-report.v1.json runtime/schemas/autopilot-eligibility.v1.json src/pipeline/advisor-stage.ts src/autopilot/autopilot-eligibility.ts src/pipeline/report-types.ts src/pipeline/role-prompts.ts src/pipeline/role-runner.ts src/runtime/artifact-store.ts tests/runtime/pipeline/advisor-stage.test.ts tests/runtime/pipeline/autopilot-eligibility.test.ts tests/runtime/role-prompts.test.ts tests/runtime/artifact-store.test.ts
git commit -m "feat(pipeline): derive advisor-backed autopilot eligibility"
```

### Task 5: Durable workflow state and crash-safe journal

**Files:**
- Create: `runtime/schemas/autopilot-workflow-state.v1.json`
- Create: `src/autopilot/types.ts`
- Create: `src/autopilot/workflow-store.ts`
- Test: `tests/runtime/autopilot/workflow-store.test.ts`

**Interfaces:**
- Produces: `WorkflowStore.create/read/transition/beginIntent/completeIntent`, `AutopilotWorkflowState`, `AutopilotResult`.
- Consumer: only `AutopilotController`, recovery, status, and doctor; tasks/reviewers never receive the mutable store.

- [ ] **Step 1: Write failing transition, CAS, torn-write, and concurrency tests**

```ts
it("rejects an illegal transition", async () => {
  const store = await createStore("preflighting");
  await expect(store.transition({ expectedRevision: 0, to: "marking-ready" }))
    .rejects.toMatchObject({ detail: { toolError: "invalid-workflow-transition" } });
});

it("allows exactly one writer for a revision", async () => {
  const store = await createStore("preflighting");
  const results = await Promise.allSettled([
    store.transition({ expectedRevision: 0, to: "running-task" }),
    store.transition({ expectedRevision: 0, to: "failed" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
```

Cover every valid phase edge, the mandatory `marking-ready` → `cleaning-up` → `ready-for-human-review` sequence, absolute CI deadline preservation, bounded evidence refs, non-newline journal tails, oversize/malformed state, symlink/path substitution, process crash between intent and completion, and fsync/rename failure.

- [ ] **Step 2: Run workflow-store tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/workflow-store.test.ts`

Expected: FAIL because no workflow store exists.

- [ ] **Step 3: Define the complete state contract**

```ts
export type AutopilotPhase =
  | "preflighting" | "running-task" | "promoting-task" | "final-review"
  | "pushing" | "creating-draft-pr" | "waiting-required-checks" | "marking-ready"
  | "cleaning-up" | "ready-for-human-review" | "human-decision-required"
  | "failed" | "cancelled";

export interface AutopilotTaskState {
  id: string;
  runId: string | null;
  candidateManifestHash: string | null;
  eligibilityHash: string | null;
  promotionCommitOid: string | null;
  status: "pending" | "running" | "promoted" | "halted";
}
```

Include canonical repository identity, base/ref/worktree identity, spec hash, revision, current task index, task array, intent journal, final-gate refs/hashes, shipping state, CI observations, cleanup result, terminal classification, and timestamps in the JSON schema.

- [ ] **Step 4: Implement atomic CAS state and append-only journal**

Use secure no-follow opens, bounded reads, validate-on-write and validate-on-read, write-to-new-file/fsync/rename/fsync-directory, monotonic revisions, and the existing state-directory conventions. Every journal entry includes workflow id, revision, operation, stable idempotency key, expected identities, timestamp, and completion or structured failure.

- [ ] **Step 5: Run workflow-store tests green**

Run: `npx vitest run tests/runtime/autopilot/workflow-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit durable workflow state**

```bash
git add runtime/schemas/autopilot-workflow-state.v1.json src/autopilot/types.ts src/autopilot/workflow-store.ts tests/runtime/autopilot/workflow-store.test.ts
git commit -m "feat(runtime): persist crash-safe autopilot workflow state"
```

### Task 6: Fresh workflow branch and worktree manager

**Files:**
- Create: `src/autopilot/branch-manager.ts`
- Modify: `src/git/worktree-manager.ts`
- Modify: `src/git/repo-preconditions.ts`
- Test: `tests/runtime/autopilot/branch-manager.test.ts`

**Interfaces:**
- Produces: `WorkflowBranchManager.create`, `revalidate`, `cleanup`.
- Guarantees: fresh branch, unique worktree, exact fetched base, human checkout untouched, canonical Git common-directory lock.

- [ ] **Step 1: Write failing real-Git safety tests**

Cover clean creation, dirty checkout, detached head, non-GitHub/non-HTTPS remote, remote identity change, existing local/remote branch, linked-worktree collision, branch lock, stale base, SHA-256 repository, spaces/Unicode, case collision, and simultaneous creators. Assert the primary checkout `HEAD`, index, worktree bytes, and branch remain unchanged in every case.

```ts
it("derives a fresh branch and leaves the primary checkout untouched", async () => {
  const before = await snapshotCheckout(fixture.repoRoot);
  const created = await manager.create({
    checkoutPath: fixture.repoRoot,
    workflowId: "0123456789abcdef",
    topic: "delegation-autopilot",
    remote: "origin",
    baseBranch: "main",
  });
  expect(created.branch).toBe("feat/delegation-autopilot-01234567");
  expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
  expect(await git(created.worktreePath, ["symbolic-ref", "--short", "HEAD"]))
    .toMatchObject({ stdout: `${created.branch}\n` });
});
```

- [ ] **Step 2: Run branch-manager tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/branch-manager.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement trusted remote/base resolution**

Read `remote.origin.url`, reject `pushurl`, non-HTTPS, non-`github.com`, query/fragment/userinfo, every `url.*.insteadOf`/`pushInsteadOf` rewrite, and repository identity mismatch. Resolve and record one canonical credential-free HTTPS URL plus `owner/repo`. Fetch `refs/heads/main` through that exact URL into a fresh workflow-private ref with fixed argv and record the exact fetched oid; never infer freshness from local `main` or later rely on the `origin` alias.

- [ ] **Step 4: Create the branch/worktree under the repository lock**

Validate the derived ref with `git check-ref-format --branch`, prove it is absent locally/remotely, atomically create the namespaced base ref and branch, attach a secure runtime-owned worktree, and persist canonical common-dir/worktree/ref identities before releasing the lock.

- [ ] **Step 5: Revalidate every transition**

`revalidate` requires exact common directory, worktree path, symbolic branch, expected head, clean status, no in-progress operation, and unchanged base/remote identity. A mismatch returns a stable non-mutating classification.

- [ ] **Step 6: Run branch-manager and existing worktree tests green**

Run: `npx vitest run tests/runtime/autopilot/branch-manager.test.ts tests/runtime/worktree-manager.test.ts tests/runtime/repo-preconditions.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit workflow branch isolation**

```bash
git add src/autopilot/branch-manager.ts src/git/worktree-manager.ts src/git/repo-preconditions.ts tests/runtime/autopilot/branch-manager.test.ts
git commit -m "feat(runtime): isolate autopilot workflow branches"
```

### Task 7: Eligibility-bound candidate promotion and exact-tree commits

**Files:**
- Create: `src/autopilot/candidate-promoter.ts`
- Modify: `src/integrate/controlled-integrator.ts`
- Modify: `src/runtime/artifact-store.ts`
- Test: `tests/runtime/autopilot/candidate-promoter.test.ts`
- Test: `tests/runtime/controlled-integrator.test.ts`

**Interfaces:**
- Produces: `CandidatePromoter.promote(request): Promise<PromotionResult>`.
- Request contains only workflow/run ids, expected head/hash, and validated commit message; the module reloads eligibility/evidence itself.

- [ ] **Step 1: Write failing promotion transaction tests**

```ts
it("commits exactly the eligible candidate tree", async () => {
  const result = await promoter.promote({
    workflowId,
    runId,
    workflowCheckoutPath,
    expectedHead: baseOid,
    expectedArtifactHash: manifestHash,
    commitMessage: "feat(runtime): add autopilot controller",
  });
  expect(result.status).toBe("committed");
  expect(await revParse(repo, `${result.commitOid}^{tree}`)).toBe(candidateTreeOid);
  expect(await revParse(repo, `${result.commitOid}^`)).toBe(baseOid);
  expect(await status(workflowCheckoutPath)).toBe("");
});
```

Add red cases for missing/red/stale eligibility, caller-forged evidence, human-decision-required pipeline, advisor gap, manifest/tree/base/review hash substitution, decision conflict, dirty worktree, changed head, branch identity change, commit injection, missing Git identity, apply conflict, update-ref race, anchor deletion failure, lock release failure, and every journal crash point.

- [ ] **Step 2: Run promotion tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/candidate-promoter.test.ts`

Expected: FAIL because promotion does not exist.

- [ ] **Step 3: Split apply from anchor deletion in Controlled Integration**

Extract an internal staging primitive that revalidates and stages the exact candidate tree under a borrowed checkout lock but does not delete the candidate anchor. Keep `integrateCandidate` behavior compatible by deleting the anchor after its normal successful manual apply.

- [ ] **Step 4: Implement the promotion proof sequence**

Inside workflow plus checkout locks:

1. reload workflow, run, manifest, PipelineResult, review snapshot, advisor, eligibility, decision, branch identity, and current status;
2. canonical-hash every record and compare it to eligibility;
3. record a v2 `accepted` decision with `authority: "autopilot-policy"` through the internal writer;
4. stage the candidate tree without deleting its anchor;
5. require `git write-tree` to equal `candidateTreeOid`;
6. require `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` to succeed;
7. invoke `git commit-tree <tree> -p <expected-head> -m <validated-message>`;
8. verify the new commit's tree, parent, and message;
9. invoke `git update-ref <exact-workflow-ref> <new-oid> <expected-head>`;
10. prove `HEAD`, index, worktree, and branch state are clean and exact;
11. persist completion; then delete the candidate anchor with expected-old-value.

- [ ] **Step 5: Make recovery idempotent**

If the branch already points to the journaled commit and its tree/parent/message match, finalize without creating another commit. If the branch still points to the expected parent and the staged tree matches, resume commit. Any other state becomes `human-decision-required`; never reset or discard bytes.

- [ ] **Step 6: Run promotion/integration tests green**

Run: `npx vitest run tests/runtime/autopilot/candidate-promoter.test.ts tests/runtime/controlled-integrator.test.ts tests/runtime/e2e-vertical-slice.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit candidate promotion**

```bash
git add src/autopilot/candidate-promoter.ts src/integrate/controlled-integrator.ts src/runtime/artifact-store.ts tests/runtime/autopilot/candidate-promoter.test.ts tests/runtime/controlled-integrator.test.ts
git commit -m "feat(runtime): promote eligible candidates as exact commits"
```

### Task 8: Whole-branch final review and verification

**Files:**
- Create: `runtime/schemas/final-branch-report.v1.json`
- Create: `src/autopilot/final-branch-reviewer.ts`
- Test: `tests/runtime/autopilot/final-branch-reviewer.test.ts`

**Interfaces:**
- Produces: `FinalBranchReviewer.review(args): Promise<FinalBranchReport>`.
- Consumes: exact base/head, Autopilot Spec, all task/pipeline/promotion evidence, existing verifier and fresh role runner.

- [ ] **Step 1: Write failing cumulative-evidence tests**

Assert the final package contains the whole base-to-head binary diff, every task id/run id/candidate hash/commit, every review/fix/advisor/verification reference, and no hidden conversation. Add tests for cross-task interface breakage caught only by the final review, final command failure, zero applicable final commands, changed head during review, missing task evidence, and final advisor coverage gap.

```ts
it("rejects a branch whose tasks were individually green but conflict together", async () => {
  const report = await reviewer.review(await incompatibleGreenTasksFixture());
  expect(report.eligible).toBe(false);
  expect(report.reasons).toContain("final branch review has blocking findings");
  expect(report.status).toBe("human-decision-required");
});
```

- [ ] **Step 2: Run final-review tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/final-branch-reviewer.test.ts`

Expected: FAIL because no cumulative gate exists.

- [ ] **Step 3: Build the cumulative branch artifact**

Under the workflow lock, freeze base/head/tree/changed-path manifest/full-index binary patch and evidence refs. Revalidate head before and after each fresh role/verification phase. Persist the artifact hash before model execution.

- [ ] **Step 4: Run final verification and fresh roles**

Use the Autopilot Spec's non-empty `finalVerification` with `AcceptanceVerifier` in a fresh materialization. Then run fresh correctness, systems, and advisor roles over the same exact cumulative package. Do not auto-expand write scope or synthesize a repair task from findings.

- [ ] **Step 5: Persist the strict final report**

```ts
export interface FinalBranchReport {
  reportVersion: "1";
  workflowId: string;
  baseCommitOid: string;
  headCommitOid: string;
  branchArtifactHash: string;
  verificationHash: string;
  reviewHashes: string[];
  advisorHash: string;
  taskEvidenceHashes: string[];
  eligible: boolean;
  reasons: string[];
  status: "ready-to-ship" | "human-decision-required";
  evaluatedAt: string;
}
```

- [ ] **Step 6: Run final-review tests green**

Run: `npx vitest run tests/runtime/autopilot/final-branch-reviewer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit whole-branch review**

```bash
git add runtime/schemas/final-branch-report.v1.json src/autopilot/final-branch-reviewer.ts tests/runtime/autopilot/final-branch-reviewer.test.ts
git commit -m "feat(runtime): gate shipping on whole-branch review"
```

### Task 9: Fixed-operation GitHub shipping adapter

**Files:**
- Create: `src/ship/hosting-adapter.ts`
- Create: `src/ship/github-cli-adapter.ts`
- Test: `tests/runtime/shipping/github-cli-adapter.test.ts`

**Interfaces:**
- Produces: `HostingAdapter` and `GitHubCliAdapter`.
- The controller sees structured operations; it never sees arbitrary argv or credential values.

- [ ] **Step 1: Write failing argv, parsing, idempotence, and injection tests**

```ts
export interface HostingAdapter {
  preflight(request: HostingPreflight): Promise<HostingTarget>;
  pushBranch(request: PushRequest): Promise<{ remoteHead: string }>;
  ensureDraftPullRequest(request: DraftPullRequestRequest): Promise<PullRequestIdentity>;
  requiredChecks(request: ChecksRequest): Promise<RequiredChecksResult>;
  markReady(request: MarkReadyRequest): Promise<PullRequestIdentity>;
}
```

Assert exact argv for `gh auth status`, `gh repo view`, `gh pr list/view/create/checks/ready`, and Git push. The push argv must contain the validated canonical HTTPS URL and exactly `refs/heads/<branch>:refs/heads/<branch>`; it must not contain `origin` or set upstream state. Assert no call can express `merge`, `auto-merge`, `close`, `delete`, `--force`, `--no-verify`, alternate repo/base/head, an extra or wildcard refspec, shell separator, response file, editor, web UI, fork, or config mutation.

Test exit codes 0/1/2/4/8, malformed/truncated/oversize JSON, credential/path redaction, no required checks, pending/fail/cancel/skipping/pass buckets, duplicate PRs, wrong head oid, wrong base, wrong repository, and auth loss.

- [ ] **Step 2: Run shipping tests and confirm red**

Run: `npx vitest run tests/runtime/shipping/github-cli-adapter.test.ts`

Expected: FAIL because no shipping seam exists.

- [ ] **Step 3: Implement production and in-memory adapters**

Use an injected command runner in tests and `PlatformServices.resolveExecutable` plus supervised spawn in production. Require the product's tested GitHub CLI floor (`>= 2.96.0` for this release), an authenticated `github.com` host, exact canonical `owner/repo`, and a validated credential-free HTTPS URL. Pass no Producer environment or prompt data. Reject Git URL rewrites before fetch/push so repository-local or inherited configuration cannot redirect the fixed target.

- [ ] **Step 4: Make publication idempotent**

Before push, query the remote ref and require absent or exact local head. Before PR creation, list open PRs for exact repo/base/head. Reuse exactly one matching PR only when `headRefOid` matches; zero creates one explicit draft; more than one or any mismatch halts.

Push with the exact executable argument vector:

```ts
[
  "push",
  target.canonicalHttpsUrl,
  `refs/heads/${branch}:refs/heads/${branch}`,
]
```

The validated full ref names are runtime-derived, and the command intentionally
does not set an upstream or resolve a named remote.

Create with fully supplied non-interactive args:

```ts
[
  "pr", "create",
  "--repo", target.repository,
  "--base", "main",
  "--head", branch,
  "--title", title,
  "--body", body,
  "--draft",
]
```

- [ ] **Step 5: Parse required checks deterministically**

Request `bucket,name,state,link` JSON. Empty is `missing`; any `fail`, `cancel`, or `skipping` bucket is red; any `pending` is pending; only a non-empty set whose every bucket is `pass` permits readiness. Unknown buckets or malformed states fail closed.

- [ ] **Step 6: Run shipping tests green**

Run: `npx vitest run tests/runtime/shipping/github-cli-adapter.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit trusted GitHub shipping**

```bash
git add src/ship/hosting-adapter.ts src/ship/github-cli-adapter.ts tests/runtime/shipping/github-cli-adapter.test.ts
git commit -m "feat(runtime): add fail-closed GitHub shipping adapter"
```

### Task 10: Deep AutopilotController orchestration

**Files:**
- Create: `src/autopilot/autopilot-controller.ts`
- Test: `tests/runtime/autopilot/autopilot-controller.test.ts`

**Interfaces:**
- Produces: `AutopilotController.start/status/resume` and no other public workflow mutation methods.
- Consumes: validator, WorkflowStore, WorkflowBranchManager, pipeline runner, review snapshot, CandidatePromoter, FinalBranchReviewer, HostingAdapter.

- [ ] **Step 1: Write the failing state-machine happy-path test**

```ts
it("promotes every task, ships a draft, waits for required checks, and marks ready", async () => {
  const result = await controller.start(repo, validAutopilotSpec());
  expect(result.status).toBe("ready-for-human-review");
  expect(result.tasks.map(task => task.status)).toEqual(["promoted", "promoted"]);
  expect(result.pullRequest).toMatchObject({ draft: false, headCommitOid: result.headCommitOid });
  expect(events).toEqual([
    "preflight", "task:contracts", "promote:contracts",
    "task:controller", "promote:controller", "final-review",
    "push", "draft-pr", "checks:pending", "checks:pass", "mark-ready", "cleanup", "ready",
  ]);
});
```

- [ ] **Step 2: Write the failing halt matrix**

Cover invalid spec, ineligible Producer/platform, pipeline failed, human-decision-required, review/hash/advisor/eligibility red, promotion abort/conflict, final gate red, push/pre-push failure, PR ambiguity, missing/pending timeout/red checks, mark-ready failure, cancellation, and cleanup failure. Assert no later operation is called after the first red transition.

- [ ] **Step 3: Run controller tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/autopilot-controller.test.ts`

Expected: FAIL because the controller does not exist.

- [ ] **Step 4: Implement start and sequential task execution**

`start` validates before probing, creates state, obtains the workflow lock, preflights shipping before any Producer starts, creates the fresh workflow worktree, runs tasks strictly in order, obtains exact snapshot/eligibility, promotes, and advances only after a committed promotion. Persist each phase before its side effect and completion after proof.

- [ ] **Step 5: Implement final review and shipping**

Require a current final report for the exact head. Push, ensure draft PR, persist its number/url/head, poll required checks at a bounded interval until the original absolute deadline, and mark the PR ready only on a non-empty all-pass set. Then enter `cleaning-up`, prove the runtime-owned worktree and workflow locks are cleanly released, record cleanup, and only then enter `ready-for-human-review`. A cleanup error is visible and cannot produce a successful terminal state. Never extend the deadline on resume.

- [ ] **Step 6: Implement status and resume**

`status` is strictly read-only and validates repository/workflow identity before returning redacted state. `resume` obtains the same workflow lock, replays incomplete intent by observed state, and continues only from a proven phase. Terminal calls are idempotent and return the existing result.

- [ ] **Step 7: Run controller tests green**

Run: `npx vitest run tests/runtime/autopilot/autopilot-controller.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the autonomous controller**

```bash
git add src/autopilot/autopilot-controller.ts tests/runtime/autopilot/autopilot-controller.test.ts
git commit -m "feat(runtime): orchestrate autonomous review and shipping"
```

### Task 11: Recovery and doctor coverage for workflows

**Files:**
- Modify: `src/runtime/recovery-manager.ts`
- Modify: `src/mcp/doctor.ts`
- Test: `tests/runtime/autopilot/autopilot-recovery.test.ts`
- Test: `tests/runtime/doctor.test.ts`

**Interfaces:**
- Produces: phase-aware recovery dispositions and read-only workflow diagnostics.
- Preserves: existing attempt/pipeline recovery ordering and live-owner lock safety.

- [ ] **Step 1: Write failing recovery cut-point tests**

Inject a crash after every intent and after every observable mutation: worktree/branch create, pipeline archive, decision, apply, commit-tree, update-ref, promotion record, push, PR create, CI observation, ready transition, and cleanup. Restart recovery twice and assert the second pass is byte-idempotent.

- [ ] **Step 2: Write failing doctor diagnostic tests**

Assert stable issue codes for `autopilot-lock-held`, `autopilot-lock-leaked`, `autopilot-worktree-orphaned`, `autopilot-branch-mismatch`, `autopilot-promotion-incomplete`, `autopilot-remote-recovery-required`, `autopilot-pr-recovery-required`, and malformed/oversize workflow state. Doctor must not remove, rename, update refs, kill processes, push, or call gh.

- [ ] **Step 3: Run recovery/doctor tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/autopilot-recovery.test.ts tests/runtime/doctor.test.ts`

Expected: FAIL because workflow state is unknown to recovery and doctor.

- [ ] **Step 4: Add workflow recovery after attempt recovery**

Preserve live locks using PID plus process token. Recover only dead-owned workflows. Use WorkflowStore journal plus Git/remote/PR observations to choose `resume`, `finalize`, or `human-decision-required`; never infer success from a phase string alone.

- [ ] **Step 5: Add bounded read-only doctor inspection**

Scan workflow roots without following symlinks, bound files/counts/diagnostics, validate complete state, correlate worktree/ref/lock ownership, redact paths and remote details, and report issues without mutation.

- [ ] **Step 6: Run recovery/doctor tests green**

Run: `npx vitest run tests/runtime/autopilot/autopilot-recovery.test.ts tests/runtime/doctor.test.ts tests/runtime/recovery-manager.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit recovery and diagnostics**

```bash
git add src/runtime/recovery-manager.ts src/mcp/doctor.ts tests/runtime/autopilot/autopilot-recovery.test.ts tests/runtime/doctor.test.ts
git commit -m "feat(runtime): recover and diagnose autopilot workflows"
```

### Task 12: MCP surface and exact Claude Code permissions

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/index.ts`
- Modify: `.gitignore`
- Create: `.claude/settings.json`
- Test: `tests/runtime/autopilot/autopilot-mcp.test.ts`
- Test: `tests/runtime/handshake.smoke.test.ts`
- Test: `tests/runtime/plugin-wiring.test.mjs`

**Interfaces:**
- Produces: `autopilotStart`, `autopilotStatus`, `autopilotResume`.
- Does not expose: eligibility creation, autopilot authority, promotion, commit, push, PR readiness, merge, or arbitrary argv.

- [ ] **Step 1: Write failing MCP discovery and strict-input tests**

Assert all three tools appear through a real handshake with object schemas. Assert strict rejection of authority/gate/hash/branch/argv fields, wrong protocol, unknown workflow, repository mismatch, and malformed Autopilot Spec. Assert only `autopilotStatus` is read-only annotated.

- [ ] **Step 2: Run MCP tests and confirm red**

Run: `npx vitest run tests/runtime/autopilot/autopilot-mcp.test.ts tests/runtime/handshake.smoke.test.ts tests/runtime/plugin-wiring.test.mjs`

Expected: FAIL because the tools/settings do not exist.

- [ ] **Step 3: Register the thin MCP handlers**

```ts
export const autopilotStartInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
}).strict();

export const autopilotWorkflowInputSchema = z.object({
  checkoutPath: z.string(),
  workflowId: z.string(),
  protocolVersion: protocolVersionInput,
}).strict();
```

Handlers pass validated values to the controller, stream bounded phase progress, return stable structured output, and preserve cancellation. They contain no workflow policy.

- [ ] **Step 4: Track only shared project settings**

Replace the broad `.claude/` ignore rule with:

```gitignore
.claude/*
!.claude/settings.json
.claude/settings.local.json
.claude/worktrees/
```

Create:

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

Do not allow Bash, PowerShell, manual `decideCandidate`, manual `integrateCandidate`, the whole MCP server, or any GitHub connector mutation.

- [ ] **Step 5: Validate settings semantics**

Run: `node -e "const fs=require('node:fs'); const s=JSON.parse(fs.readFileSync('.claude/settings.json','utf8')); if(s.permissions.allow.length!==3) process.exit(1)"`

Expected: exit 0.

Run: `git check-ignore .claude/settings.json`

Expected: exit 1 because the shared file is trackable.

Run: `git check-ignore .claude/settings.local.json .claude/worktrees/example`

Expected: both paths are reported as ignored.

- [ ] **Step 6: Run MCP/settings tests green**

Run: `npx vitest run tests/runtime/autopilot/autopilot-mcp.test.ts tests/runtime/handshake.smoke.test.ts tests/runtime/plugin-wiring.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the trusted Host surface**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/index.ts .gitignore .claude/settings.json tests/runtime/autopilot/autopilot-mcp.test.ts tests/runtime/handshake.smoke.test.ts tests/runtime/plugin-wiring.test.mjs
git commit -m "feat(plugin): expose exact autopilot workflow tools"
```

### Task 13: End-to-end, adversarial, and cross-platform verification

**Files:**
- Create: `tests/runtime/autopilot/autopilot-e2e.test.ts`
- Create: `tests/runtime/autopilot/autopilot-adversarial.test.ts`
- Create: `tests/runtime/autopilot/autopilot-windows.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `scratchpad.md` only when delegation dogfood discovers a bug

**Interfaces:**
- Tests the public controller/MCP interface with fake Producers and in-memory hosting, plus opt-in real Git/gh smoke paths.
- No test may mock the module whose property it claims to prove.

- [ ] **Step 1: Add the complete green-path integration test**

Use a real temporary Git repository and real worktrees. Use fake isolated Producer processes only at the Producer seam and the in-memory Hosting Adapter only at the external hosting seam. Prove two task candidates become two exact commits, the human checkout is byte-identical, final branch evidence spans both commits, push/PR/check calls are ordered, terminal state is durable, and cleanup removes every temporary worktree/lock.

- [ ] **Step 2: Add the forced-red cross-platform test**

Use a canonical verification command—not shell `false`:

```ts
{
  id: "forced-red",
  executable: "node",
  args: ["-e", "process.exit(7)"],
  cwd: ".",
  timeoutMs: 30_000,
  network: "denied",
  expectedExitCodes: [0],
}
```

Assert no eligibility, decision, integration, commit, push, PR, or ready call occurs after failure.

- [ ] **Step 3: Add adversarial trust-boundary tests**

Cover candidate/pipeline/advisor/workflow/decision/eligibility/state/PR/check tampering; path traversal/symlink/case collisions; branch/ref/remote substitution; commit message injection; malicious Git config; process cancellation; output truncation; concurrent start/resume; same-run cross-repository access; lock races; branch head races; stale CI; duplicate PRs; and attempts to represent force/no-verify/merge/close/delete operations.

- [ ] **Step 4: Add platform jobs**

Run the platform-neutral controller, Git workflow, schema, recovery, and adapter tests on macOS, Ubuntu, and native Windows. Keep real Producer edit smokes conditional on capability eligibility; do not relabel unsupported native Windows Codex editing as tested or certified.

- [ ] **Step 5: Run targeted autonomous suites**

Run: `npx vitest run tests/runtime/autopilot tests/runtime/shipping`

Expected: PASS.

- [ ] **Step 6: Run TypeScript and the full suite**

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npx vitest run`

Expected: PASS with no skipped/flaky test introduced by this work.

- [ ] **Step 7: Record every real delegation-discovered bug**

Append each discovered issue to ignored `scratchpad.md` as a concrete regression-test description. Do not attempt an ordinary `git add scratchpad.md`; the file intentionally remains local dogfood evidence.

- [ ] **Step 8: Commit autonomous verification coverage**

```bash
git add tests/runtime/autopilot tests/runtime/shipping .github/workflows/ci.yml
git commit -m "test(runtime): prove autopilot trust boundaries"
```

### Task 14: Trust-model documentation, packaged runtime, and 0.27.0 release

**Files:**
- Modify: `AGENTS.md`
- Modify: `skills/delegate/SKILL.md`
- Modify: `agents/advisor.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY_MODEL.md`
- Modify: `docs/TRUST_BOUNDARIES.md`
- Modify: `docs/THREAT_MODEL.md`
- Modify: `docs/PRIVACY.md`
- Modify: `docs/operations.md`
- Modify: `docs/PLUGIN_COMPONENTS.md`
- Modify: `docs/MARKETPLACE_REVIEW.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`
- Modify: `src/protocol/versions.ts`
- Modify: `tests/runtime/plugin-wiring.test.mjs`
- Modify: `runtime/server.mjs`

**Interfaces:**
- Documents the exact Candidate Decision distinction, conditional prompt claim, workflow states, limits, platform/Producer support, data retention, recovery, GitHub/gh prerequisite, and human-only merge boundary.
- Synchronizes every release/version/protocol surface.

- [ ] **Step 1: Update the central trust invariant precisely**

Replace the human-only Candidate Decision bullet in `AGENTS.md` with:

```markdown
- A human may record any Candidate Decision after reviewing the evidence. The trusted runtime may record `accepted` with authority `autopilot-policy` only through the hash-bound Promotion module when a current Autopilot Eligibility record proves every required review, verification, advisor, artifact, and base gate. Producers, reviewers, advisors, skills, and MCP callers cannot construct or waive eligibility.
- Autopilot acceptance authorizes Controlled Integration only into the workflow-owned feature branch. Only a human may merge a pull request or otherwise advance `main`.
```

Keep the whole-branch final-review invariant and add the workflow branch/cumulative-interaction evidence requirement.

- [ ] **Step 2: Rewrite the skill lifecycle around the deep controller**

Document when to author an Autopilot Spec, call `autopilotStart`, monitor/status, resume after interruption, interpret every terminal state, and fall back to the existing manual lifecycle only when the human explicitly chooses it. Remove any instruction for the architect to synthesize eligibility or invoke separate decision/integration/Git/gh steps during autopilot.

Preserve every exact routing phrase protected by `tests/delegate-routing.test.mjs`.

- [ ] **Step 3: Update every live trust and user surface**

Make these points exact and consistent:

- autonomous up to a PR ready for human review;
- no automatic merge/deploy/release/branch deletion;
- `accepted` vs shipped vs ready vs merged;
- project settings need workspace trust and cannot override managed ask/deny;
- no mid-loop prompts is conditional, not absolute;
- GitHub CLI 2.96+ and authenticated GitHub HTTPS `origin` are required for shipping v1;
- required checks must be configured and green;
- workflow worktree/branch/evidence/recovery retention;
- public-beta and security-sensitive limitations remain;
- macOS/Linux/native-Windows and Producer eligibility claims remain honest.

- [ ] **Step 4: Advance every version surface**

Set plugin manifest, marketplace entry, README badge, first changelog release heading, runtime version, and version-pinning tests to `0.27.0`. Set runtime/skill protocol markers and mismatch assertions to `2.0.0`. Add an explicit changelog entry for the breaking Candidate Decision semantics and migration behavior.

- [ ] **Step 5: Build the packaged runtime**

Run: `bash scripts/build-runtime.sh`

Expected: `runtime/server.mjs` changes and contains the new tools/contracts without checkout-specific paths.

- [ ] **Step 6: Run skill/document contract tests**

Run: `node tests/delegate-routing.test.mjs`

Expected: PASS.

Run: `npx vitest run tests/runtime/plugin-wiring.test.mjs tests/runtime/handshake.smoke.test.ts`

Expected: PASS.

- [ ] **Step 7: Run all local release gates**

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npx vitest run`

Expected: PASS.

Run: `bash scripts/validate-release.sh`

Expected: PASS, including byte-stable rebuild and strict plugin validation.

Run: `claude plugin validate .`

Expected: PASS.

- [ ] **Step 8: Commit the release-facing migration**

```bash
git add AGENTS.md skills/delegate/SKILL.md agents/advisor.md README.md CHANGELOG.md docs/ARCHITECTURE.md docs/SECURITY_MODEL.md docs/TRUST_BOUNDARIES.md docs/THREAT_MODEL.md docs/PRIVACY.md docs/operations.md docs/PLUGIN_COMPONENTS.md docs/MARKETPLACE_REVIEW.md .claude-plugin/plugin.json .claude-plugin/marketplace.json src/protocol/versions.ts tests/runtime/plugin-wiring.test.mjs runtime/server.mjs
git commit -m "release: 0.27.0"
```

### Task 15: Real autonomous dogfood and final whole-branch security review

**Files:**
- Modify: `scratchpad.md` only for discovered bugs; it remains intentionally ignored.
- No source file changes are expected unless a dogfood failure is found; every found failure must be fixed with its regression test before this task can complete.

**Interfaces:**
- Exercises the installed/reloaded plugin and the exact public `autopilotStart/status/resume` surface.
- Produces a draft/ready PR only in the explicitly authorized isolated dogfood repository/branch.

- [ ] **Step 1: Install/reload the exact 0.27.0 plugin build**

Confirm the runtime reports version `0.27.0`, protocol `2.0.0`, all new schemas, and the three autopilot MCP tools. Restart/reload so stale `0.26.0` bytes cannot satisfy the test.

- [ ] **Step 2: Accept workspace trust once and inspect effective permissions**

Use Claude Code `/permissions` and `/status` to prove the three exact project rules are active and no Bash/PowerShell/manual decision/manual integration/merge rule came from this repository. Record any higher-precedence ask/deny policy as an environment limitation; do not bypass it.

- [ ] **Step 3: Run a real green two-task workflow**

Use two small real tasks whose write allowlists do not overlap unnecessarily and whose final verification runs TypeScript plus focused tests. Verify from durable artifacts and Git/GitHub observations:

- two fresh Producer attempts and fresh reviewer/advisor invocations;
- two eligible exact candidate hashes and two exact commits;
- unchanged human checkout;
- complete cumulative final review;
- clean workflow worktree before shipping;
- pre-push gate executed;
- remote branch head equals local eligible head;
- one draft PR, required checks observed, PR marked ready only after all pass;
- no mid-loop Claude permission prompt after initial workspace trust;
- no leaked worktree, ref, process, lock, or incomplete journal.

- [ ] **Step 4: Run the forced-red workflow**

Use the Node `process.exit(7)` verification command from Task 13. Verify the workflow halts at the red task, persists exact evidence, and makes zero decision/integration/commit/push/PR calls after the failure.

- [ ] **Step 5: Run a crash/resume workflow**

Terminate the Host after a durable push intent but before PR completion. Reload and call `autopilotResume`. Verify the controller observes the remote head, creates or reuses exactly one matching draft PR, preserves the original CI deadline, and reaches the same terminal state without duplicate commits/pushes/PRs.

- [ ] **Step 6: Fix every dogfood failure immediately**

For each failure, first append a regression-test description to `scratchpad.md`, then add the narrow failing executable test, implement the fix, rebuild the runtime if source changed, and rerun every affected and full release gate. Do not mark this task complete with an unresolved or flaky finding.

- [ ] **Step 7: Perform the final whole-branch review**

Review `origin/main...HEAD`, not only the last dogfood fix. Cover trust invariants, complete interactions across attempts, generated runtime parity, macOS/Linux/Windows results, every Producer implication, permissions, remote side effects, recovery, redaction, docs, and version surfaces.

- [ ] **Step 8: Confirm final clean evidence**

Run: `git status --short`

Expected: no unexplained tracked or untracked changes. Ignored `scratchpad.md` may contain dogfood notes and must be reported separately.

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npx vitest run`

Expected: PASS.

Run: `bash scripts/validate-release.sh`

Expected: PASS.

Run: `claude plugin validate .`

Expected: PASS.

The implementation is ready for a human merge decision only after the pull request contains this complete evidence and all claimed cross-platform CI is green.

---

## Plan Self-Review Matrix

| Design requirement | Implemented by |
| --- | --- |
| Versioned strict workflow input | Task 1 |
| Authority/evidence-bound Candidate Decision | Task 2 |
| Exact frozen-byte review snapshot | Task 3 |
| Fresh advisor and deterministic eligibility | Task 4 |
| Durable workflow state and journal | Task 5 |
| Fresh isolated feature branch/worktree | Task 6 |
| Exact-tree promotion and commit | Task 7 |
| Whole-branch cumulative final gate | Task 8 |
| Fixed-argv GitHub draft/CI/readiness flow | Task 9 |
| One deep autonomous controller | Task 10 |
| Crash recovery and doctor diagnostics | Task 11 |
| Three exact MCP tools and narrow permissions | Task 12 |
| Adversarial/cross-platform proof | Task 13 |
| Trust/docs/protocol/runtime/release synchronization | Task 14 |
| Real green/red/resume dogfood and final review | Task 15 |

## Execution Handoff

Plan execution must use one isolated feature worktree created through `superpowers:using-git-worktrees`. Execute tasks in order; each task has a meaningful independent review gate, and no later task may paper over a red earlier gate. Because this repository's instructions require fresh implementer context and independent review, the recommended execution mode is `superpowers:subagent-driven-development`; `superpowers:executing-plans` is acceptable when the user explicitly chooses inline execution.
