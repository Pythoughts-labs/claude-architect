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
  return {
    os,
    resolveExecutable: async () => ({
      kind: "native",
      command: "/usr/local/bin/node",
      prefixArgs: [],
      resolvedFrom: "test",
    }),
    async spawnSupervised() { throw new Error("unexpected spawn"); },
    async requestCooperativeCancellation() { throw new Error("unexpected cancellation"); },
    async terminateProcessTree() { throw new Error("unexpected termination"); },
    async getProcessStartToken() { throw new Error("unexpected process token"); },
    async terminateProcessTreeByPid() { throw new Error("unexpected termination"); },
    async acquireCheckoutLock() { throw new Error("unexpected lock"); },
    async createSecureTempDirectory() { throw new Error("unexpected temp directory"); },
    async canonicalizePath() { throw new Error("unexpected canonicalization"); },
  };
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

const quietLiveBundle = {
  selfHosted: false,
  runningVersion: RUNTIME_VERSION,
  repositoryVersion: null,
  bundleMatches: null,
  stale: false,
} as const;

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
      probeCowSupport: async () => ({ cowSupported: true, strategy: "clonefile" }),
      checkLiveBundle: async () => quietLiveBundle,
    });

    expect(result).toEqual({
      node: { version: "22.17.0", ok: true },
      git: { version: "2.49.0", ok: true },
      producers: [codexReport("darwin")],
      sandboxBackends: [{
        id: "codex-native-sandbox",
        kind: "producer-native",
        state: "certified",
      }, {
        id: "macos-seatbelt",
        kind: "os",
        state: "certified",
      }],
      dependencyClone: { cowSupported: true, strategy: "clonefile" },
      liveBundle: quietLiveBundle,
      runtimeVersion: RUNTIME_VERSION,
      schemaVersion: DELEGATION_SPEC_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      issues: [],
    });
  });

  it("raises stale-live-bundle when delegating against a checkout the server predates", async () => {
    const result = await doctor({
      ps: platform("darwin"),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [],
      probeCowSupport: async () => ({ cowSupported: true, strategy: "clonefile" }),
      checkoutPath: "/repo",
      checkLiveBundle: async checkoutPath => {
        expect(checkoutPath).toBe("/repo");
        return {
          selfHosted: true,
          runningVersion: "0.27.0",
          repositoryVersion: "0.29.0",
          bundleMatches: false,
          stale: true,
        };
      },
    });

    expect(result.issues).toContain("stale-live-bundle");
    expect(result.liveBundle.repositoryVersion).toBe("0.29.0");
  });

  it("degrades to a probe-failed issue rather than failing when the check throws", async () => {
    const result = await doctor({
      ps: platform("darwin"),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [],
      probeCowSupport: async () => ({ cowSupported: true, strategy: "clonefile" }),
      checkLiveBundle: async () => {
        throw new Error("unreadable");
      },
    });

    expect(result.issues).toContain("live-bundle-probe-failed");
    expect(result.issues).not.toContain("stale-live-bundle");
    expect(result.liveBundle.stale).toBe(false);
  });

  it("reports a redacted issue when the dependency clone probe fails", async () => {
    const result = await doctor({
      ps: platform("darwin"),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [],
      probeCowSupport: async () => {
        throw new Error("probe failed under /Users/alice/private");
      },
    });

    expect(result.dependencyClone).toEqual({ cowSupported: false, strategy: "unsupported" });
    expect(result.issues).toContain("dependency-clone-probe-failed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("probe failed");
    expect(serialized).not.toContain("/Users/alice/private");
  });

  it("reports environment diagnostics on Windows without rejecting the platform", async () => {
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
    expect(result.issues).not.toContain("unsupported-platform");
    expect(result.issues).toEqual(expect.arrayContaining([
      "missing-claude-plugin-data",
      "nested-delegation-marker-present",
      "git-unavailable",
    ]));
    expect(JSON.stringify(result)).not.toContain("sk-doctorsecret");
  });

  it("reports unsupported for a sandbox backend without a matching host row", async () => {
    const result = await doctor({
      ps: platform("win32"),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      arch: "x64",
      environmentType: "wsl",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [],
    });

    expect(result.sandboxBackends).toEqual([{
      id: "codex-native-sandbox",
      kind: "producer-native",
      state: "unsupported",
    }, {
      id: "macos-seatbelt",
      kind: "os",
      state: "unsupported",
    }]);
  });

  it("reports when the host cannot resolve the initial Node executable", async () => {
    const ps = platform("darwin");
    ps.resolveExecutable = async () => {
      throw new Error("missing node");
    };

    const result = await doctor({
      ps,
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [],
    });

    expect(result.node).toEqual({ version: "22.17.0", ok: false });
    expect(result.issues).toContain("initial-node-unavailable");
  });

  it("redacts absolute home paths from Producer diagnostics", async () => {
    const report: CapabilityReport = {
      ...codexReport("darwin"),
      resolvedExecutable: {
        kind: "native",
        command: "/Users/alice/.local/bin/codex",
        prefixArgs: [
          "--config=/home/bob/.config/codex/config.json",
          "C:\\Users\\carol\\AppData\\Local\\codex\\launcher.js",
        ],
        resolvedFrom: "/home/dana/.local/bin/codex",
      },
    };

    const result = await doctor({
      ps: platform("darwin"),
      env: { CLAUDE_PLUGIN_DATA: "/plugin-data" },
      nodeVersion: "22.17.0",
      git: async () => ({ stdout: "git version 2.49.0\n", stderr: "", exitCode: 0 }),
      probeAll: async () => [report],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/\/Users\/alice|\/home\/(?:bob|dana)|C:\\\\Users\\\\carol/i);
    expect(serialized).toContain("codex");
    expect(serialized).toContain("config.json");
    expect(serialized).toContain("launcher.js");
  });
});
