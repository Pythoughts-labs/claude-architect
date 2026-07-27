import { describe, expect, it } from "vitest";
import {
  decideCandidateInputSchema,
  delegateInputSchema,
  delegatePipelineInputSchema,
  integrateCandidateInputSchema,
  reviewCandidateInputSchema,
} from "../../src/mcp/server.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";

const validInput = {
  checkoutPath: "/repo",
  spec: { specVersion: "1" },
  protocolVersion: PROTOCOL_VERSION,
};

describe.each([
  ["delegate", delegateInputSchema],
  ["delegatePipeline", delegatePipelineInputSchema],
])("%s MCP input", (_name, schema) => {
  it("requires the exact protocol version", () => {
    expect(schema.safeParse(validInput).success).toBe(true);

    // Assert each case names what it actually received. An alternation over
    // both spellings would pass even if the two branches collapsed into one —
    // and they are separate branches in the error map, so a regression there
    // would otherwise be invisible.
    for (const [input, received] of [
      [{ checkoutPath: "/repo", spec: {} }, "(missing)"],
      [{ ...validInput, protocolVersion: "1.0.0" }, "1.0.0"],
    ] as const) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const diagnostic = result.error.issues.map(issue => issue.message).join("\n");
      expect(diagnostic).toContain(
        `protocol version mismatch: received ${received}, expected ${PROTOCOL_VERSION}`,
      );
    }
  });

  it("rejects unknown input keys", () => {
    const result = schema.safeParse({ ...validInput, protocolVersions: PROTOCOL_VERSION });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });
});

describe.each([
  ["reviewCandidate", reviewCandidateInputSchema, { runId: "run-test" }],
  ["decideCandidate", decideCandidateInputSchema, {
    runId: "run-test",
    decision: "accepted",
  }],
  ["integrateCandidate", integrateCandidateInputSchema, {
    runId: "run-test",
    expectedArtifactHash: "a".repeat(64),
  }],
])("%s MCP input", (_name, schema, input) => {
  it("requires checkoutPath", () => {
    expect(schema.safeParse({ checkoutPath: "/repo", ...input }).success).toBe(true);
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown input keys", () => {
    const result = schema.safeParse({ checkoutPath: "/repo", ...input, checkoutPaths: ["/repo"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });
});
