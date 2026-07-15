import { describe, expect, it } from "vitest";
import type { CapabilityReport } from "../../src/producers/producer-adapter.js";
import { route } from "../../src/producers/routing-policy.js";

function report(
  producerId: string,
  overrides: Partial<CapabilityReport> = {},
): CapabilityReport {
  return {
    producerId,
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: {
      kind: "native",
      command: `/usr/local/bin/${producerId}`,
      prefixArgs: [],
      resolvedFrom: "test",
    },
    version: "1.0.0",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: `${producerId}-sandbox`,
    laneEligibility: { edit: true },
    ...overrides,
  };
}

describe("route", () => {
  it("falls through ordinary unavailability to the next eligible preference", () => {
    const reports = [
      report("pi", {
        available: false,
        reason: "missing-executable",
        resolvedExecutable: null,
        version: null,
        writeConfinementBackend: null,
        laneEligibility: { edit: false },
      }),
      report("codex"),
    ];

    expect(route(["pi", "codex"], reports)).toEqual({ producerId: "codex" });
  });

  it("stops without fallback when the first matching preference needs authentication", () => {
    const reports = [
      report("pi", {
        available: false,
        reason: "authentication-required",
        authState: "unauthenticated",
        resolvedExecutable: null,
        version: null,
        writeConfinementBackend: null,
        laneEligibility: { edit: false },
      }),
      report("codex"),
    ];

    expect(route(["pi", "codex"], reports)).toEqual({
      producerId: null,
      reason: "authentication-required",
    });
  });

  it("reports no eligible producer when every preference is ineligible", () => {
    const reports = [
      report("pi", { laneEligibility: { edit: false } }),
      report("codex", { laneEligibility: { edit: false } }),
    ];

    expect(route(["pi", "codex"], reports)).toEqual({
      producerId: null,
      reason: "no-eligible-producer",
    });
  });

  it("selects the first eligible producer in host preference order", () => {
    expect(route(["pi", "codex"], [report("codex"), report("pi")])).toEqual({
      producerId: "pi",
    });
  });
});
