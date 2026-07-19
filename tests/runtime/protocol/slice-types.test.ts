import { describe, expect, it } from "vitest";

import { resolveSlices, type DelegationSpec } from "../../../src/protocol/delegation-spec.js";

const specWithoutSlices: DelegationSpec = {
  specVersion: "1",
  objective: "Delegate an implementation",
  context: "Test context",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["The implementation succeeds"],
  verification: [],
  executionMode: "edit",
  timeoutMs: 600_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

describe("resolveSlices", () => {
  it("returns an empty array when slices are absent", () => {
    expect(resolveSlices(specWithoutSlices)).toEqual([]);
  });

  it("returns configured slices", () => {
    const specWithOneSlice: DelegationSpec = {
      ...specWithoutSlices,
      slices: [
        {
          objective: "Implement the first slice",
          context: "Slice context",
          writeAllowlist: ["src/first.ts"],
          forbiddenScope: ["runtime/**"],
          successCriteria: ["The first slice succeeds"],
          verification: [],
        },
      ],
    };

    expect(resolveSlices(specWithOneSlice)).toHaveLength(1);
    expect(resolveSlices(specWithOneSlice)[0]?.objective).toBe("Implement the first slice");
  });
});
