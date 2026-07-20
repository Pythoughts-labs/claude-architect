import { describe, expect, it } from "vitest";

import { validateSpec } from "../../../src/protocol/spec-validator.js";

const verification = {
  id: "check",
  executable: "node",
  args: ["--version"],
  cwd: ".",
  timeoutMs: 60_000,
  network: "denied",
  expectedExitCodes: [0],
};

const baseSpec = {
  specVersion: "1",
  objective: "Validate slice boundaries",
  context: "Protocol validation test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["Slice boundaries are enforced"],
  verification: [verification],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

function slice(writeAllowlist: string[], cwd = ".") {
  return {
    objective: "Implement a slice",
    context: "Slice context",
    writeAllowlist,
    forbiddenScope: [],
    successCriteria: ["The slice passes"],
    verification: [{ ...verification, cwd }],
  };
}

describe("validateSpec slice semantics", () => {
  it("accepts a slice writeAllowlist within the top-level writeAllowlist", () => {
    expect(validateSpec({
      ...baseSpec,
      slices: [slice(["src/a/**"])],
    }).ok).toBe(true);
  });

  it("rejects a slice writeAllowlist that widens the top-level writeAllowlist", () => {
    const result = validateSpec({
      ...baseSpec,
      slices: [slice(["tests/**"])],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/slices/0/writeAllowlist/0");
    }
  });

  it("rejects a slice verification cwd that escapes the checkout", () => {
    const result = validateSpec({
      ...baseSpec,
      slices: [slice(["src/a/**"], "../etc")],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("/slices/0/verification/0/cwd");
    }
  });

  it("validates per-slice allowedTestDeletions path safety", () => {
    expect(validateSpec({
      ...baseSpec,
      slices: [{ ...slice(["src/a/**"]), allowedTestDeletions: ["tests/old/**"] }],
    }).ok).toBe(true);

    const result = validateSpec({
      ...baseSpec,
      slices: [{ ...slice(["src/a/**"]), allowedTestDeletions: ["../tests/**"] }],
    });
    expect(result).toEqual({
      ok: false,
      errors: [{
        path: "/slices/0/allowedTestDeletions/0",
        message: "must be a non-empty repository-relative glob without traversal",
      }],
    });
  });
});
