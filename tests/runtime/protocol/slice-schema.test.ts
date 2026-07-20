import { describe, expect, it } from "vitest";

import { loadSchemas } from "../../../src/protocol/schema-loader.js";

const verification = {
  id: "slice-check",
  executable: "node",
  args: ["--version"],
  cwd: ".",
  timeoutMs: 60_000,
  network: "denied",
  expectedExitCodes: [0],
};

const validSpec = {
  specVersion: "1",
  objective: "Implement sliced delegation",
  context: "Contract test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["All slices pass"],
  verification: [verification],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

describe("delegation spec slice schema", () => {
  it("accepts slices and per-slice review", () => {
    const validate = loadSchemas().delegationSpec;

    expect(validate({
      ...validSpec,
      allowedTestDeletions: ["tests/legacy/**"],
      slices: [{
        objective: "Implement the first slice",
        context: "Slice context",
        writeAllowlist: ["src/slice.ts"],
        allowedTestDeletions: ["tests/slice/**"],
        forbiddenScope: ["runtime/**"],
        successCriteria: ["The slice passes"],
        verification: [verification],
      }],
      review: {
        reviewers: ["correctness"],
        maxRounds: 1,
        perSlice: true,
      },
    })).toBe(true);
  });

  it("rejects non-string and empty allowedTestDeletions entries", () => {
    const validate = loadSchemas().delegationSpec;

    expect(validate({ ...validSpec, allowedTestDeletions: [42] })).toBe(false);
    expect(validate({
      ...validSpec,
      slices: [{
        objective: "Implement the first slice",
        context: "Slice context",
        writeAllowlist: ["src/slice.ts"],
        allowedTestDeletions: [""],
        forbiddenScope: [],
        successCriteria: ["The slice passes"],
        verification: [verification],
      }],
    })).toBe(false);
  });

  it("rejects a slice with no verification commands", () => {
    const validate = loadSchemas().delegationSpec;

    expect(validate({
      ...validSpec,
      slices: [{
        objective: "Implement the first slice",
        context: "Slice context",
        writeAllowlist: ["src/slice.ts"],
        forbiddenScope: ["runtime/**"],
        successCriteria: ["The slice passes"],
        verification: [],
      }],
    })).toBe(false);
  });

  it("continues to accept specs without slices", () => {
    expect(loadSchemas().delegationSpec(validSpec)).toBe(true);
  });
});
