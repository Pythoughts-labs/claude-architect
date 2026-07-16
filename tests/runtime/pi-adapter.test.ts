import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { PiAdapter } from "../../src/producers/pi-adapter.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/pi",
  prefixArgs: [],
  resolvedFrom: "test",
};

const baseArgs = [
  "-p",
  "--no-session",
  "--no-skills",
  "--tools",
  "read,bash,edit,write,grep,find,ls",
];

function exit(overrides: Partial<SupervisedExit> = {}): SupervisedExit {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

function unavailablePlatformServices(): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      throw new Error("not installed");
    },
    async spawnSupervised() {
      throw new Error("unexpected spawn");
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
      throw new Error("unexpected temp directory");
    },
    async canonicalizePath() {
      throw new Error("unexpected canonicalization");
    },
  };
}

function versionPlatformServices(
  resolvedExecutable: ResolvedExecutable,
  spawned: ResolvedExecutable[] = [],
  stdout = "pi 0.80.7\n",
): PlatformServices {
  return {
    os: "darwin",
    async resolveExecutable() {
      return resolvedExecutable;
    },
    async spawnSupervised(request) {
      spawned.push(request.executable);
      return {
        pid: 42,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve(exit({ stdout })),
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
      throw new Error("unexpected temp directory");
    },
    async canonicalizePath() {
      throw new Error("unexpected canonicalization");
    },
  };
}

function capabilityReport(): CapabilityReport {
  return {
    producerId: "pi",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "0.80.7",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: false,
    writeConfinementBackend: null,
    laneEligibility: { edit: false },
  };
}

function sampleSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the greeting without changing any other behavior.",
    context: "The greeting is rendered from src/greeting.ts.",
    writeAllowlist: ["src/greeting.ts"],
    forbiddenScope: ["secrets/**"],
    successCriteria: ["The greeting says hello."],
    verification: [],
    executionMode: "edit",
    timeoutMs: 60_000,
    producerPreferences: ["pi"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-pi",
    tempHome: "/tmp/attempt-home",
    capabilityReport: capabilityReport(),
    executable,
  };
}

function probeContext(ps: PlatformServices): ProbeContext {
  return {
    ps,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
  };
}

describe("PiAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    await expect(new PiAdapter().probe(probeContext(
      unavailablePlatformServices(),
    ))).resolves.toMatchObject({
      producerId: "pi",
      available: false,
      reason: "missing-executable",
      resolvedExecutable: null,
      version: null,
      authState: "unknown",
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it("reports win32 as unsupported without resolving an executable", async () => {
    await expect(new PiAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    })).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
      resolvedExecutable: null,
    });
  });

  it("parses the Pi version and honestly gates edit eligibility", async () => {
    const report = await new PiAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(versionPlatformServices(executable)));

    expect(report).toMatchObject({
      producerId: "pi",
      available: true,
      reason: null,
      version: "0.80.7",
      structuredOutput: false,
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
    expect(report.laneEligibility.edit).toBe(report.writeConfinementBackend !== null);
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    await expect(new PiAdapter().probe(probeContext(
      versionPlatformServices(executable, [], "pi development\n"),
    ))).resolves.toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
    });
  });

  it("reports authenticated when auth.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-auth-"));
    const store = join(root, ".pi", "agent");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new PiAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when auth.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-auth-"));

    try {
      const report = await new PiAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a Node Pi entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-entrypoint-"));
    const entrypoint = join(root, "pi");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('pi');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new PiAdapter().probe(probeContext(ps));

      expect(spawned).toEqual([{
        kind: "node-entrypoint",
        command: process.execPath,
        prefixArgs: [entrypoint],
        resolvedFrom: `path:${entrypoint};node:${process.execPath}`,
      }]);
      expect(report.resolvedExecutable).toEqual(spawned[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds the exact argv-only invocation and sends the delegation prompt on stdin", () => {
    const spec = sampleSpec();
    const invocation = new PiAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext());

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toEqual(baseArgs);
    expect(invocation.args.join(" ")).not.toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.context);
    expect(invocation.stdin).toContain("src/greeting.ts");
    expect(invocation.requiredEnv).toEqual(["PI_API_KEY"]);
    expect(invocation.network).toBe("denied");
  });

  it("appends a model override to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "provider/model" };

    expect(new PiAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      ...baseArgs,
      "--model",
      "provider/model",
    ]);
  });

  it("appends a thinking override without adding a model override", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { reasoningEffort: "high" };

    const args = new PiAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args;

    expect(args).toEqual([...baseArgs, "--thinking", "high"]);
    expect(args).not.toContain("--model");
  });

  it("appends model then thinking overrides to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = {
      model: "provider/model",
      reasoningEffort: "medium",
    };

    expect(new PiAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      ...baseArgs,
      "--model",
      "provider/model",
      "--thinking",
      "medium",
    ]);
  });

  it("defaults HOME to the host home when the Pi config directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-config-"));
    await mkdir(join(root, ".pi"));

    try {
      const invocation = new PiAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({ HOME: root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the host already set it", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-config-"));
    await mkdir(join(root, ".pi"));

    try {
      const invocation = new PiAdapter({
        env: { HOME: "/already-set" },
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the Pi config directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pi-config-"));

    try {
      const invocation = new PiAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declares the Pi configuration isolation profile", () => {
    expect(new PiAdapter().configurationProfile()).toEqual({
      isolationState: "inherited-config-only",
      credentialSources: ["~/.pi/agent/auth.json"],
      behavioralConfigSources: ["~/.pi/agent/settings.json", "~/.pi/agent/models.json"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: ["PI_API_KEY"],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    });
  });

  it("normalizes successful plain text", () => {
    expect(new PiAdapter().normalizeEvents({
      stdout: "hello world\n",
      stderr: "",
      exit: exit({ stdout: "hello world\n" }),
    })).toEqual({
      events: [{ kind: "final", text: "hello world" }],
      producerSummary: "hello world",
      ok: true,
    });
  });
});
