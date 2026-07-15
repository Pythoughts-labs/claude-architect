import { describe, expect, it } from "vitest";
import {
  SANDBOX_BACKENDS,
  selectSandboxBackend,
} from "../../src/platform/sandbox/backends.js";
import type { CapabilityReport } from "../../src/producers/producer-adapter.js";

function report(overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    producerId: "codex",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: null,
    version: "1.0.0",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: "codex-native-sandbox",
    laneEligibility: { edit: true },
    ...overrides,
  };
}

describe("selectSandboxBackend", () => {
  it("selects the certified native Codex sandbox on Apple silicon", () => {
    expect(selectSandboxBackend(report())).toEqual({
      backend: SANDBOX_BACKENDS[0],
      state: "certified",
    });
  });

  it("selects the tested native Codex sandbox on Linux", () => {
    expect(selectSandboxBackend(report({ os: "linux", arch: "x64" }))).toEqual({
      backend: SANDBOX_BACKENDS[0],
      state: "tested",
    });
  });

  it("rejects the unsupported Windows backend", () => {
    expect(selectSandboxBackend(report({ os: "win32", arch: "x64" }))).toEqual({
      backend: null,
      reason: "no-write-confinement-backend",
    });
  });

  it("rejects a report without a backend", () => {
    expect(selectSandboxBackend(report({ writeConfinementBackend: null }))).toEqual({
      backend: null,
      reason: "no-write-confinement-backend",
    });
  });

  it("rejects an unrecognized backend", () => {
    expect(selectSandboxBackend(report({ writeConfinementBackend: "bogus-backend" }))).toEqual({
      backend: null,
      reason: "unrecognized-write-confinement-backend",
    });
  });
});
