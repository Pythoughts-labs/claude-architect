import { describe, expect, it } from "vitest";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { CapabilityReport } from "../../src/producers/producer-adapter.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
} from "../../src/protocol/versions.js";
import { doctor } from "../../src/mcp/doctor.js";

function platform(os: "darwin" | "win32"): PlatformServices {
  return { os } as PlatformServices;
}

function codexReport(os: "darwin" | "win32"): CapabilityReport {
  const available = os === "darwin";
  return {
    producerId: "codex",
    available,
    reason: available ? null : "unsupported-platform",
    os,
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: null,
    version: available ? "0.144.4" : null,
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: available ? "codex-native-sandbox" : null,
    laneEligibility: { edit: available },
  };
}

describe("doctor", () => {
  it("reports runtime, Git, and Producer capability facts", async () => {
    const ps = platform("darwin");
    const result = await doctor({
      ps,
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      arch: "arm64",
      environmentType: "native",
      git: async (_cwd, args) => {
        expect(args).toEqual(["--version"]);
        return { stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 };
      },
      probeAll: async context => {
        expect(context).toMatchObject({ ps, os: "darwin", arch: "arm64" });
        return [codexReport("darwin")];
      },
    });

    expect(result).toEqual({
      node: { version: "22.17.0", ok: true },
      git: { version: "2.49.0", ok: true },
      producers: [codexReport("darwin")],
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: DELEGATION_SPEC_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      issues: [],
    });
  });

  it("always responds with unsupported-host and environment diagnostics", async () => {
    const result = await doctor({
      ps: platform("win32"),
      env: { CLAUDE_ARCHITECT_DELEGATED: "1" },
      nodeVersion: "22.17.0",
      arch: "x64",
      environmentType: "native",
      git: async () => {
        throw new Error("git sk-doctorsecret unavailable");
      },
      probeAll: async () => [codexReport("win32")],
    });

    expect(result.node).toEqual({ version: "22.17.0", ok: true });
    expect(result.git).toEqual({ version: null, ok: false });
    expect(result.producers).toEqual([codexReport("win32")]);
    expect(result.issues).toEqual(expect.arrayContaining([
      "unsupported-platform",
      "missing-claude-plugin-data",
      "nested-delegation-marker-present",
      "git-unavailable",
    ]));
    expect(JSON.stringify(result)).not.toContain("sk-doctorsecret");
  });
});
