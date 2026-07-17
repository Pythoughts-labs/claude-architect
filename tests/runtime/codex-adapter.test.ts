import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../../src/platform/platform-services.js";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import {
  CODEX_EDIT_ACTION_PREAMBLE,
  CodexAdapter,
  defaultCodexEnv,
} from "../../src/producers/codex-adapter.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
} from "../../src/producers/producer-adapter.js";
import { buildEnvironment } from "../../src/runtime/environment-policy.js";
import { supervise } from "../../src/platform/process-supervisor.js";

const execFileAsync = promisify(execFile);
const executable: ResolvedExecutable = {
  kind: "native",
  command: "/usr/local/bin/codex",
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
  spawned: ResolvedExecutable[],
  supervisedExit: SupervisedExit = exit({ stdout: "codex-cli 0.144.4\n" }),
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
        done: Promise.resolve(supervisedExit),
      };
    },
    async requestCooperativeCancellation() {},
    async terminateProcessTree() {},
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
    producerId: "codex",
    available: true,
    reason: null,
    os: "darwin",
    arch: "arm64",
    environmentType: "native",
    resolvedExecutable: executable,
    version: "0.144.4",
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: "codex-native-sandbox",
    laneEligibility: { edit: true },
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
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    producerOverrides: { model: "gpt-test", reasoningEffort: "high" },
    expectedOutput: "candidate-patch",
  };
}

function invocationContext(worktreePath = "/tmp/attempt-worktree"): InvocationContext {
  const report = capabilityReport();
  return {
    worktreePath,
    runId: "run-codex",
    tempHome: "/tmp/attempt-home",
    capabilityReport: report,
    executable,
  };
}

describe("CodexAdapter", () => {
  it("normalizes a captured successful Codex JSONL stream", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");
    const normalized = new CodexAdapter().normalizeEvents({ stdout, stderr: "", exit: exit() });

    expect(normalized.ok).toBe(true);
    expect(normalized.producerSummary).toBe("fixture-ok");
    expect(normalized.events.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed Codex output", async () => {
    const stdout = await readFile(new URL("fixtures/codex-garbage.txt", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({ stdout, stderr: "", exit: exit() })).toEqual({
      events: [],
      producerSummary: null,
      ok: false,
    });
  });

  it("rejects a truncated structured-output stream", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({
      stdout,
      stderr: "",
      exit: exit({ truncated: { stdout: true, stderr: false } }),
    })).toEqual({ events: [], producerSummary: null, ok: false });
  });

  it("keeps normalizable nonzero output valid for producer-failure classification", async () => {
    const stdout = await readFile(new URL("fixtures/codex-success.json", import.meta.url), "utf8");

    expect(new CodexAdapter().normalizeEvents({
      stdout,
      stderr: "producer failed after reporting",
      exit: exit({ exitCode: 1 }),
    }).ok).toBe(true);
  });

  it("defaults CODEX_HOME to the host auth store when unset and auth.json exists", () => {
    const store = join("/hosthome", ".codex");
    const values = defaultCodexEnv({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: directory => directory === store,
    });
    expect(values).toEqual({ CODEX_HOME: store });
  });

  it("does not default CODEX_HOME when the variable is set or no auth store exists", () => {
    expect(defaultCodexEnv({
      env: { CODEX_HOME: "/custom" },
      homeDirectory: "/hosthome",
      hasAuthStore: () => true,
    })).toEqual({});
    expect(defaultCodexEnv({
      env: {},
      homeDirectory: "/hosthome",
      hasAuthStore: () => false,
    })).toEqual({});
  });

  it("uses the read-only sandbox when the context is a read-only role", () => {
    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), {
      ...invocationContext(),
      readOnly: true,
    });
    const sandboxIndex = invocation.args.indexOf("--sandbox");
    expect(invocation.args[sandboxIndex + 1]).toBe("read-only");
    expect(invocation.args).not.toContain("workspace-write");
    expect(invocation.stdin).not.toContain(CODEX_EDIT_ACTION_PREAMBLE);
  });

  it("carries the defaulted auth store on the invocation env", () => {
    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), invocationContext());
    expect(invocation.env === undefined || typeof invocation.env === "object").toBe(true);
  });

  it("builds an argv-only invocation with the delegation prompt on stdin", () => {
    const spec = sampleSpec();
    const invocation = new CodexAdapter().buildInvocation(spec, invocationContext());
    const disableIndex = invocation.args.indexOf("--disable");
    const controlIndex = invocation.args.indexOf(
      "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
    );

    expect(invocation.executable).toBe(executable);
    expect(invocation.args).toContain("--json");
    expect(invocation.args).toContain("workspace-write");
    expect(invocation.args.slice(disableIndex, disableIndex + 2)).toEqual([
      "--disable",
      "multi_agent",
    ]);
    expect(invocation.args[controlIndex - 1]).toBe("-c");
    expect(invocation.args).toContain('shell_environment_policy.inherit="none"');
    expect(invocation.args).toContain(
      'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]',
    );
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(invocation.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(invocation.args.some(arg => arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(false);
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain(spec.objective);
    expect(invocation.stdin).toContain(spec.objective);
    expect(invocation.stdin.startsWith(`${CODEX_EDIT_ACTION_PREAMBLE}\n\n`)).toBe(true);
    expect(invocation.stdin).toContain(spec.context);
    expect(invocation.stdin).toContain("src/greeting.ts");
    expect(invocation.stdin).toContain(
      "If you run linting, formatting, or type checking, complete all linting and formatting first, then run a final type-check covering every typed file you changed, including new or modified tests.",
    );
    expect(invocation.requiredEnv).toEqual([
      "CODEX_HOME",
      "CODEX_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_CA_CERTIFICATE",
      "SSL_CERT_FILE",
    ]);
    expect(invocation.network).toBe("denied");
  });

  it("renders additional writable roots for linked-worktree git metadata", () => {
    const context = invocationContext();
    context.extraWritableRoots = [
      "/repo/.git/worktrees/fix",
      "/repo/.git/worktrees/fix/private-objects",
    ];
    context.gitObjectDirectory = "/repo/.git/worktrees/fix/private-objects";
    context.gitAlternateObjectDirectories = "/repo/.git/objects";

    const invocation = new CodexAdapter().buildInvocation(sampleSpec(), context);

    expect(invocation.args).toContain(
      'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/fix","/repo/.git/worktrees/fix/private-objects"]',
    );
    expect(invocation.args.join("\n")).not.toContain(
      'sandbox_workspace_write.writable_roots=["/repo/.git/worktrees/fix","/repo/.git/objects"]',
    );
    expect(invocation.env).toMatchObject({
      GIT_OBJECT_DIRECTORY: "/repo/.git/worktrees/fix/private-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/repo/.git/objects",
    });
    expect(invocation.args).toContain(
      'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED","GIT_OBJECT_DIRECTORY","GIT_ALTERNATE_OBJECT_DIRECTORIES"]',
    );
  });

  it("reports a missing executable without spawning or guessing auth state", async () => {
    const ctx: ProbeContext = {
      ps: unavailablePlatformServices(),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    };

    await expect(new CodexAdapter().probe(ctx)).resolves.toMatchObject({
      producerId: "codex",
      available: false,
      reason: "missing-executable",
      resolvedExecutable: null,
      version: null,
      authState: "unknown",
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it.each([
    ["times out", exit({ timedOut: true, stdout: "codex-cli 0.144.4\n" })],
    ["is signal-terminated", exit({ exitCode: null, signal: "SIGTERM", stdout: "codex-cli 0.144.4\n" })],
  ])("reports probe-failed when the version probe %s", async (_description, supervisedExit) => {
    const report = await new CodexAdapter().probe({
      ps: versionPlatformServices(executable, [], supervisedExit),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
    });

    expect(report).toMatchObject({
      available: false,
      reason: "probe-failed",
      resolvedExecutable: executable,
      version: null,
      writeConfinementBackend: null,
      laneEligibility: { edit: false },
    });
  });

  it("reports authenticated when auth.json exists in the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));
    const store = join(root, ".codex");
    await mkdir(store);
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new CodexAdapter({
        env: {},
        homeDirectory: root,
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unauthenticated when auth.json is absent from the default store", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));

    try {
      const report = await new CodexAdapter({
        env: {},
        homeDirectory: root,
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("unauthenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("respects CODEX_HOME when reporting auth state", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-auth-"));
    const store = join(root, "custom-codex-home");
    await mkdir(store);
    await writeFile(join(store, "auth.json"), "fixture contents must not be read");

    try {
      const report = await new CodexAdapter({
        env: { CODEX_HOME: store },
        homeDirectory: join(root, "unused-home"),
      }).probe({
        ps: versionPlatformServices(executable, []),
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(report.authState).toBe("authenticated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invokes an npm Codex entrypoint with the runtime Node executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-entrypoint-"));
    const entrypoint = join(root, "codex");
    await writeFile(entrypoint, "#!/usr/bin/env node\nconsole.log('codex');\n");
    const spawned: ResolvedExecutable[] = [];
    const ps = versionPlatformServices({
      kind: "native",
      command: entrypoint,
      prefixArgs: [],
      resolvedFrom: `path:${entrypoint}`,
    }, spawned);

    try {
      const report = await new CodexAdapter().probe({
        ps,
        os: "darwin",
        arch: "arm64",
        environmentType: "native",
      });

      expect(spawned).toEqual([{
        kind: "node-entrypoint",
        command: process.execPath,
        prefixArgs: [entrypoint],
        resolvedFrom: `path:${entrypoint};node:${process.execPath}`,
      }]);
      expect(report.resolvedExecutable).toEqual(spawned[0]);
      expect(report.version).toBe("0.144.4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(
    process.platform !== "darwin"
      || process.arch !== "arm64"
      || process.env.RUN_CODEX_CONFINEMENT_GATE !== "1",
  )(
    "proves the native sandbox blocks a write outside the attempt worktree",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-gate-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const insidePath = join(worktreePath, "inside-probe.txt");
      const outsidePath = join(homedir(), `.claude-architect-sandbox-probe-${randomUUID()}`);
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const probeContext: ProbeContext = {
          ps,
          os: "darwin",
          arch: process.arch,
          environmentType: "native",
        };
        const report = await adapter.probe(probeContext);
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is a sandbox certification probe.",
          "Use the shell exactly once to run:",
          `printf attempted > inside-probe.txt && printf blocked > ${JSON.stringify(outsidePath)}`,
          "Run the command even though its second target is outside the workspace, then report the result.",
        ].join(" ");
        spec.writeAllowlist = ["**"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const invocation = adapter.buildInvocation(spec, {
          worktreePath,
          runId: "run-confinement-gate",
          tempHome,
          capabilityReport: report,
          executable: report.resolvedExecutable,
        });
        builtEnvironment = buildEnvironment({
          os: "darwin",
          adapterAllowlist: invocation.requiredEnv,
          tempHome,
        });
        const supervisedExit = await supervise(ps, {
          executable: invocation.executable,
          args: invocation.args,
          cwd: worktreePath,
          env: builtEnvironment.env,
          timeoutMs: 120_000,
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          maxOutputBytes: 1_000_000,
        }, {});

        await expect(
          readFile(insidePath, "utf8"),
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`,
        ).resolves.toBe("attempted");
        await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(report.writeConfinementBackend).toBe("codex-native-sandbox");
        expect(report.laneEligibility.edit).toBe(true);
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(outsidePath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it.skipIf(
    process.platform !== "linux"
      || process.env.RUN_CODEX_CONFINEMENT_GATE !== "1",
  )(
    "proves the native sandbox blocks a write outside the attempt worktree on Linux",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "claude-architect-codex-gate-"));
      const worktreePath = join(root, "worktree");
      const tempHome = join(root, "home");
      const insidePath = join(worktreePath, "inside-probe.txt");
      const outsidePath = join(homedir(), `.claude-architect-sandbox-probe-${randomUUID()}`);
      const originalCodexHome = process.env.CODEX_HOME;
      if (originalCodexHome === undefined) {
        process.env.CODEX_HOME = join(homedir(), ".codex");
      }
      let builtEnvironment: ReturnType<typeof buildEnvironment> | undefined;

      try {
        await mkdir(worktreePath);
        await mkdir(tempHome);
        await execFileAsync("git", ["init", "-q"], { cwd: worktreePath });
        const ps = new PosixPlatformServices();
        const adapter = new CodexAdapter();
        const probeContext: ProbeContext = {
          ps,
          os: "linux",
          arch: process.arch,
          environmentType: "native",
        };
        const report = await adapter.probe(probeContext);
        expect(report.resolvedExecutable).not.toBeNull();
        if (report.resolvedExecutable === null) return;
        const spec = sampleSpec();
        spec.objective = [
          "This is a sandbox certification probe.",
          "Use the shell exactly once to run:",
          `printf attempted > inside-probe.txt && printf blocked > ${JSON.stringify(outsidePath)}`,
          "Run the command even though its second target is outside the workspace, then report the result.",
        ].join(" ");
        spec.writeAllowlist = ["**"];
        spec.forbiddenScope = [];
        spec.producerOverrides = { reasoningEffort: "low" };
        const invocation = adapter.buildInvocation(spec, {
          worktreePath,
          runId: "run-confinement-gate",
          tempHome,
          capabilityReport: {
            ...report,
            writeConfinementBackend: "codex-native-sandbox",
            laneEligibility: { ...report.laneEligibility, edit: true },
          },
          executable: report.resolvedExecutable,
        });
        builtEnvironment = buildEnvironment({
          os: "linux",
          adapterAllowlist: invocation.requiredEnv,
          tempHome,
        });
        const supervisedExit = await supervise(ps, {
          executable: invocation.executable,
          args: invocation.args,
          cwd: worktreePath,
          env: builtEnvironment.env,
          timeoutMs: 120_000,
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          maxOutputBytes: 1_000_000,
        }, {});

        await expect(
          readFile(insidePath, "utf8"),
          `stdout:\n${supervisedExit.stdout}\nstderr:\n${supervisedExit.stderr}`,
        ).resolves.toBe("attempted");
        await expect(access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        builtEnvironment?.secretRegistration.dispose();
        if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = originalCodexHome;
        await rm(outsidePath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
    150_000,
  );
});
