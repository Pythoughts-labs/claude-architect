import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
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
import { NestedDelegationError } from "../../src/util/errors.js";

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
  requiredEnv?: string[];
  isolationState?: ProducerConfigurationProfile["isolationState"];
  writeConfinementBackend?: string | null;
}

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "fake";

  constructor(private readonly options: FakeAdapterOptions = {}) {}

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
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
        : [sleepFixturePath, "", "", String(this.options.sleepMs)],
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
    verification: [],
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
    ps: new PosixPlatformServices(),
    producerRegistry: new ProducerRegistry([adapter]),
    verifier: passingVerifier,
    runId: () => runId,
    env: {},
    packagedVerifier: { version: "test", content: "trusted verifier" },
    ...overrides,
  };
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
  previousHome = process.env.HOME;
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
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAttemptToken === undefined) delete process.env.ATTEMPT_API_TOKEN;
  else process.env.ATTEMPT_API_TOKEN = previousAttemptToken;
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("runAttempt", () => {
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

    await expect(runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter(), "run-dirty-precondition"),
    )).rejects.toMatchObject({
      message: "repository precondition failed",
      detail: { reason: "dirty-checkout" },
    });

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

  it("maps a child spawn error to spawn-failure", async () => {
    const repoRoot = await initRepo();
    const runId = "run-spawn-failure";

    const result = await runAttempt(
      repoRoot,
      validSpec(),
      dependencies(new FakeAdapter({ spawnFailure: true }), runId),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("spawn-failure");
    expect(result.candidate).toBeNull();
    expect(await archivedJson(runId, "run-start.json")).toMatchObject({ pid: null });
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
  }, 10_000);

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
    process.env.HOME = realHome;

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
    process.env.HOME = realHome;

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
    expect(manifest.environment).toContainEqual({ name: "HOME", source: "platform" });
  });
});
