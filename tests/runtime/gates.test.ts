// tests/runtime/gates.test.ts
import { describe, expect, it } from "vitest";
import { evaluateGates, type GateInput } from "../../src/pipeline/gates.js";
import type { Disposition, Finding, VerificationReport } from "../../src/pipeline/report-types.js";

const OID = "a".repeat(40);

function finding(id: string, severity: Finding["severity"]): Finding {
  return { id, severity, reviewers: ["correctness"], location: "src/a.ts:1", claim: "c",
    evidence: "e", reproduction: "r", requiredOutcome: "o", confidence: 0.9 };
}
function fixed(findingId: string): Disposition {
  return { findingId, disposition: "fixed", evidence: "done", commit: OID };
}
function passVerification(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return { reportVersion: "1", pass: true, commandResults: [], workspaceClean: true,
    testsDeleted: 0, testsSkipped: 0, scopeViolations: [], ...overrides };
}
function base(overrides: Partial<GateInput> = {}): GateInput {
  return { findings: [], dispositions: [], verification: passVerification(),
    roundsUsed: 1, maxRounds: 2, artifactsValid: true, baselineDrift: false, ...overrides };
}

describe("evaluateGates", () => {
  it("clean run is decision-ready", () => {
    expect(evaluateGates(base())).toEqual({ decisionReady: true, requiresHumanDecision: false, reasons: [] });
  });

  it.each<[string, GateInput, boolean]>([
    ["undispositioned blocker", base({ findings: [finding("F-001", "blocker")] }), true],
    ["blocker rejected_with_evidence", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "rejected_with_evidence", evidence: "not a bug" }] }), true],
    ["major marked blocked", base({ findings: [finding("F-001", "major")],
      dispositions: [{ findingId: "F-001", disposition: "blocked", evidence: "needs infra" }] }), true],
    ["fixed blocker missing commit", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "fixed", evidence: "done" }] }), false],
    ["failed verification", base({ verification: passVerification({ pass: false }) }), false],
    ["missing verification (fail closed)", base({ verification: null }), false],
    ["deleted tests", base({ verification: passVerification({ testsDeleted: 1 }) }), false],
    ["newly skipped tests", base({ verification: passVerification({ testsSkipped: 2 }) }), false],
    ["dirty verify worktree", base({ verification: passVerification({ workspaceClean: false }) }), false],
    ["out-of-scope diff", base({ verification: passVerification({ scopeViolations: ["src/forbidden.ts"] }) }), false],
    ["invalid artifact", base({ artifactsValid: false }), false],
    ["baseline drift", base({ baselineDrift: false, ...{ baselineDrift: true } }), false],
    ["round cap exceeded", base({ roundsUsed: 3 }), true],
    ["minor without disposition", base({ findings: [finding("F-001", "minor")] }), false],
  ])("%s → not decision-ready (human=%s)", (_name, input, expectHuman) => {
    const out = evaluateGates(input);
    expect(out.decisionReady).toBe(false);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.requiresHumanDecision).toBe(expectHuman);
  });

  it("nits never block, even undispositioned", () => {
    const out = evaluateGates(base({ findings: [finding("F-001", "nit")] }));
    expect(out.decisionReady).toBe(true);
  });

  it("fixed blocker with commit + passing verification is decision-ready", () => {
    const out = evaluateGates(base({ findings: [finding("F-001", "blocker")], dispositions: [fixed("F-001")] }));
    expect(out.decisionReady).toBe(true);
  });
});
