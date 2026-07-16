// src/pipeline/role-prompts.ts
import { readFileSync } from "node:fs";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { Finding } from "./report-types.js";

export type PipelineRole = "reviewer-correctness" | "reviewer-systems" | "fixer" | "verifier";

export interface RolePackage {
  spec: DelegationSpec;
  baselineCommit: string;
  candidateCommit: string;
  candidateDiff: string;
  testEvidence: string;
  findings?: Finding[];
}

function readSchemaText(name: string): string {
  return readFileSync(new URL(`../../runtime/schemas/${name}`, import.meta.url), "utf8");
}

const REVIEW_SCHEMA = readSchemaText("review-report.v1.json");
const FIX_SCHEMA = readSchemaText("fix-report.v1.json");
const VERIFY_SCHEMA = readSchemaText("verification-report.v1.json");

const CORRECTNESS_RUBRIC = `Review dimensions (adversarial — assume the candidate is wrong until proven):
- Acceptance criteria: is each success criterion demonstrably met?
- Missing or incorrect behavior; edge cases (empty, null, boundary, concurrent).
- Error handling at the right layer; no swallowed failures.
- Regression risk to existing behavior.
- Test adequacy: do the tests actually pin the claimed behavior?`;

const SYSTEMS_RUBRIC = `Review dimensions (adversarial — assume the candidate is wrong until proven):
- Security: injection, secrets, unsafe input handling.
- Authorization and trust boundaries.
- Concurrency: races, deadlocks, unsafe shared state.
- Resource lifecycle: leaks, unbounded growth, missing cleanup.
- Compatibility and performance regressions; architectural boundary violations.`;

const SEVERITY_RUBRIC = `Severity: blocker = must not ship; major = wrong/risky, needs fix or explicit human waiver;
minor = should fix, does not block; nit = style only, never blocks.
Every finding needs: exact location (path:line), a falsifiable claim, evidence,
a reproduction, the required outcome, and your confidence (0..1).`;

function commonSections(pkg: RolePackage): string {
  return [
    "## Delegation spec",
    `Objective: ${pkg.spec.objective}`,
    `Success criteria:\n${pkg.spec.successCriteria.map((c) => `- ${c}`).join("\n")}`,
    `Authorized write allowlist:\n${pkg.spec.writeAllowlist.map((p) => `- ${p}`).join("\n") || "- (none)"}`,
    `Forbidden scope:\n${pkg.spec.forbiddenScope.map((p) => `- ${p}`).join("\n") || "- (none)"}`,
    `## Baseline commit\n${pkg.baselineCommit}`,
    `## Candidate commit\n${pkg.candidateCommit}`,
    "## Candidate diff (baseline..candidate)",
    "```diff", pkg.candidateDiff, "```",
    `## Test evidence from the implementation run\n${pkg.testEvidence}`,
  ].join("\n\n");
}

function reviewerPrompt(rubric: string, pkg: RolePackage): string {
  return [
    "You are an untrusted, READ-ONLY code reviewer in a fresh session. You cannot edit files;",
    "the sandbox denies writes. Do not attempt to fix anything. Do not delegate to other agents.",
    "Judge ONLY the candidate diff against the delegation spec below.",
    commonSections(pkg),
    rubric,
    SEVERITY_RUBRIC,
    "## Output",
    "Reply with ONLY a fenced ```json block matching this schema exactly (no prose after it):",
    "```json", REVIEW_SCHEMA, "```",
  ].join("\n\n");
}

export function renderRolePrompt(role: PipelineRole, pkg: RolePackage): string {
  switch (role) {
    case "reviewer-correctness":
      return reviewerPrompt(CORRECTNESS_RUBRIC, pkg);
    case "reviewer-systems":
      return reviewerPrompt(SYSTEMS_RUBRIC, pkg);
    case "fixer":
      return [
        "You are an untrusted fixer in a fresh session working in the candidate worktree.",
        "You may edit ONLY within the authorized write allowlist. Do not perform final verification —",
        "a separate clean-room verifier will. Do not delegate to other agents or expand scope.",
        commonSections(pkg),
        "## Consolidated findings",
        JSON.stringify(pkg.findings ?? [], null, 2),
        "Return exactly one disposition per finding: fixed | already_satisfied |",
        "rejected_with_evidence | blocked | requires_human_decision.",
        "A `fixed` disposition MUST reference the commit that fixes it and include verification evidence.",
        "Never delete, weaken, or skip existing tests to satisfy a finding.",
        "## Output",
        "After committing your fixes, reply with ONLY a fenced ```json block matching this schema:",
        "```json", FIX_SCHEMA, "```",
      ].join("\n\n");
    case "verifier":
      return [
        "You are a READ-ONLY clean-room verifier in a fresh worktree at the final candidate commit.",
        "You cannot edit files. Re-run the authorized verification commands listed in the spec and report faithfully.",
        "Check for: deleted/weakened/skipped tests relative to baseline, dirty tree after tests,",
        "diff outside the authorized allowlist, and baseline drift. Report facts only.",
        commonSections(pkg),
        "## Output",
        "Reply with ONLY a fenced ```json block matching this schema:",
        "```json", VERIFY_SCHEMA, "```",
      ].join("\n\n");
  }
}

export function buildRoleSpec(role: PipelineRole, base: DelegationSpec, pkg: RolePackage): DelegationSpec {
  const readOnly = role !== "fixer";
  const { review: _stripped, ...rest } = base;
  return {
    ...rest,
    objective: `[pipeline role: ${role}] ${base.objective}`,
    context: renderRolePrompt(role, pkg),
    writeAllowlist: readOnly ? [] : base.writeAllowlist,
    forbiddenScope: readOnly ? ["**/*"] : base.forbiddenScope,
  };
}
