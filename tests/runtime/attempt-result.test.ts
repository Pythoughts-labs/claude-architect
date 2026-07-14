import { describe, it, expect } from "vitest";
import { classifyFailure } from "../../src/protocol/attempt-result.js";
describe("classifyFailure", () => {
  it("honors precedence (sandbox before verification)", () =>
    expect(classifyFailure({ "sandbox-violation": true, "verification-failure": true })).toBe("sandbox-violation"));
  it("invalid-specification wins over everything", () =>
    expect(classifyFailure({ "invalid-specification": true, "producer-failure": true })).toBe("invalid-specification"));
  it("returns null when no signal set", () => expect(classifyFailure({})).toBeNull());
});
