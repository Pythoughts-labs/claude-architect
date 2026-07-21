import { describe, expect, it } from "vitest";

import type {
  AutopilotCandidateDecisionV2,
  CandidateDecision,
  HumanCandidateDecisionV2,
  LegacyCandidateDecisionV1,
} from "../../src/protocol/candidate-decision.js";
import { loadSchemas } from "../../src/protocol/schema-loader.js";

const validDecision: HumanCandidateDecisionV2 = {
  decisionVersion: "2",
  decision: "accepted",
  authority: "human",
  candidateManifestHash: "a".repeat(64),
  evidenceHash: "b".repeat(64),
  policyVersion: "1",
  recordedAt: "2026-07-20T12:34:56.000Z",
};

describe("Candidate Decision v2", () => {
  it("exports the v2 and normalized legacy decision contracts", () => {
    const legacy: LegacyCandidateDecisionV1 = {
      decisionVersion: "1",
      decision: "rejected",
      authority: "human",
      recordedAt: "2026-07-20T12:34:56.000Z",
    };
    const autopilot: AutopilotCandidateDecisionV2 = {
      ...validDecision,
      decision: "accepted",
      authority: "autopilot-policy",
    };
    const decisions: CandidateDecision[] = [validDecision, autopilot, legacy];

    expect(decisions.map(decision => decision.decisionVersion)).toEqual(["2", "2", "1"]);
  });

  it("accepts every human decision and accepted autopilot decisions", () => {
    const validate = loadSchemas().candidateDecision;

    for (const decision of ["accepted", "rejected", "revision-requested"] as const) {
      expect(validate({ ...validDecision, decision, authority: "human" })).toBe(true);
    }
    expect(validate({ ...validDecision, authority: "autopilot-policy" })).toBe(true);
  });

  it.each(["rejected", "revision-requested"])(
    "rejects an autopilot-policy %s decision",
    decision => {
      expect(loadSchemas().candidateDecision({
        ...validDecision,
        decision,
        authority: "autopilot-policy",
      })).toBe(false);
    },
  );

  it.each([
    ["unknown field", { ...validDecision, extra: true }],
    ["wrong version", { ...validDecision, decisionVersion: "1" }],
    ["wrong decision", { ...validDecision, decision: "approved" }],
    ["wrong authority", { ...validDecision, authority: "producer" }],
    ["short candidate hash", { ...validDecision, candidateManifestHash: "a".repeat(63) }],
    ["uppercase candidate hash", { ...validDecision, candidateManifestHash: "A".repeat(64) }],
    ["short evidence hash", { ...validDecision, evidenceHash: "b".repeat(63) }],
    ["wrong policy version", { ...validDecision, policyVersion: "2" }],
    ["date only", { ...validDecision, recordedAt: "2026-07-20" }],
    ["invalid month", { ...validDecision, recordedAt: "2026-13-20T12:34:56Z" }],
    ["invalid calendar day", { ...validDecision, recordedAt: "2026-02-29T12:34:56Z" }],
  ])("rejects %s", (_label, value) => {
    expect(loadSchemas().candidateDecision(value)).toBe(false);
  });
});
