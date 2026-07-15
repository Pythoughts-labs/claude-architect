import { describe, expect, it } from "vitest";
import {
  formatMissingNodeDiagnostic,
  isNodeSupported,
} from "../../src/mcp/bootstrap-check.js";

describe("bootstrap version checks", () => {
  it("accepts Node.js 22 and newer", () => {
    expect(isNodeSupported("v22.1.0")).toBe(true);
    expect(isNodeSupported("22.0.0")).toBe(true);
    expect(isNodeSupported("v26.3.1")).toBe(true);
  });

  it("rejects older and malformed versions", () => {
    expect(isNodeSupported("v20.19.0")).toBe(false);
    expect(isNodeSupported("21.99.0")).toBe(false);
    expect(isNodeSupported("not-a-version")).toBe(false);
  });

  it("returns an actionable missing-runtime diagnostic", () => {
    const diagnostic = formatMissingNodeDiagnostic();

    expect(diagnostic).toContain("Node.js 22");
    expect(diagnostic).toContain("PATH");
  });
});
