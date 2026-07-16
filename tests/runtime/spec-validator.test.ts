import { describe, it, expect } from "vitest";
import { validateSpec } from "../../src/protocol/spec-validator.js";

const base = {
  specVersion: "1", objective: "add fn", context: "ctx", writeAllowlist: ["src/**"], forbiddenScope: [],
  successCriteria: ["compiles"], verification: [], executionMode: "edit",
  timeoutMs: 60000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};
describe("validateSpec", () => {
  it("accepts a valid spec", () => expect(validateSpec(base).ok).toBe(true));
  it("rejects a spec missing forbiddenScope", () => {
    const { forbiddenScope, ...noScope } = base;
    expect(validateSpec(noScope).ok).toBe(false);
  });
  it("rejects empty writeAllowlist", () => {
    const r = validateSpec({ ...base, writeAllowlist: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path.includes("writeAllowlist"))).toBe(true);
  });
  it("rejects over-ceiling timeout", () =>
    expect(validateSpec({ ...base, timeoutMs: 9_000_000 }).ok).toBe(false));
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
});
