import { describe, expect, it } from "vitest";
import {
  advisorReportHash,
  eligibilityInputFromArtifacts,
  evaluateAutopilotEligibility,
  pipelineResultHash,
} from "../../../src/autopilot/autopilot-eligibility.js";
import { advisorReport, pipelineResult, reviewSnapshot } from "./autopilot-fixtures.js";
import { loadSchemas } from "../../../src/protocol/schema-loader.js";

function greenInput() {
  return eligibilityInputFromArtifacts({
    pipelineResult: pipelineResult(),
    reviewSnapshot: reviewSnapshot(),
    advisor: advisorReport,
    evaluatedAt: "2026-07-20T12:00:00.000Z",
  });
}

describe("evaluateAutopilotEligibility", () => {
  it("derives eligibility only from a completely green bound record", () => {
    expect(evaluateAutopilotEligibility(greenInput())).toMatchObject({
      eligible: true,
      reasons: [],
    });
  });

  // Several rows are red for more than the reason they name -- the status and
  // gate overrides also trip the projection-mismatch check, because the
  // hash-bound pipelineResult still reports decision-ready. Asserting only
  // `eligible: false` would keep these green even if the named check were
  // removed, so each row now pins the reason it claims to exercise.
  it.each([
    ["human status", () => ({ status: "human-decision-required" as const }),
      /status is not decision-ready/iu],
    ["gate reason", () => ({
      gate: { decisionReady: false, requiresHumanDecision: false, reasons: ["baseline drift"] },
    }), /baseline drift|gate/iu],
    ["advisor risk", () => {
      const advisor = {
        ...advisorReport,
        risks: [{ severity: "major" as const, claim: "race", evidence: "repro" }],
      };
      return { advisor, advisorReportHash: advisorReportHash(advisor) };
    }, /risk/iu],
    ["coverage gap", () => {
      const advisor = { ...advisorReport, coverageGaps: ["Windows not reviewed"] };
      return { advisor, advisorReportHash: advisorReportHash(advisor) };
    }, /coverage/iu],
    ["hash mismatch", () => ({ reviewManifestHash: "0".repeat(64) }), /hash|manifest/iu],
    ["missing source artifacts", () => ({
      pipelineResult: undefined, reviewSnapshot: undefined,
    }), /missing|artifact/iu],
  ])("rejects %s", (_name, override, expectedReason) => {
    const record = evaluateAutopilotEligibility({ ...greenInput(), ...override() });
    expect(record).toMatchObject({ eligible: false });
    expect(record.reasons.some(reason => expectedReason.test(reason)), record.reasons.join(" | "))
      .toBe(true);
  });

  it("ignores a forged caller eligibility and recomputes reasons", () => {
    const red = {
      ...greenInput(),
      status: "human-decision-required" as const,
      eligible: true,
      reasons: [],
    };
    expect(evaluateAutopilotEligibility(red)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["pipeline status is not decision-ready"]),
    });
  });

  it("rejects caller projections that disagree with the hash-bound PipelineResult", () => {
    const green = greenInput();
    const source = { ...green.pipelineResult, status: "human-decision-required" as const };
    expect(evaluateAutopilotEligibility({
      ...green,
      pipelineResult: source,
      pipelineResultHash: pipelineResultHash(source),
    })).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["pipeline result eligibility projection mismatch"]),
    });
  });

  it("registers strict advisor and eligibility schemas", () => {
    const schemas = loadSchemas();
    const eligibility = evaluateAutopilotEligibility(greenInput());
    expect(schemas.advisorReport(advisorReport)).toBe(true);
    expect(schemas.autopilotEligibility(eligibility)).toBe(true);
    expect(schemas.advisorReport({
      ...advisorReport,
      risks: [{ severity: "minor", claim: "claim", evidence: "evidence", extra: true }],
    })).toBe(false);
    expect(schemas.autopilotEligibility({ ...eligibility, extra: true })).toBe(false);
  });
});
