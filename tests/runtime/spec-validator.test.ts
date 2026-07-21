import { describe, it, expect } from "vitest";
import delegationSpecSchema from "../../runtime/schemas/delegation-spec.v1.json" with { type: "json" };
import { RUNTIME_MIN_EDIT_TIMEOUT_MS } from "../../src/protocol/delegation-spec.js";
import { validateSpec } from "../../src/protocol/spec-validator.js";

const base = {
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
describe("validateSpec", () => {
  it("accepts a valid spec", () => expect(validateSpec(base).ok).toBe(true));
  it("validates verification command cwd within the checkout", () => {
    expect(validateSpec({
      ...base,
      verification: [{ ...base.verification[0], cwd: "src/runtime" }],
    }).ok).toBe(true);

    for (const cwd of ["/absolute/path", "../escape"]) {
      expect(validateSpec({
        ...base,
        verification: [{ ...base.verification[0], cwd }],
      })).toEqual({
        ok: false,
        errors: [{
          path: "/verification/0/cwd",
          message: "must be a repository-relative path that does not escape the checkout",
        }],
      });
    }
  });
  it("accepts a per-command baseline-failure opt-out and rejects the removed top-level field", () => {
    expect(validateSpec({
      ...base,
      verification: [{ ...base.verification[0], expectBaselineFailure: true }],
    }).ok).toBe(true);
    expect(validateSpec({ ...base, expectBaselineFailure: true }).ok).toBe(false);
  });
  it("rejects unknown properties at every delegation object boundary", () => {
    expect(validateSpec({ ...base, unexpected: true }).ok).toBe(false);
    expect(validateSpec({
      ...base,
      verification: [{ ...base.verification[0], unexpected: true }],
    }).ok).toBe(false);
    expect(validateSpec({
      ...base,
      producerOverrides: { model: "test", unexpected: true },
    }).ok).toBe(false);
  });
  it("rejects a spec missing forbiddenScope", () => {
    const { forbiddenScope, ...noScope } = base;
    expect(validateSpec(noScope).ok).toBe(false);
  });
  it("rejects empty writeAllowlist", () => {
    const r = validateSpec({ ...base, writeAllowlist: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path.includes("writeAllowlist"))).toBe(true);
  });
  it("accepts safe allowedTestDeletions and rejects unsafe or malformed entries", () => {
    expect(validateSpec({
      ...base,
      allowedTestDeletions: ["tests/removed/**/*.test.ts"],
    }).ok).toBe(true);
    expect(validateSpec({ ...base, allowedTestDeletions: [] }).ok).toBe(true);

    for (const glob of ["", "/tests/foo.test.ts", "../foo.test.ts", "tests/../foo.test.ts", "C:\\tests\\foo.test.ts"]) {
      const result = validateSpec({ ...base, allowedTestDeletions: [glob] });
      expect(result.ok, glob).toBe(false);
    }
    expect(validateSpec({ ...base, allowedTestDeletions: [42] }).ok).toBe(false);
  });
  it("rejects over-ceiling timeout", () =>
    expect(validateSpec({ ...base, timeoutMs: 9_000_000 }).ok).toBe(false));
  it("rejects edit specs below the timeout floor and accepts the floor", () => {
    expect(validateSpec({ ...base, timeoutMs: RUNTIME_MIN_EDIT_TIMEOUT_MS - 1 })).toEqual({
      ok: false,
      errors: [{
        path: "/timeoutMs",
        message: "must be at least 600000ms for edit-mode specs",
      }],
    });
    expect(validateSpec({ ...base, timeoutMs: RUNTIME_MIN_EDIT_TIMEOUT_MS }).ok).toBe(true);
  });
  it("keeps the validator timeout floor aligned with the schema edit minimum", () => {
    const schemaEditTimeoutMinimum = delegationSpecSchema.allOf[0]
      .then.properties.timeoutMs.minimum;

    expect(schemaEditTimeoutMinimum).toBe(600_000);
    expect(RUNTIME_MIN_EDIT_TIMEOUT_MS).toBe(600_000);
    expect(RUNTIME_MIN_EDIT_TIMEOUT_MS).toBe(schemaEditTimeoutMinimum);
  });
  it("ignores the timeout-floor override outside tests", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVitest = process.env.VITEST;
    const previousOverride = process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
    try {
      process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = "1";
      for (const nodeEnv of [undefined, "", "development", "production"]) {
        if (nodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnv;
        for (const vitestValue of ["false", "", "1", "unrelated"]) {
          process.env.VITEST = vitestValue;
          expect(validateSpec({ ...base, timeoutMs: 1 }).ok).toBe(false);
        }
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
      if (previousOverride === undefined) delete process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
      else process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = previousOverride;
    }
  });
  it("honors the timeout-floor override during tests", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOverride = process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
    try {
      process.env.NODE_ENV = "test";
      process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = "1";
      expect(validateSpec({ ...base, timeoutMs: 1 }).ok).toBe(true);
      expect(validateSpec({ ...base, timeoutMs: 1.5 }).ok).toBe(false);
      expect(validateSpec({ ...base, timeoutMs: 1, unexpected: true }).ok).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousOverride === undefined) delete process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
      else process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = previousOverride;
    }
  });
  it("rejects a non-integer test timeout-floor override", () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousOverride = process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
    try {
      process.env.NODE_ENV = "test";
      process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = "1.5";
      expect(validateSpec({ ...base, timeoutMs: 1 }).ok).toBe(false);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousOverride === undefined) delete process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
      else process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS = previousOverride;
    }
  });
  it("rejects non-positive attempt and verification timeouts", () => {
    expect(validateSpec({ ...base, timeoutMs: 0 }).ok).toBe(false);
    expect(validateSpec({ ...base, timeoutMs: -1 }).ok).toBe(false);
    expect(validateSpec({
      ...base,
      verification: [{
        id: "check",
        executable: "node",
        args: [],
        cwd: ".",
        timeoutMs: 0,
        network: "denied",
        expectedExitCodes: [0],
      }],
    }).ok).toBe(false);
  });
  it("rejects non-edit executionMode", () =>
    expect(validateSpec({ ...base, executionMode: "review" }).ok).toBe(false));
  it("lists allowed values for enum validation errors", () => {
    const result = validateSpec({
      ...base,
      verification: [{
        id: "check",
        executable: "npm",
        args: ["test"],
        cwd: ".",
        timeoutMs: 60000,
        network: "deny",
        expectedExitCodes: [0],
      }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find(e => e.path.includes("network"));
    expect(error?.message).toContain("allowed values: ");
    expect(error?.message).toContain("denied");
  });
  it("rejects empty successCriteria", () => {
    const result = validateSpec({ ...base, successCriteria: [] });
    expect(result.ok).toBe(false);
  });
  it("rejects empty verification", () => {
    const result = validateSpec({ ...base, verification: [] });
    expect(result.ok).toBe(false);
  });
  it("rejects an empty objective", () => {
    const result = validateSpec({ ...base, objective: "" });
    expect(result.ok).toBe(false);
  });
});
