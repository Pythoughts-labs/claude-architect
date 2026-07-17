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
    writeConfinementBackend: "macos-seatbelt",
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

    expect(route(["pi", "codex"], reports)).toEqual({
      producerId: "codex",
      considered: [
        { producerId: "pi", outcome: "ineligible", detail: "missing-executable" },
        { producerId: "codex", outcome: "selected", detail: null },
      ],
    });
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
      considered: [
        {
          producerId: "pi",
          outcome: "authentication-required",
          detail: "authentication-required",
        },
      ],
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
      considered: [
        {
          producerId: "pi",
          outcome: "ineligible",
          detail: "laneEligibility.edit=false",
        },
        {
          producerId: "codex",
          outcome: "ineligible",
          detail: "laneEligibility.edit=false",
        },
      ],
    });
  });

  it("selects the first eligible producer in host preference order", () => {
    expect(route(["pi", "codex"], [report("codex"), report("pi")])).toEqual({
      producerId: "pi",
      considered: [
        { producerId: "pi", outcome: "selected", detail: null },
      ],
    });
  });

  it.each([
    ["is unavailable", { available: false }, "available=false"],
    ["has no resolved executable", { resolvedExecutable: null }, "resolvedExecutable=null"],
  ] satisfies Array<[string, Partial<CapabilityReport>, string]>) (
    "falls through when edit eligibility is true but the report %s",
    (_description, overrides, detail) => {
      expect(route(["pi", "codex"], [report("pi", overrides), report("codex")])).toEqual({
        producerId: "codex",
        considered: [
          { producerId: "pi", outcome: "ineligible", detail },
          { producerId: "codex", outcome: "selected", detail: null },
        ],
      });
    },
  );

  it("reports a considered trail for an ineligible preferred producer", () => {
    const reports = [
      report("pythinker", { laneEligibility: { edit: false }, reason: "no write-confinement backend" }),
      report("codex"),
    ];
    const result = route(["pythinker"], reports);
    expect(result.producerId).toBeNull();
    expect(result.considered).toEqual([
      {
        producerId: "pythinker",
        outcome: "ineligible",
        detail: "no write-confinement backend",
      },
    ]);
  });

  it("reports unknown-producer for a preference with no capability report", () => {
    const result = route(["ghost"], []);
    expect(result.producerId).toBeNull();
    expect(result.considered).toEqual([
      { producerId: "ghost", outcome: "unknown-producer", detail: null },
    ]);
  });

  it("marks the selected producer in the considered trail", () => {
    const reports = [report("codex")];
    const result = route(["codex"], reports);
    expect(result.producerId).toBe("codex");
    expect(result.considered).toEqual([
      { producerId: "codex", outcome: "selected", detail: null },
    ]);
  });
});
