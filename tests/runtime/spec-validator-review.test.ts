import { describe, expect, it } from "vitest";
import { validateSpec } from "../../src/protocol/spec-validator.js";
import { resolveReviewConfig } from "../../src/protocol/delegation-spec.js";

// makeValidSpec() = copy the minimal valid spec literal used by the existing
// validateSpec tests in tests/runtime/spec-validator.test.ts (all required fields).
function makeValidSpec() {
  return {
    specVersion: "1", objective: "add fn", context: "ctx", writeAllowlist: ["src/**"], forbiddenScope: [],
    successCriteria: ["compiles"], verification: [], executionMode: "edit",
    timeoutMs: 60000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
  };
}

describe("delegation spec review block", () => {
  it("still accepts specs without a review block", () => {
    expect(validateSpec(makeValidSpec()).ok).toBe(true);
  });
  it("accepts a valid review block", () => {
    const spec = { ...makeValidSpec(), review: { reviewers: ["correctness"], maxRounds: 1 } };
    expect(validateSpec(spec).ok).toBe(true);
  });
  it("rejects unknown reviewer kinds and non-positive rounds", () => {
    expect(validateSpec({ ...makeValidSpec(), review: { reviewers: ["vibes"], maxRounds: 2 } }).ok).toBe(false);
    expect(validateSpec({ ...makeValidSpec(), review: { reviewers: ["systems"], maxRounds: 0 } }).ok).toBe(false);
  });
  it("resolveReviewConfig applies spec defaults", () => {
    expect(resolveReviewConfig(makeValidSpec() as never)).toEqual({
      reviewers: ["correctness", "systems"],
      maxRounds: 2,
    });
  });
});
