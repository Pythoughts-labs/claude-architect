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

    for (const input of [
      { checkoutPath: "/repo", spec: {} },
      { ...validInput, protocolVersion: "1.0.0" },
    ]) {
      const result = schema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) continue;
      const diagnostic = result.error.issues.map(issue => issue.message).join("\n");
      expect(diagnostic).toContain("protocol version mismatch");
      expect(diagnostic).toContain(`expected ${PROTOCOL_VERSION}`);
      expect(diagnostic).toMatch(/received (?:1\.0\.0|\(missing\))/u);
    }
  });

  it("rejects unknown input keys", () => {
    const result = schema.safeParse({ ...validInput, protocolVersions: PROTOCOL_VERSION });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("diagnoses the previous 1.3.0 protocol and names expected 2.0.0", () => {
    const result = schema.safeParse({ ...validInput, protocolVersion: "1.3.0" });

    expect(result.success).toBe(false);
    if (result.success) return;
    const diagnostic = result.error.issues.map(issue => issue.message).join("\n");
    expect(diagnostic).toContain("protocol version mismatch");
    expect(diagnostic).toContain("received 1.3.0");
    expect(diagnostic).toContain("expected 2.0.0");
  }, 5_000);
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
