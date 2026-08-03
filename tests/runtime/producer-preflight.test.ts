import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import { CodexAdapter } from "../../src/producers/codex-adapter.js";
import type {
  CapabilityReport,
  ProducerAdapter,
} from "../../src/producers/producer-adapter.js";
import {
  PREFLIGHT_PROBE_FILE,
  preflightExecutables,
  preflightProbeCommand,
  readProbe,
  redactedProbeEvidence,
  runProducerPreflight,
} from "../../src/runtime/producer-preflight.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";

const execFileAsync = promisify(execFile);

function spec(executables: string[]): DelegationSpec {
  return {
    specVersion: "1",
    objective: "objective",
    context: "context",
    writeAllowlist: ["src/**"],
    forbiddenScope: [],
    successCriteria: ["done"],
    verification: executables.map((executable, index) => ({
      id: `check-${index}`,
      executable,
      args: ["--version"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied" as const,
      expectedExitCodes: [0],
    })),
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

describe("producer preflight", () => {
  it("probes each distinct executable once, in a stable order", () => {
    expect(preflightExecutables(spec(["npx", "node", "npx"]))).toEqual(["node", "npx"]);
  });

  it("refuses to inline an executable that is not shell-safe", () => {
    // Independent verification still covers these; the probe must not become an
    // injection point for a path- or metacharacter-bearing name.
    expect(preflightExecutables(spec(["/usr/bin/node", "a;rm -rf /", "node"]))).toEqual(["node"]);
  });

  it("redirects every probe into the file the runtime reads", () => {
    const command = preflightProbeCommand(["node", "git"]);

    expect(command).toContain(`> ${PREFLIGHT_PROBE_FILE}`);
    expect(command).toContain("command -v node");
    expect(command).toContain("command -v git");
  });

  it("treats a resolved path as present", () => {
    expect(readProbe("node /usr/bin/node\ngit /usr/bin/git\n", ["node", "git"])).toEqual([]);
  });

  it("reports an executable the shell could not resolve", () => {
    expect(readProbe("node MISSING\ngit /usr/bin/git\n", ["node", "git"])).toEqual(["node"]);
  });

  it("reports an executable the probe never mentioned", () => {
    expect(readProbe("git /usr/bin/git\n", ["node", "git"])).toEqual(["node"]);
  });

  it("ignores shell noise around the probe lines", () => {
    const contents = [
      "/Users/someone/.zshenv:14: command not found: cat",
      "node /opt/node/bin/node",
      "",
      "git /usr/bin/git",
    ].join("\n");

    expect(readProbe(contents, ["node", "git"])).toEqual([]);
  });

  it("bounds and redacts untrusted probe evidence before archival", () => {
    const token = `ghp_${"a".repeat(40)}`;
    const evidence = redactedProbeEvidence(
      `node /Users/private/person/bin/node\nTOKEN=${token}\n${"x".repeat(20_000)}`,
    );

    expect(evidence).not.toContain("/Users/private/person");
    expect(evidence).not.toContain(token);
    expect(Buffer.byteLength(evidence)).toBeLessThanOrEqual(16 * 1024);
  });

  it("does not accept a bare name as a resolution", () => {
    // `command -v` printing nothing leaves the trailing name alone on the line;
    // that is a miss, not a hit.
    expect(readProbe("node \ngit /usr/bin/git", ["node", "git"])).toEqual(["node"]);
  });

  it("preserves cancellation when managed cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "producer-preflight-cancelled-"));
    const repoRoot = join(root, "repo");
    const worktreePath = join(root, "worktree");
    await Promise.all([mkdir(repoRoot), mkdir(worktreePath)]);
    const executable = {
      kind: "native" as const,
      command: process.execPath,
      prefixArgs: [],
      resolvedFrom: "test",
    };
    const adapter = {
      buildInvocation() {
        return {
          executable,
          args: ["-e", ""],
          requiredEnv: [],
          network: "denied" as const,
        };
      },
    } as unknown as ProducerAdapter;
    const capabilityReport = {
      resolvedExecutable: executable,
      writeConfinementBackend: null,
    } as unknown as CapabilityReport;
    const ps = Object.create(new PosixPlatformServices()) as PosixPlatformServices;
    ps.spawnSupervised = async () => ({
      pid: 42_424,
      done: Promise.resolve({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
        stdout: "",
        stderr: "",
        truncated: { stdout: false, stderr: false },
      }),
      stdout: Readable.from([]),
      stderr: Readable.from([]),
    });

    try {
      await expect(runProducerPreflight({
        adapter,
        capabilityReport,
        spec: spec(["node"]),
        repoRoot,
        baseCommitOid: "a".repeat(40),
        runId: "preflight-cancelled-cleanup-failure",
        ps,
        tempHome: null,
        worktreeManager: {
          async create() {
            return {
              path: worktreePath,
              async cleanup() { throw new Error("simulated cleanup failure"); },
            };
          },
        },
      })).resolves.toMatchObject({
        status: "inconclusive",
        reason: "cancelled",
        cleanupFailure: expect.stringContaining("simulated cleanup failure"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates managed cleanup failure instead of recursively deleting the worktree", async () => {
    const probeError = new Error("simulated probe failure");
    const cleanupError = new Error("simulated managed cleanup failure");
    const adapter = {
      buildInvocation() { throw probeError; },
    } as unknown as ProducerAdapter;
    const capabilityReport = {
      resolvedExecutable: {
        kind: "native",
        command: process.execPath,
        prefixArgs: [],
        resolvedFrom: "test",
      },
    } as unknown as CapabilityReport;

    let observed: unknown;
    try {
      await runProducerPreflight({
        adapter,
        capabilityReport,
        spec: spec(["node"]),
        repoRoot: "/definitely/missing/repository",
        baseCommitOid: "a".repeat(40),
        runId: "preflight-cleanup-failure",
        ps: new PosixPlatformServices(),
        tempHome: null,
        worktreeManager: {
          async create() {
            return {
              path: "/definitely/missing/worktree",
              async cleanup() { throw cleanupError; },
            };
          },
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors).toEqual([probeError, cleanupError]);
  });

  it("preserves a missing probe-file failure when managed cleanup also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "producer-preflight-missing-probe-"));
    const repoRoot = join(root, "repo");
    const worktreePath = join(root, "worktree");
    await Promise.all([mkdir(repoRoot), mkdir(worktreePath)]);
    const cleanupError = new Error("simulated cleanup failure after missing probe");
    const executable = {
      kind: "native" as const,
      command: process.execPath,
      prefixArgs: [],
      resolvedFrom: "test",
    };
    const adapter = {
      buildInvocation() {
        return {
          executable,
          args: ["-e", ""],
          requiredEnv: [],
          network: "denied" as const,
        };
      },
    } as unknown as ProducerAdapter;
    const capabilityReport = {
      resolvedExecutable: executable,
      writeConfinementBackend: null,
    } as unknown as CapabilityReport;

    try {
      let observed: unknown;
      try {
        await runProducerPreflight({
          adapter,
          capabilityReport,
          spec: spec(["node"]),
          repoRoot,
          baseCommitOid: "a".repeat(40),
          runId: "preflight-missing-probe-cleanup-failure",
          ps: new PosixPlatformServices(),
          tempHome: null,
          worktreeManager: {
            async create() {
              return {
                path: worktreePath,
                async cleanup() { throw cleanupError; },
              };
            },
          },
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(AggregateError);
      const errors = (observed as AggregateError).errors;
      expect(errors[0]).toMatchObject({ code: "ENOENT" });
      expect(errors[1]).toBe(cleanupError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(
    process.platform === "win32"
      || process.env.RUN_CODEX_PREFLIGHT_GATE !== "1",
  )(
    "proves the probe runs in the Producer's own shell against real Codex",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-preflight-gate-"));
      const repoRoot = join(root, "repo");
      const tempHome = join(root, "home");
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(process.env.HOME ?? "", ".codex");
      }
      try {
        await execFileAsync("mkdir", ["-p", repoRoot, tempHome]);
        await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
        await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "base"], {
          cwd: repoRoot,
        });
        const baseCommitOid = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }))
          .stdout.trim();
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const capabilityReport = await adapter.probe({
          ps,
          os: process.platform === "darwin" ? "darwin" : "linux",
          arch: process.arch,
          environmentType: "native",
        });
        expect(capabilityReport.resolvedExecutable).not.toBeNull();
        if (capabilityReport.resolvedExecutable === null) return;

        const resolvable = await runProducerPreflight({
          adapter,
          capabilityReport,
          spec: spec(["node", "git"]),
          repoRoot,
          baseCommitOid,
          runId: "preflight-gate-ok",
          ps,
          tempHome,
        });
        expect(resolvable.status, JSON.stringify(resolvable)).toBe("ok");

        // The discriminating half: an executable that genuinely is not there
        // must be reported, or a green probe means nothing.
        const absent = await runProducerPreflight({
          adapter,
          capabilityReport,
          spec: spec(["node", "definitely-not-installed-xyzzy"]),
          repoRoot,
          baseCommitOid,
          runId: "preflight-gate-missing",
          ps,
          tempHome,
        });
        expect(absent.status, JSON.stringify(absent)).toBe("environment-defect");
        expect(absent.missing).toEqual(["definitely-not-installed-xyzzy"]);
      } finally {
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(root, { recursive: true, force: true });
      }
    },
    420_000,
  );
});
