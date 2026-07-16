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
import { renderProducerPrompt } from "../../src/producers/plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import { PythinkerAdapter } from "../../src/producers/pythinker-adapter.js";

const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/pythinker",
  prefixArgs: [],
  resolvedFrom: "test",
};

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
  stdout = "pythinker 0.80.7\n",
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
    producerId: "pythinker",
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
    producerPreferences: ["pythinker"],
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  return {
    worktreePath,
    runId: "run-pythinker",
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

function baseArgs(spec: DelegationSpec): string[] {
  return [
    "--quiet",
    "--yolo",
    "--work-dir",
    "/tmp/attempt-worktree",
    "--prompt",
    renderProducerPrompt(spec),
  ];
}

describe("PythinkerAdapter", () => {
  it("reports a missing executable without spawning or guessing auth state", async () => {
    await expect(new PythinkerAdapter().probe(probeContext(
      unavailablePlatformServices(),
    ))).resolves.toMatchObject({
      producerId: "pythinker",
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
    await expect(new PythinkerAdapter().probe({
      ...probeContext(unavailablePlatformServices()),
      os: "win32",
    })).resolves.toMatchObject({
      available: false,
      reason: "unsupported-platform",
      resolvedExecutable: null,
    });
  });

  it("parses the Pythinker version and honestly gates edit eligibility", async () => {
    const report = await new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(versionPlatformServices(executable)));

    expect(report).toMatchObject({
      producerId: "pythinker",
      available: true,
      reason: null,
      version: "0.80.7",
      structuredOutput: false,
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
    expect(report.laneEligibility.edit).toBe(report.writeConfinementBackend !== null);
  });

  it("falls back to a semver substring in noisy version output", async () => {
    await expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).probe(probeContext(
      versionPlatformServices(executable, [], "Pythinker CLI(version=1.2.3) ready\n"),
    ))).resolves.toMatchObject({
      available: true,
      version: "1.2.3",
    });
  });

  it("reports probe-failed when version output cannot be parsed", async () => {
    await expect(new PythinkerAdapter().probe(probeContext(
      versionPlatformServices(executable, [], "pythinker development\n"),
    ))).resolves.toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
    });
  });

  it("reports authenticated when auth.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-auth-"));
    const store = join(root, ".pythinker");
    await mkdir(store, { recursive: true });
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when auth.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-auth-"));

    try {
      const report = await new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).probe(probeContext(versionPlatformServices(executable)));

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes a Node Pythinker entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-entrypoint-"));
    const entrypoint = join(root, "pythinker");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('pythinker');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new PythinkerAdapter().probe(probeContext(ps));

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

  it("builds the exact argv-only invocation with no overrides", () => {
    const spec = sampleSpec();
    const invocation = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext());

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toEqual(baseArgs(spec));
    expect(invocation.stdin).toBeUndefined();
    expect(invocation.requiredEnv).toEqual([]);
    expect(invocation.network).toBe("denied");
  });

  it("passes the complete rendered prompt as one argv element", () => {
    const spec = sampleSpec();
    const args = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args;
    const prompt = renderProducerPrompt(spec);
    const promptArg = args[args.indexOf("--prompt") + 1];

    expect(promptArg).toBe(renderProducerPrompt(spec));
    expect(promptArg?.length).toBe(prompt.length);
  });

  it("appends a model override to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { model: "provider/model" };

    expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      ...baseArgs(spec),
      "--model",
      "provider/model",
    ]);
  });

  it("appends a thinking-effort override without adding a model override", () => {
    const spec = sampleSpec();
    spec.producerOverrides = { reasoningEffort: "high" };

    const args = new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args;

    expect(args).toEqual([...baseArgs(spec), "--thinking-effort", "high"]);
    expect(args).not.toContain("--model");
  });

  it("appends model then thinking-effort overrides to the invocation argv", () => {
    const spec = sampleSpec();
    spec.producerOverrides = {
      model: "provider/model",
      reasoningEffort: "medium",
    };

    expect(new PythinkerAdapter({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    }).buildInvocation(spec, invocationContext()).args).toEqual([
      ...baseArgs(spec),
      "--model",
      "provider/model",
      "--thinking-effort",
      "medium",
    ]);
  });

  it("defaults HOME to the host home when the Pythinker config directory exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));
    await mkdir(join(root, ".pythinker"));

    try {
      const invocation = new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({ HOME: root });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the host already set it", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));
    await mkdir(join(root, ".pythinker"));

    try {
      const invocation = new PythinkerAdapter({
        env: { HOME: "/already-set" },
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not default HOME when the Pythinker config directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-pythinker-config-"));

    try {
      const invocation = new PythinkerAdapter({
        env: {},
        homeDirectory: root,
      }).buildInvocation(sampleSpec(), invocationContext());

      expect(invocation.env).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("declares the Pythinker configuration isolation profile", () => {
    expect(new PythinkerAdapter().configurationProfile()).toEqual({
      isolationState: "inherited-config-only",
      credentialSources: ["~/.pythinker/auth.json"],
      behavioralConfigSources: ["~/.pythinker/config.toml"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    });
  });

  it("normalizes successful plain text", () => {
    expect(new PythinkerAdapter().normalizeEvents({
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
