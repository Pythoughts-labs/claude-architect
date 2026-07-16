// tests/runtime/role-prompts.test.ts
import { describe, expect, it } from "vitest";
import { buildRoleSpec, renderRolePrompt, type RolePackage } from "../../src/pipeline/role-prompts.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";

const spec: DelegationSpec = {
  specVersion: "1", objective: "Add rate limiting", context: "SECRET-IMPLEMENTER-REASONING must never appear",
  writeAllowlist: ["src/api/**"], forbiddenScope: ["src/auth/**"], successCriteria: ["429 after 10 req/s"],
  verification: [{ id: "unit", executable: "npm", args: ["test"], cwd: ".", timeoutMs: 60_000,
    network: "deny", expectedExitCodes: [0] }],
  executionMode: "edit", timeoutMs: 600_000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};
const pkg: RolePackage = {
  spec, baselineCommit: "b".repeat(40), candidateCommit: "c".repeat(40),
  candidateDiff: "--- a/src/api/limit.ts\n+++ b/src/api/limit.ts\n+export const LIMIT = 10;",
  testEvidence: "unit: exit 0",
};

describe("renderRolePrompt", () => {
  it("reviewer prompt includes spec, diff, evidence, and the output schema", () => {
    const prompt = renderRolePrompt("reviewer-correctness", pkg);
    expect(prompt).toContain("Add rate limiting");
    expect(prompt).toContain("export const LIMIT = 10;");
    expect(prompt).toContain("unit: exit 0");
    expect(prompt).toContain('"reportVersion"');            // embedded schema
    expect(prompt).toContain("blocker");                    // severity rubric
    expect(prompt.toLowerCase()).toContain("read-only");    // confinement statement
  });
  it("fixer prompt includes findings and disposition vocabulary", () => {
    const prompt = renderRolePrompt("fixer", { ...pkg, findings: [{
      id: "F-001", reviewers: ["correctness"], severity: "blocker", location: "src/api/limit.ts:1",
      claim: "limit not enforced", evidence: "e", reproduction: "r", requiredOutcome: "enforce", confidence: 0.9 }] });
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("rejected_with_evidence");
    expect(prompt).toContain("exactly one disposition per finding");
  });
  it("reviewer prompts never leak between roles: no findings in reviewer packages", () => {
    const prompt = renderRolePrompt("reviewer-systems", pkg);
    expect(prompt).not.toContain("F-001");
  });
});

describe("buildRoleSpec", () => {
  it("read-only roles get an empty write allowlist and universal forbidden scope", () => {
    const roleSpec = buildRoleSpec("reviewer-systems", spec, pkg);
    expect(roleSpec.writeAllowlist).toEqual([]);
    expect(roleSpec.forbiddenScope).toEqual(["**/*"]);
    expect(roleSpec.review).toBeUndefined();
  });
  it("fixer inherits the base scope", () => {
    const roleSpec = buildRoleSpec("fixer", spec, pkg);
    expect(roleSpec.writeAllowlist).toEqual(["src/api/**"]);
    expect(roleSpec.forbiddenScope).toEqual(["src/auth/**"]);
  });
});
