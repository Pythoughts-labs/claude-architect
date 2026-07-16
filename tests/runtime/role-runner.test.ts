import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRole, type RoleRunArgs } from "../../src/pipeline/role-runner.js";
import type { PipelineRole, RolePackage } from "../../src/pipeline/role-prompts.js";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";

const REVIEW_OUTPUT = [
  "```json",
  JSON.stringify({
    reportVersion: "1",
    verdict: "approve",
    findings: [],
    coverageGaps: [],
  }),
  "```",
].join("\n");

const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "test",
};

interface FakeAdapterOptions {
  exitCode?: number;
  spawnFailure?: boolean;
  writeConfinementBackend?: string | null;
  cannedStdout?: string;
  failFirstAttempt?: boolean;
}

function capabilityReport(
  ctx: ProbeContext,
  options: FakeAdapterOptions,
): CapabilityReport {
  return {
    producerId: "fake",
    available: true,
    reason: null,
    os: ctx.os,
    arch: ctx.arch,
    environmentType: ctx.environmentType,
    resolvedExecutable: nodeExecutable,
    version: "1.0.0",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: options.writeConfinementBackend === undefined
      ? "macos-seatbelt"
      : options.writeConfinementBackend,
    laneEligibility: { edit: true },
  };
}

function supervisedExit(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: REVIEW_OUTPUT,
    stderr: "",
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";
  spawnCount = 0;
  invocationCount = 0;
  readonly tempHomes: string[] = [];
  readonly spawnedCommands: string[] = [];
  readonly readOnlyRequests: boolean[] = [];

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    return capabilityReport(ctx, this.options);
  }

  buildInvocation(_spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    this.invocationCount += 1;
    if (ctx.tempHome !== undefined) this.tempHomes.push(ctx.tempHome);
    this.readOnlyRequests.push(ctx.readOnly === true);
    return {
      executable: nodeExecutable,
      args: [],
      stdin: this.options.cannedStdout ?? REVIEW_OUTPUT,
      requiredEnv: [],
      network: "denied",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return {
      events: [{ kind: "final", text: raw.stdout }],
      producerSummary: raw.stdout,
      ok: true,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [],
      behavioralConfigSources: [],
      repositoryInstructionSources: [],
      environmentDependencies: [],
      temporaryHomeStrategy: "per-attempt HOME",
    };
  }

  recordSpawn(command: string): SupervisedExit {
    this.spawnCount += 1;
    this.spawnedCommands.push(command);
    const failsThisAttempt = this.options.failFirstAttempt === true && this.spawnCount === 1;
    const exit = supervisedExit({
      exitCode: failsThisAttempt ? 1 : (this.options.exitCode ?? 0),
      stdout: this.options.cannedStdout ?? REVIEW_OUTPUT,
    });
    if (this.options.spawnFailure === true) {
      exit.exitCode = null;
      exit.spawnError = new Error("fake spawn failure");
    }
    return exit;
  }
}

const temporaryPaths: string[] = [];
let previousNodeEnvironment: string | undefined;
let previousSeatbeltStates: Array<"certified" | "tested" | "unsupported"> | undefined;
let worktreePath = "";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

function platformServices(adapter: FakeAdapter): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return nodeExecutable;
    },
    async spawnSupervised(request) {
      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(adapter.recordSpawn(request.executable.command)),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
    async getProcessStartToken() {
      return null;
    },
    async terminateProcessTreeByPid() {},
    async acquireCheckoutLock() {
      throw new Error("unexpected lock");
    },
    async createSecureTempDirectory() {
      return temporaryDirectory("ca-role-home-");
    },
    async canonicalizePath(input) {
      return { input, canonical: input, gitCommonDir: null };
    },
  };
}

function makeSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Review the candidate.",
    context: "Candidate context.",
    writeAllowlist: ["src/**"],
    forbiddenScope: [],
    successCriteria: ["The review is complete."],
    verification: [{
      id: "check",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    executionMode: "edit",
    timeoutMs: 10_000,
    producerPreferences: ["fake"],
    expectedOutput: "candidate-patch",
  };
}

function makePackage(spec: DelegationSpec): RolePackage {
  return {
    spec,
    baselineCommit: "b".repeat(40),
    candidateCommit: "c".repeat(40),
    candidateDiff: "diff --git a/src/a.ts b/src/a.ts",
    testEvidence: "unit: exit 0",
  };
}

function argsWith(adapter: FakeAdapter, role: PipelineRole): RoleRunArgs {
  const baseSpec = makeSpec();
  return {
    role,
    baseSpec,
    pkg: makePackage(baseSpec),
    worktreePath,
    ps: platformServices(adapter),
    registry: new ProducerRegistry([adapter]),
    runId: `role-${role}`,
    env: {},
  };
}

beforeEach(async () => {
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  worktreePath = await temporaryDirectory("ca-role-worktree-");

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  if (seatbelt === undefined) throw new Error("macOS Seatbelt test backend is missing");
  // runRole checks the HOST arch (process.arch), so every darwin entry must be
  // promoted for these tests to behave identically on arm64 and x64 CI hosts.
  previousSeatbeltStates = seatbelt.platforms.map(platform => platform.state);
  for (const platform of seatbelt.platforms) platform.state = "tested";
});

afterEach(async () => {
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  if (seatbelt !== undefined && previousSeatbeltStates !== undefined) {
    seatbelt.platforms.forEach((platform, index) => {
      const saved = previousSeatbeltStates?.[index];
      if (saved !== undefined) platform.state = saved;
    });
  }
  previousSeatbeltStates = undefined;

  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("runRole", () => {
  it("returns producer output for a healthy read-only reviewer run (seatbelt available)", async () => {
    const adapter = new FakeAdapter({ cannedStdout: REVIEW_OUTPUT });

    const result = await runRole(argsWith(adapter, "reviewer-correctness"));

    expect(result.ok).toBe(true);
    expect(result.rawOutput).toContain('"reportVersion"');
    expect(result.failure).toBeNull();
    expect(adapter.spawnCount).toBe(1);
    expect(adapter.spawnedCommands).toEqual(["/usr/bin/sandbox-exec"]);
  });

  it("fails closed when the HOST has no OS sandbox backend", async () => {
    const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
    for (const platform of seatbelt?.platforms ?? []) platform.state = "unsupported";
    const adapter = new FakeAdapter({ writeConfinementBackend: null });

    const result = await runRole(argsWith(adapter, "reviewer-systems"));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("sandbox-violation");
    expect(adapter.invocationCount).toBe(0);
    expect(adapter.spawnCount).toBe(0);
  });

  it("delegates read-only confinement to a producer-native sandbox instead of wrapping it", async () => {
    // Regression: real Codex reports codex-native-sandbox (producer-native).
    // Wrapping it in an outer Seatbelt profile EPERM-crashes its own sandbox
    // init, so the role must run the producer directly with readOnly=true.
    // Add a host-arch-independent producer-native row so the assertion holds on
    // any CI runner (the probe report's arch is the real process.arch).
    const codex = SANDBOX_BACKENDS.find(backend => backend.id === "codex-native-sandbox");
    if (codex === undefined) throw new Error("codex-native-sandbox backend is missing");
    codex.platforms.push({ os: "darwin", environmentType: "native", state: "tested" });
    try {
      const adapter = new FakeAdapter({
        cannedStdout: REVIEW_OUTPUT,
        writeConfinementBackend: "codex-native-sandbox",
      });

      const result = await runRole(argsWith(adapter, "reviewer-correctness"));

      expect(result.ok).toBe(true);
      expect(result.failure).toBeNull();
      expect(adapter.spawnedCommands).not.toContain("/usr/bin/sandbox-exec");
      expect(adapter.readOnlyRequests).toEqual([true]);
    } finally {
      codex.platforms.pop();
    }
  });

  it("retries exactly once on process failure, then reports failure", async () => {
    const adapter = new FakeAdapter({ exitCode: 1 });

    const result = await runRole(argsWith(adapter, "fixer"));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("producer-failure");
    expect(adapter.spawnCount).toBe(2);
    expect(adapter.invocationCount).toBe(2);
  });

  it("recovers when the retry succeeds", async () => {
    const adapter = new FakeAdapter({ failFirstAttempt: true });

    const result = await runRole(argsWith(adapter, "reviewer-correctness"));

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(adapter.spawnCount).toBe(2);
    expect(adapter.invocationCount).toBe(2);
    expect(adapter.tempHomes).toHaveLength(2);
    expect(adapter.tempHomes[0]).not.toBe(adapter.tempHomes[1]);
    expect(adapter.spawnedCommands).toEqual([
      "/usr/bin/sandbox-exec",
      "/usr/bin/sandbox-exec",
    ]);
  });
});
