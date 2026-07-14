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
    expect(
      v.attemptResult({
        resultVersion: "1",
        status: "verified-candidate",
        failure: null,
      }),
    ).toBe(true);
  });

  it("rejects an attempt result with a wrong status value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({
        resultVersion: "1",
        status: "nope",
        failure: null,
      }),
    ).toBe(false);
  });

  it("rejects an attempt result with a wrong failure value", () => {
    const v = loadSchemas();
    expect(
      v.attemptResult({
        resultVersion: "1",
        status: "verified-candidate",
        failure: "nope",
      }),
    ).toBe(false);
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
