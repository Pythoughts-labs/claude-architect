import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { verifyBaseline } from "../../src/verify/baseline-verifier.js";
import type {
  CheckoutLock,
  PlatformServices,
  ResolvedExecutable,
} from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { RUNTIME_VERSION } from "../../src/protocol/versions.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "../../src/producers/producer-adapter.js";
import {
  runAttempt,
  type AcceptanceVerifierLike,
  type AttemptRuntimeDependencies,
} from "../../src/runtime/attempt-runtime.js";
import {
  clearRegisteredSecrets,
  containsRegisteredSecret,
  redact,
} from "../../src/runtime/redaction.js";
import { collectReproducibilityInputs } from "../../src/runtime/reproducibility.js";
import { NestedDelegationError, RuntimeError } from "../../src/util/errors.js";

const fixturePath = fileURLToPath(new URL("fixtures/edit-file.mjs", import.meta.url));
const sleepFixturePath = fileURLToPath(new URL("fixtures/echo-sleep.mjs", import.meta.url));
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "test",
};

interface FakeAdapterOptions {
  target?: string;
  content?: string;
  exitCode?: number;
  normalizable?: boolean;
  eligible?: boolean;
  reason?: string | null;
  spawnFailure?: boolean;
  sleepMs?: number;
  writeBeforeSleep?: { target: string; content: string };
  requiredEnv?: string[];
  isolationState?: ProducerConfigurationProfile["isolationState"];
  writeConfinementBackend?: string | null;
}

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";
  probeCalls = 0;

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    this.probeCalls += 1;
    const eligible = this.options.eligible ?? true;
    return {
      producerId: this.producerId,
      available: eligible,
      reason: this.options.reason ?? (eligible ? null : "missing-executable"),
      os: "darwin",
      arch: "arm64",
      environmentType: "native",
      resolvedExecutable: eligible ? nodeExecutable : null,
      version: eligible ? "1.0.0" : null,
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: eligible
        ? (this.options.writeConfinementBackend === undefined
          ? "codex-native-sandbox"
          : this.options.writeConfinementBackend)
        : null,
      laneEligibility: { edit: eligible },
    };
  }

  buildInvocation(_spec: DelegationSpec, _ctx: InvocationContext): ProducerInvocation {
    const executable = this.options.spawnFailure
      ? {
        kind: "native" as const,
        command: join(tmpdir(), "claude-architect-missing-producer"),
        prefixArgs: [],
        resolvedFrom: "test-missing",
      }
      : nodeExecutable;
    return {
      executable,
      args: this.options.sleepMs === undefined
        ? [
          fixturePath,
          this.options.target ?? "a.txt",
          this.options.content ?? "changed\n",
          String(this.options.exitCode ?? 0),
        ]
        : [
          sleepFixturePath, "", "", String(this.options.sleepMs), "",
          this.options.writeBeforeSleep?.target ?? "",
          this.options.writeBeforeSleep?.content ?? "",
        ],
      requiredEnv: [...(this.options.requiredEnv ?? [])],
      network: "denied",
    };
  }

  normalizeEvents(
    _raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (this.options.normalizable === false) {
      return { events: [], producerSummary: null, ok: false };
    }
    return {
      events: [{ kind: "final", text: "fake producer complete" }],
      producerSummary: "fake producer complete",
      ok: true,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    const isolationState = this.options.isolationState ?? "controlled-config-supported";
    return {
      isolationState,
      credentialSources: [],
      behavioralConfigSources: isolationState === "inherited-config-only" ? ["HOME"] : [],
      repositoryInstructionSources: [],
      environmentDependencies: [...(this.options.requiredEnv ?? [])],
      temporaryHomeStrategy: isolationState === "inherited-config-only"
        ? "inherit HOME and record the downgrade"
        : "per-attempt HOME",
    };
  }
}

const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return {
      ok: true,
      failures: [],
      evidence: { acceptance: "passed" },
      commandOutcomes: [],
    };
  },
};

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;
// Windows producers inherit configuration through USERPROFILE, not HOME.
const homeVariableName = process.platform === "win32" ? "USERPROFILE" : "HOME";
let previousHome: string | undefined;
let previousAttemptToken: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(prefix = "ca-attempt-repo-"): Promise<string> {
  const directory = await temporaryDirectory(prefix);
  await runGit(directory, ["init", "-q"]);
  await runGit(directory, ["config", "user.name", "Test User"]);
  await runGit(directory, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(directory, "a.txt"), "hello\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "init"]);
  return directory;
}

function validSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Change the fixture file.",
    context: "a.txt is the only authorized file.",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
    successCriteria: ["a.txt contains the requested content."],
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

function dependencies(
  adapter: ProducerAdapter,
  runId: string,
  overrides: Partial<AttemptRuntimeDependencies> = {},
): AttemptRuntimeDependencies {
  return {
    // Platform-selected services: on Windows the POSIX process-group kill
    // fails silently and a timed-out producer survives its whole sleep.
    ps: getPlatformServices(),
    producerRegistry: new ProducerRegistry([adapter]),
    verifier: passingVerifier,
    // Hermetic stub: the real baseline verifier executes the spec's commands
    // with the host PATH/HOME, which host-specific node shims can break.
    // Tests that exercise real baseline behavior override this explicitly.
    baselineVerifier: async args => ({
      baselineCommitOid: args.headCommitOid,
      commands: args.commands.map(command => ({ id: command.id, exitCode: 0, ok: true })),
      dependencyLink: "none",
    }),
    runId: () => runId,
    env: {},
    repositoryInstructions: [],
    packagedVerifier: { version: "test", content: "trusted verifier" },
    ...overrides,
  };
}

async function borrowedLeaseFixture(repoRoot: string): Promise<{
  ps: PlatformServices;
  borrowedCheckoutLease: { lock: CheckoutLock; repositoryIdentity: string };
  acquireCalls(): number;
  releaseCalls(): number;
}> {
  const platformServices = getPlatformServices();
  const canonical = await platformServices.canonicalizePath(repoRoot);
  let acquireCalls = 0;
  let releaseCalls = 0;
  const lock: CheckoutLock = {
    key: "borrowed-checkout-lock-key",
    async release() {
      releaseCalls += 1;
    },
  };
  const ps = Object.assign(Object.create(platformServices), {
    async acquireCheckoutLock() {
      acquireCalls += 1;
      throw new Error("borrowed attempt acquired a nested checkout lock");
    },
  }) as PlatformServices;
  return {
    ps,
    borrowedCheckoutLease: {
      lock,
      repositoryIdentity: canonical.gitCommonDir ?? canonical.canonical,
    },
    acquireCalls: () => acquireCalls,
    releaseCalls: () => releaseCalls,
  };
}

function withBorrowedLease(
  deps: AttemptRuntimeDependencies,
  fixture: Awaited<ReturnType<typeof borrowedLeaseFixture>>,
): AttemptRuntimeDependencies {
  return Object.assign(deps, {
    borrowedCheckoutLease: fixture.borrowedCheckoutLease,
  });
}

async function archivedJson(runId: string, name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId, name),
    "utf8",
  )) as Record<string, unknown>;
}

async function expectAttemptResourcesCleaned(runId: string): Promise<void> {
  await expect(access(join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", runId)))
    .rejects.toMatchObject({ code: "ENOENT" });
  const lockDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
  const locks = await readdir(lockDirectory).catch(() => [] as string[]);
  expect(locks).toEqual([]);
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  previousHome = process.env[homeVariableName];
  previousAttemptToken = process.env.ATTEMPT_API_TOKEN;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-attempt-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  delete process.env.ATTEMPT_API_TOKEN;
  clearRegisteredSecrets();
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  if (previousHome === undefined) delete process.env[homeVariableName];
  else process.env[homeVariableName] = previousHome;
  if (previousAttemptToken === undefined) delete process.env.ATTEMPT_API_TOKEN;
  else process.env.ATTEMPT_API_TOKEN = previousAttemptToken;
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("runAttempt", () => {
  it("acquires the checkout lock before baseline verification and releases it", async () => {
    const repoRoot = await initRepo();
    const platformServices = getPlatformServices();
    let lockHeld = false;
    let lockReleased = false;
    let acquireCalls = 0;
    let releaseCalls = 0;

    const result = await runAttempt(repoRoot, validSpec(), dependencies(
      new FakeAdapter(),
      "run-lock-before-baseline",
      {
        ps: Object.assign(Object.create(platformServices), {
          acquireCheckoutLock: async (
            checkout: Parameters<PlatformServices["acquireCheckoutLock"]>[0],
          ) => {
            acquireCalls += 1;
            const lock = await platformServices.acquireCheckoutLock(checkout);
            lockHeld = true;
            return {
              key: lock.key,
              release: async () => {
                releaseCalls += 1;
                await lock.release();
                lockHeld = false;
                lockReleased = true;
              },
            };
          },
        }),
        baselineVerifier: async args => {
          expect(lockHeld).toBe(true);
          return {
            baselineCommitOid: args.headCommitOid,
            commands: args.commands.map(command => ({ id: command.id, exitCode: 0, ok: true })),
            dependencyLink: "none",
          };
        },
      },
    ));

    expect(result.status).toBe("verified-candidate");
    expect(lockHeld).toBe(false);
    expect(lockReleased).toBe(true);
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("uses a matching borrowed checkout lease without acquiring or releasing it", async () => {
    const repoRoot = await initRepo();
    const fixture = await borrowedLeaseFixture(repoRoot);
    const runId = "run-borrowed-lock-success";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      withBorrowedLease(
        dependencies(new FakeAdapter(), runId, { ps: fixture.ps }),
        fixture,
      ),
    );

    expect(result.status).toBe("verified-candidate");
    expect(fixture.acquireCalls()).toBe(0);
    expect(fixture.releaseCalls()).toBe(0);
    expect(await archivedJson(runId, "run-start.json")).toMatchObject({
      lockKey: fixture.borrowedCheckoutLease.lock.key,
    });
  });

  it("does not release a borrowed checkout lease on a classified early return", async () => {
    const repoRoot = await initRepo();
    const fixture = await borrowedLeaseFixture(repoRoot);

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      withBorrowedLease(dependencies(
        new FakeAdapter({ eligible: false }),
        "run-borrowed-lock-unavailable",
        { ps: fixture.ps },
      ), fixture),
    );

    expect(result.status).toBe("unavailable");
    expect(fixture.acquireCalls()).toBe(0);
    expect(fixture.releaseCalls()).toBe(0);
  });

  it("does not release a borrowed checkout lease when the attempt throws", async () => {
    const repoRoot = await initRepo();
    const fixture = await borrowedLeaseFixture(repoRoot);

    await expect(runAttempt(
      repoRoot,
      validSpec(),
      withBorrowedLease(dependencies(new FakeAdapter(), "run-borrowed-lock-throw", {
        ps: fixture.ps,
        baselineVerifier: async () => { throw new Error("baseline infrastructure failed"); },
      }), fixture),
    )).rejects.toThrow("baseline infrastructure failed");

    expect(fixture.acquireCalls()).toBe(0);
    expect(fixture.releaseCalls()).toBe(0);
  });

  it("does not release a borrowed checkout lease when attempt cleanup fails", async () => {
    const repoRoot = await initRepo();
    const fixture = await borrowedLeaseFixture(repoRoot);
    const create = WorktreeManager.prototype.create;
    const createSpy = vi.spyOn(WorktreeManager.prototype, "create")
      .mockImplementationOnce(async function (baseCommitOid) {
        const worktree = await create.call(this, baseCommitOid);
        return {
          ...worktree,
          async cleanup() {
            await worktree.cleanup();
            throw new Error("attempt worktree cleanup failed");
          },
        };
      });

    try {
      await expect(runAttempt(
        repoRoot,
        validSpec(),
        withBorrowedLease(dependencies(
          new FakeAdapter(),
          "run-borrowed-lock-cleanup-failure",
          { ps: fixture.ps },
        ), fixture),
      )).rejects.toThrow("attempt worktree cleanup failed");
    } finally {
      createSpy.mockRestore();
    }

    expect(fixture.acquireCalls()).toBe(0);
    expect(fixture.releaseCalls()).toBe(0);
  });

  it("rejects a borrowed lease for another repository before Producer execution", async () => {
    const repoRoot = await initRepo();
    const fixture = await borrowedLeaseFixture(repoRoot);
    fixture.borrowedCheckoutLease.repositoryIdentity += "-different-repository";
    const adapter = new FakeAdapter();
    const runId = "run-borrowed-lock-mismatch";

    await expect(runAttempt(
      repoRoot,
      validSpec(),
      withBorrowedLease(dependencies(adapter, runId, { ps: fixture.ps }), fixture),
    )).rejects.toMatchObject({
      message: "borrowed checkout lease repository identity mismatch",
    });

    expect(adapter.probeCalls).toBe(0);
    expect(fixture.acquireCalls()).toBe(0);
    expect(fixture.releaseCalls()).toBe(0);
    await expect(access(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops on a failing baseline before probing producers", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    spec.verification[0]!.expectedExitCodes = [1];
    const adapter = new FakeAdapter();

    const result = await runAttempt(repoRoot, spec, dependencies(adapter, "run-baseline-fail", { baselineVerifier: verifyBaseline }));

    expect(result.failure).toBe("environment-defect");
    expect(result.evidence).toMatchObject({
      baseline: { commands: [{ id: "check", exitCode: 0, ok: false }] },
    });
    expect(adapter.probeCalls).toBe(0);
  });

  it("classifies cancellation during baseline as cancelled", async () => {
    const repoRoot = await initRepo();
    const controller = new AbortController();
    const adapter = new FakeAdapter();

    const result = await runAttempt(repoRoot, validSpec(), dependencies(adapter, "run-baseline-cancelled", {
      abortSignal: controller.signal,
      baselineVerifier: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    }));

    expect(result.status).toBe("cancelled");
    expect(result.failure).toBe("cancelled");
    expect(adapter.probeCalls).toBe(0);
  });

  it("propagates an operational baseline verifier error", async () => {
    const repoRoot = await initRepo();
    const adapter = new FakeAdapter();

    await expect(runAttempt(repoRoot, validSpec(), dependencies(adapter, "run-baseline-error", {
      baselineVerifier: async () => { throw new Error("materialization failed"); },
    }))).rejects.toThrow("materialization failed");
    expect(adapter.probeCalls).toBe(0);
  });

  it("treats a mutating baseline command as an environment defect", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    spec.verification[0]!.args = ["-e", "require('node:fs').writeFileSync('a.txt', 'formatted\\n')"];

    const result = await runAttempt(repoRoot, spec, dependencies(
      new FakeAdapter(),
      "run-baseline-mutation",
      { baselineVerifier: verifyBaseline },
    ));

    expect(result.failure).toBe("environment-defect");
    expect(result.evidence).toMatchObject({ baseline: { commands: [{ ok: false, mutation: {} }] } });
  });

  it.skipIf(process.platform === "win32")("rejects an absolute in-checkout link before a Host verification command can write through it", async () => {
    const repoRoot = await initRepo();
    const target = join(repoRoot, "target.txt");
    const original = "original\n";
    await writeFile(target, original);
    await symlink(target, join(repoRoot, "absolute-link"), "file");
    await runGit(repoRoot, ["add", "absolute-link", "target.txt"]);
    await runGit(repoRoot, ["commit", "-q", "-m", "add absolute file link"]);
    const spec = validSpec();
    spec.writeAllowlist = ["absolute-link"];
    spec.verification[0] = {
      ...spec.verification[0]!,
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('absolute-link', 'mutated\\n')"],
    };
    const adapter = new FakeAdapter();
    let thrown: unknown;

    try {
      await runAttempt(repoRoot, spec, dependencies(adapter, "run-absolute-link-precondition", {
        baselineVerifier: verifyBaseline,
      }));
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toMatchObject({
      message: "repository precondition failed (nested-repository): absolute-link",
      detail: { reason: "nested-repository", detail: ["absolute-link"] },
    });
    expect.soft(await readFile(target, "utf8")).toBe(original);
    expect(adapter.probeCalls).toBe(0);
  });

  it("proceeds when an intentional baseline failure is expected", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    spec.verification[0]!.expectedExitCodes = [1];
    spec.verification[0]!.expectBaselineFailure = true;
    const adapter = new FakeAdapter();

    const result = await runAttempt(repoRoot, spec, dependencies(adapter, "run-baseline-expected", { baselineVerifier: verifyBaseline }));

    expect(result.status).toBe("verified-candidate");
    expect(adapter.probeCalls).toBe(1);
    expect(result.evidence).toMatchObject({ baseline: { commands: [{ ok: true }] } });
  });

  it("does not let one expected baseline failure suppress an unrelated failure", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    spec.verification = [
      { ...spec.verification[0]!, id: "expected", expectedExitCodes: [1], expectBaselineFailure: true },
      { ...spec.verification[0]!, id: "unexpected", expectedExitCodes: [1] },
    ];
    const adapter = new FakeAdapter();

    const result = await runAttempt(repoRoot, spec, dependencies(
      adapter,
      "run-baseline-mixed",
      { baselineVerifier: verifyBaseline },
    ));

    expect(result.failure).toBe("environment-defect");
    expect(adapter.probeCalls).toBe(0);
    expect(result.evidence).toMatchObject({
      baseline: { commands: [{ id: "expected", ok: true }, { id: "unexpected", ok: false }] },
    });
  });

  it("skips the baseline for a read-only spec", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    (spec as unknown as { executionMode: string }).executionMode = "read-only";
    const adapter = new FakeAdapter();

    const result = await runAttempt(repoRoot, spec, dependencies(adapter, "run-baseline-skipped", { baselineVerifier: verifyBaseline }));

    expect(adapter.probeCalls).toBe(1);
    expect(result.evidence).toMatchObject({ baseline: "skipped — read-only spec" });
  });

  it.runIf(process.platform !== "win32")(
    "verifies a candidate from a POSIX checkout path containing spaces and Unicode",
    async () => {
      const repoRoot = await initRepo("wt ünïcode-");

      const result = await runAttempt(
        repoRoot,
        validSpec(),
        dependencies(new FakeAdapter(), "run-unicode-worktree"),
      );

      expect(result.status).toBe("verified-candidate");
      expect(result.failure).toBeNull();
      await expectAttemptResourcesCleaned("run-unicode-worktree");
    },
  );

  it("produces, archives, and cleans up a verified candidate", async () => {
    const repoRoot = await initRepo();
    const runId = "run-happy";
    process.env.ATTEMPT_API_TOKEN = "attempt-secret-value";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ requiredEnv: ["ATTEMPT_API_TOKEN"] }), runId),
    );

    expect(result.status).toBe("verified-candidate");
    expect(result.failure).toBeNull();
    expect(result.candidate?.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.evidence).toMatchObject({ acceptance: "passed" });
    expect(await archivedJson(runId, "result.json")).toMatchObject({
      runId,
      status: "verified-candidate",
    });
    const runStart = await archivedJson(runId, "run-start.json");
    expect(runStart).toMatchObject({
      runId,
      canonicalCommonDir: await realpath(join(repoRoot, ".git")),
    });
    expect(runStart.lockKey).toMatch(/^[0-9a-f]{64}$/);
    expect(runStart.pid).toEqual(expect.any(Number));
    expect(Number(runStart.pid)).toBeGreaterThan(1);
    expect(runStart.startedAt).toEqual(expect.any(String));
    expect(containsRegisteredSecret("attempt-secret-value")).toBe(false);
    await expectAttemptResourcesCleaned(runId);
  });

  it("awaits onRunStart after durably archiving run-start", async () => {
    const repoRoot = await initRepo();
    const runId = "run-start-callback";
    let callbackAwaited = false;
    let observedRunStart: Record<string, unknown> | undefined;
    const callbackCompletion = {
      then(resolve: () => void, reject: (error: unknown) => void): void {
        callbackAwaited = true;
        void archivedJson(runId, "run-start.json").then(record => {
          observedRunStart = record;
          resolve();
        }, reject);
      },
    };

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), runId, {
        onRunStart: () => callbackCompletion as unknown as Promise<void>,
      }),
    );

    expect(result.status).toBe("verified-candidate");
    expect(callbackAwaited).toBe(true);
    expect(observedRunStart).toMatchObject({
      runId,
      pid: null,
    });
  });

  it("collects repository instructions and packaged verifier provenance by default", async () => {
    const repoRoot = await initRepo();
    const instructionContent = "# Repository instructions\nUse the committed policy.\n";
    await writeFile(join(repoRoot, "AGENTS.md"), instructionContent);
    await runGit(repoRoot, ["add", "AGENTS.md"]);
    await runGit(repoRoot, ["commit", "-q", "-m", "add instructions"]);
    const runId = "run-reproducibility-defaults";
    const attemptDependencies = dependencies(new FakeAdapter(), runId);
    delete attemptDependencies.repositoryInstructions;
    delete attemptDependencies.packagedVerifier;

    const result = await runAttempt(repoRoot, validSpec(), attemptDependencies);

    expect(result.status).toBe("verified-candidate");
    const manifest = await archivedJson(runId, "manifest.json");
    expect(manifest.repositoryInstructions).toEqual([{
      path: "AGENTS.md",
      hash: createHash("sha256").update(instructionContent).digest("hex"),
    }]);
    expect(manifest.packagedVerifier).toEqual({
      version: RUNTIME_VERSION,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect((manifest.packagedVerifier as { hash: string }).hash).not.toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });

  it("records no repository instructions when none exist at the base commit", async () => {
    const repoRoot = await initRepo();
    const runId = "run-reproducibility-empty-instructions";
    const attemptDependencies = dependencies(new FakeAdapter(), runId);
    delete attemptDependencies.repositoryInstructions;
    delete attemptDependencies.packagedVerifier;

    const result = await runAttempt(repoRoot, validSpec(), attemptDependencies);

    expect(result.status).toBe("verified-candidate");
    expect(await archivedJson(runId, "manifest.json")).toMatchObject({
      repositoryInstructions: [],
    });
  });

  it("fails closed when packaged verifier provenance cannot be resolved", async () => {
    const repoRoot = await initRepo();
    const runId = "run-reproducibility-failure";
    const attemptDependencies = dependencies(new FakeAdapter(), runId);
    delete attemptDependencies.repositoryInstructions;
    delete attemptDependencies.packagedVerifier;
    attemptDependencies.reproducibilityCollector = (canonicalRoot, baseCommitOid) =>
      collectReproducibilityInputs(canonicalRoot, baseCommitOid, {
        verifierModuleUrls: [pathToFileURL(join(repoRoot, "missing-verifier.mjs"))],
      });

    await expect(runAttempt(repoRoot, validSpec(), attemptDependencies))
      .rejects.toBeInstanceOf(RuntimeError);
    await expect(access(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      runId,
      "result.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      runId,
      "manifest.json",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists honest verification policy evidence in the run manifest", async () => {
    const repoRoot = await initRepo();
    const verificationPolicy = [{
      id: "check",
      confinement: "none",
      networkPolicy: "unenforced",
      requestedNetwork: "denied",
      skipped: false,
    }];
    const verifier: AcceptanceVerifierLike = {
      async verify() {
        return {
          ok: true,
          failures: [],
          evidence: { verificationPolicy },
          commandOutcomes: [],
        };
      },
    };

    await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "run-verification-policy", { verifier }),
    );

    expect(await archivedJson("run-verification-policy", "manifest.json")).toMatchObject({
      effectivePolicy: { verificationPolicy },
    });
  });

  it("scrubs verification-command environment secrets from returned and archived results", async () => {
    const repoRoot = await initRepo();
    const secret = "verification-command-enterprise-secret";
    const verificationSpec = validSpec();
    verificationSpec.verification = [{
      id: "secret-check",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      environment: { VERIFY_API_TOKEN: secret },
      timeoutMs: 5_000,
      network: "denied",
      expectedExitCodes: [0],
    }];

    const result = await runAttempt(
      repoRoot,
      verificationSpec,
      dependencies(new FakeAdapter({ content: secret }), "run-verification-secret"),
    );
    const archived = await archivedJson("run-verification-secret", "result.json");

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(archived)).not.toContain(secret);
    expect(result.requestedVerification[0]?.environment).toEqual({ VERIFY_API_TOKEN: "[s]" });
    expect(redact(secret)).toBe(secret);
  });

  it("throws before touching the repository when delegation is already nested", async () => {
    await expect(runAttempt(
      "/does/not-need-to-exist",
      validSpec(),
      dependencies(new FakeAdapter(), "run-nested", {
        env: { CLAUDE_ARCHITECT_DELEGATED: "1" },
      }),
    )).rejects.toBeInstanceOf(NestedDelegationError);

    await expect(access(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-nested")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not misclassify a repository precondition rejection as producer unavailability", async () => {
    const repoRoot = await initRepo();
    await writeFile(join(repoRoot, "a.txt"), "dirty\n");
    const platformServices = getPlatformServices();
    let lockReleased = false;

    await expect(runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "run-dirty-precondition", {
        ps: Object.assign(Object.create(platformServices), {
          acquireCheckoutLock: async (
            checkout: Parameters<PlatformServices["acquireCheckoutLock"]>[0],
          ) => {
            const lock = await platformServices.acquireCheckoutLock(checkout);
            return {
              key: lock.key,
              release: async () => {
                await lock.release();
                lockReleased = true;
              },
            };
          },
        }),
      }),
    )).rejects.toMatchObject({
      message: "repository precondition failed (dirty-checkout):  M a.txt",
      detail: { reason: "dirty-checkout", detail: [" M a.txt"] },
    });
    expect(lockReleased).toBe(true);

    await expect(access(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "run-dirty-precondition",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archives unavailable when no producer is eligible", async () => {
    const repoRoot = await initRepo();
    const runId = "run-unavailable";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ eligible: false }), runId),
    );

    expect(result.status).toBe("unavailable");
    expect(result.failure).toBe("unavailable");
    expect(result.candidate).toBeNull();
    expect(await archivedJson(runId, "result.json")).toMatchObject({
      status: "unavailable",
      failure: "unavailable",
    });
  });

  it("rejects an edit attempt without a write-confinement backend", async () => {
    const repoRoot = await initRepo();
    const runId = "run-no-write-confinement";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ writeConfinementBackend: null }), runId),
    );

    expect(result.status).toBe("unavailable");
    expect(result.unresolvedIssues).toContain("no-write-confinement-backend");
    expect(await archivedJson(runId, "run-start.json")).toMatchObject({ pid: null });
    await expectAttemptResourcesCleaned(runId);
  });

  it("rejects an unrecognized write-confinement backend", async () => {
    const repoRoot = await initRepo();
    const runId = "run-unrecognized-write-confinement";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ writeConfinementBackend: "bogus-backend" }), runId),
    );

    expect(result.status).toBe("unavailable");
    expect(result.unresolvedIssues).toContain("unrecognized-write-confinement-backend");
    expect(await archivedJson(runId, "run-start.json")).toMatchObject({ pid: null });
    await expectAttemptResourcesCleaned(runId);
  });

  it("stops without fallback when the preferred producer needs authentication", async () => {
    const repoRoot = await initRepo();

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({
        eligible: false,
        reason: "authentication-required",
      }), "run-auth-required"),
    );

    expect(result.status).toBe("unavailable");
    expect(result.failure).toBe("authentication-required");
  });

  it("maps an out-of-allowlist producer write to sandbox-violation", async () => {
    const repoRoot = await initRepo();
    const runId = "run-sandbox";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ target: "outside.txt" }), runId),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.candidate).toBeNull();
    await expectAttemptResourcesCleaned(runId);
  });

  it("maps a producer executable that does not exist to producer-failure (watchdog spawns cleanly)", async () => {
    const repoRoot = await initRepo();
    const runId = "run-spawn-failure";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ spawnFailure: true }), runId),
    );

    // The producer is spawned via the watchdog wrapper (node watchdog.mjs ... -- <producer>), so
    // the outer OS spawn always succeeds (node exists) even when the wrapped producer command does
    // not; the watchdog itself reports a nonzero exit, which classifies as producer-failure rather
    // than spawn-failure.
    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.candidate).toBeNull();
    expect(await archivedJson(runId, "run-start.json")).toMatchObject({ pid: expect.any(Number) });
    await expectAttemptResourcesCleaned(runId);
  });

  it("classifies normalizable nonzero output as producer-failure", async () => {
    const repoRoot = await initRepo();

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ exitCode: 1 }), "run-producer-failure"),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.producerSummary).toBe("fake producer complete");
    expect(result.candidate).toBeNull();
  });

  it("classifies non-normalizable output as invalid-output", async () => {
    const repoRoot = await initRepo();

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ normalizable: false }), "run-invalid-output"),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("invalid-output");
    expect(result.producerSummary).toBeNull();
    expect(result.candidate).toBeNull();
  });

  it("classifies a wall-clock timeout and cleans up the attempt", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    spec.timeoutMs = 100;

    const result = await runAttempt(
      repoRoot,
      spec,
      dependencies(new FakeAdapter({ sleepMs: 60_000 }), "run-timeout"),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    await expectAttemptResourcesCleaned("run-timeout");
  }, 30_000);

  it("salvages a bounded worktree snapshot when a timeout discards producer work", async () => {
    const repoRoot = await initRepo();
    const spec = validSpec();
    // Windows CI Node cold-start can exceed a 100ms cap before the producer's
    // synchronous salvage write lands, leaving an empty worktree to snapshot.
    // Give it ample time to write; the 60s sleep keeps the process alive so the
    // timeout still fires and the discarded work is what gets salvaged.
    spec.timeoutMs = 5_000;

    const result = await runAttempt(
      repoRoot,
      spec,
      dependencies(
        new FakeAdapter({
          sleepMs: 60_000,
          writeBeforeSleep: { target: "salvage.txt", content: "finished work\n" },
        }),
        "run-timeout-salvage",
      ),
    );

    expect(result.failure).toBe("timeout");
    const snapshot = (result.evidence as { worktreeSnapshot?: { status: string; diff: string; truncated: boolean } })
      .worktreeSnapshot;
    expect(snapshot).toBeDefined();
    expect(snapshot?.status).toContain("salvage.txt");
    expect(snapshot?.diff).toContain("finished work");
    await expectAttemptResourcesCleaned("run-timeout-salvage");
  }, 30_000);

  it("honors an AbortSignal that fired before the producer spawn", async () => {
    const repoRoot = await initRepo();
    const controller = new AbortController();
    controller.abort();

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ sleepMs: 250 }), "run-pre-cancelled", {
        abortSignal: controller.signal,
      }),
    );

    expect(result.status).toBe("cancelled");
    expect(result.failure).toBe("cancelled");
    expect(await archivedJson("run-pre-cancelled", "run-start.json")).toMatchObject({ pid: null });
  });

  it("maps an empty candidate to verification-failure", async () => {
    const repoRoot = await initRepo();

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ content: "hello\n" }), "run-empty-candidate"),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("verification-failure");
    expect(result.candidate).toBeNull();
    expect(result.unresolvedIssues).toContain("empty-candidate");
  });

  it("preserves a frozen candidate when independent verification fails", async () => {
    const repoRoot = await initRepo();
    const rejectingVerifier: AcceptanceVerifierLike = {
      async verify() {
        return {
          ok: false,
          failures: ["project-check-failed"],
          evidence: { project: "failed" },
          commandOutcomes: [],
        };
      },
    };

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "run-verification-failure", {
        verifier: rejectingVerifier,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("verification-failure");
    expect(result.candidate?.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.unresolvedIssues).toEqual(["project-check-failed"]);
    expect(result.evidence).toMatchObject({ project: "failed" });
  });

  it("archives a frozen candidate when the verifier throws", async () => {
    const repoRoot = await initRepo();
    const throwingVerifier: AcceptanceVerifierLike = {
      async verify() {
        throw new Error("verifier infrastructure failed");
      },
    };

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "run-verifier-error", {
        verifier: throwingVerifier,
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("verification-failure");
    expect(result.candidate?.candidateTreeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(result.unresolvedIssues).toEqual(["verifier-error"]);
    expect(await archivedJson("run-verifier-error", "result.json")).toMatchObject({
      failure: "verification-failure",
      candidate: { candidateTreeOid: result.candidate?.candidateTreeOid },
    });
    await expectAttemptResourcesCleaned("run-verifier-error");
  });

  it("uses a temporary HOME for a controlled configuration profile", async () => {
    const repoRoot = await initRepo();
    const realHome = await temporaryDirectory("ca-real-home-");
    process.env[homeVariableName] = realHome;

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ content: "__HOME__" }), "run-controlled-home"),
    );

    expect(result.status).toBe("verified-candidate");
    expect(result.candidate?.patch).not.toContain(realHome);
    const manifest = await archivedJson("run-controlled-home", "manifest.json");
    expect(manifest.effectivePolicy).toMatchObject({
      configurationProfile: { isolationState: "controlled-config-supported" },
      temporaryHomeApplied: true,
    });
  });

  it("records an inherited configuration profile instead of claiming isolation", async () => {
    const repoRoot = await initRepo();
    const realHome = await temporaryDirectory("ca-inherited-home-");
    process.env[homeVariableName] = realHome;

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({
        content: "__HOME__",
        isolationState: "inherited-config-only",
      }), "run-inherited-home"),
    );

    expect(result.status).toBe("verified-candidate");
    expect(result.candidate?.patch).toContain(realHome);
    const manifest = await archivedJson("run-inherited-home", "manifest.json");
    expect(manifest.effectivePolicy).toMatchObject({
      configurationProfile: { isolationState: "inherited-config-only" },
      temporaryHomeApplied: false,
    });
    expect(manifest.environment).toContainEqual({ name: homeVariableName, source: "platform" });
  });
});
