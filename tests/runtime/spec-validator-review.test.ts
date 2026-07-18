import { describe, expect, it } from "vitest";
import { validateSpec } from "../../src/protocol/spec-validator.js";
import {
  resolveImplementationConfig,
  resolveReviewConfig,
} from "../../src/protocol/delegation-spec.js";

// makeValidSpec() = copy the minimal valid spec literal used by the existing
// validateSpec tests in tests/runtime/spec-validator.test.ts (all required fields).
function makeValidSpec() {
  return {
    specVersion: "1", objective: "add fn", context: "ctx", writeAllowlist: ["src/**"], forbiddenScope: [],
    successCriteria: ["compiles"],
    verification: [{
      id: "check",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 60000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 600000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
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
  it("accepts non-empty reviewer focus guidance", () => {
    const spec = {
      ...makeValidSpec(),
      review: {
        reviewers: ["correctness"],
        maxRounds: 1,
        focus: ["Check cancellation cleanup on Windows."],
      },
    };
    expect(validateSpec(spec).ok).toBe(true);
  });
  it("rejects empty or malformed reviewer focus guidance", () => {
    expect(validateSpec({
      ...makeValidSpec(),
      review: { reviewers: ["systems"], maxRounds: 2, focus: [] },
    }).ok).toBe(false);
    expect(validateSpec({
      ...makeValidSpec(),
      review: { reviewers: ["systems"], maxRounds: 2, focus: [""] },
    }).ok).toBe(false);
    expect(validateSpec({
      ...makeValidSpec(),
      review: { reviewers: ["systems"], maxRounds: 2, notes: "unsupported" },
    }).ok).toBe(false);
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

describe("delegation spec implementation block", () => {
  it("preserves a spec without an implementation block byte-for-byte", () => {
    const spec = makeValidSpec();
    const originalBytes = JSON.stringify(spec);
    const result = validateSpec(spec);

    expect(result).toEqual({ ok: true, spec });
    if (!result.ok) return;
    expect(JSON.stringify(result.spec)).toBe(originalBytes);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "accepts maxIncrements %i",
    maxIncrements => {
      expect(validateSpec({
        ...makeValidSpec(),
        implementation: { maxIncrements },
      }).ok).toBe(true);
    },
  );

  it.each([
    { maxIncrements: 0 },
    { maxIncrements: 9 },
    { maxIncrements: 2.5 },
    { maxIncrements: "2" },
    { maxIncrements: 2, unexpected: true },
    {},
  ])("rejects an invalid implementation block: %j", implementation => {
    expect(validateSpec({ ...makeValidSpec(), implementation }).ok).toBe(false);
  });

  it("resolveImplementationConfig applies the default and spec value", () => {
    expect(resolveImplementationConfig(makeValidSpec() as never)).toEqual({
      maxIncrements: 1,
    });
    expect(resolveImplementationConfig({
      ...makeValidSpec(),
      implementation: { maxIncrements: 4 },
    } as never)).toEqual({ maxIncrements: 4 });
  });
});
