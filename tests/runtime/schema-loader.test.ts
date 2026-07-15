import { describe, it, expect } from "vitest";
import { loadSchemas, checkVersionCompat } from "../../src/protocol/schema-loader.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";

const validDelegationSpec = {
  specVersion: "1",
  objective: "do the thing",
  context: "some context",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["ok"],
  verification: [],
  executionMode: "edit",
  timeoutMs: 60000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

const validAttemptResult = {
  resultVersion: "1",
  runId: "run-schema",
  status: "failed",
  failure: "producer-failure",
  summary: "producer failed",
  producerSummary: null,
  candidate: null,
  requestedVerification: [],
  executedVerification: [],
  unresolvedIssues: [],
  evidence: {},
  logsRef: "logs/producer.log",
  producerId: "codex",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};

describe("schema loader", () => {
  it("compiles delegation-spec and attempt-result validators", () => {
    const v = loadSchemas();
    expect(typeof v.delegationSpec).toBe("function");
    expect(typeof v.attemptResult).toBe("function");
    expect(v.delegationSpec({ specVersion: "1" })).toBe(false); // missing required fields
  });

  it("accepts a valid, fully-populated delegation spec", () => {
    const v = loadSchemas();
    expect(v.delegationSpec(validDelegationSpec)).toBe(true);
  });

  it("rejects a delegation spec with a wrong const value", () => {
    const v = loadSchemas();
    expect(
      v.delegationSpec({ ...validDelegationSpec, expectedOutput: "wrong" }),
    ).toBe(false);
  });

  it("accepts a valid attempt result", () => {
    const v = loadSchemas();
    expect(v.attemptResult(validAttemptResult)).toBe(true);
  });

  it("rejects an attempt result with a wrong status value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({ ...validAttemptResult, status: "nope" }),
    ).toBe(false);
  });

  it("rejects an attempt result with a wrong failure value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({ ...validAttemptResult, failure: "nope" }),
    ).toBe(false);
  });

  it("rejects incomplete and contradictory attempt results", () => {
    const v = loadSchemas();
    const { runId, ...missingRunId } = validAttemptResult;
    expect(v.attemptResult(missingRunId)).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      status: "verified-candidate",
      failure: "verification-failure",
    })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      status: "failed",
      failure: null,
    })).toBe(false);
    const preservedCandidate = {
      baseCommitOid: "1".repeat(40),
      candidateTreeOid: "2".repeat(40),
      candidateCommitOid: "3".repeat(40),
      anchorRef: "refs/claude-architect/candidates/run-schema",
      manifestHash: "4".repeat(64),
      changedPaths: [],
      patch: "",
    };
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "spawn-failure",
      candidate: preservedCandidate,
    })).toBe(false);
    expect(v.attemptResult({
      ...validAttemptResult,
      failure: "verification-failure",
      candidate: preservedCandidate,
    })).toBe(true);
  });
});

describe("checkVersionCompat", () => {
  it("reports ok for a matching protocol version", () => {
    const result = checkVersionCompat(PROTOCOL_VERSION);
    expect(result).toEqual({ ok: true });
  });

  it("reports a diagnostic for a mismatched protocol version", () => {
    const result = checkVersionCompat("0.0.1");
    expect(result.ok).toBe(false);
    expect(typeof result.diagnostic).toBe("string");
    expect((result.diagnostic as string).length).toBeGreaterThan(0);
  });
});
