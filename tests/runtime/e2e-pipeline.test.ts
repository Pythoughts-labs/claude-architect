import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import { runPipeline } from "../../src/pipeline/pipeline-runtime.js";
import type { ReviewReport } from "../../src/pipeline/report-types.js";
import type { ResolvedExecutable } from "../../src/platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../../src/platform/sandbox/backends.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
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
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type {
  AcceptanceVerifierLike,
  AttemptRuntimeDependencies,
} from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets } from "../../src/runtime/redaction.js";

const editFixture = fileURLToPath(new URL("fixtures/edit-file.mjs", import.meta.url));
const nodeExecutable: ResolvedExecutable = {
  kind: "native",
  command: process.execPath,
  prefixArgs: [],
  resolvedFrom: "e2e-fixture",
};

const approve: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

function requestedChanges(severity: "blocker" | "major"): ReviewReport {
  return {
    reportVersion: "1",
    verdict: "request-changes",
    findings: [{
      severity,
      location: "a.txt:1",
      claim: "The candidate still needs a deterministic correction.",
      evidence: "The first line contains the initial implementation.",
      reproduction: "Read the first line of a.txt.",
      requiredOutcome: "Commit the corrected fixture content.",
      confidence: 1,
    }],
    coverageGaps: [],
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function emit(output: string): ProducerInvocation {
  return {
    executable: nodeExecutable,
    args: ["-e", "process.stdout.write(process.argv[1]);", output],
    requiredEnv: [],
    network: "denied",
  };
}

const fixedScript = [
  'const { writeFileSync } = require("node:fs");',
  'const { spawnSync } = require("node:child_process");',
  "function git(args) {",
  '  const result = spawnSync("git", args, { encoding: "utf8" });',
  "  if (result.status !== 0) {",
  '    process.stderr.write(result.stderr || result.stdout || "git failed");',
  "    process.exit(result.status || 1);",
  "  }",
  "  return result.stdout.trim();",
  "}",
  'writeFileSync("a.txt", "fixed\\n");',
  'git(["add", "a.txt"]);',
  "git([",
  '  "-c", "user.name=Claude Architect Test",',
  '  "-c", "user.email=claude-architect@example.invalid",',
  '  "commit", "-q", "-m", "fix",',
  "]);",
  'const commit = git(["rev-parse", "HEAD"]);',
  "const report = {",
  '  reportVersion: "1",',
  "  candidateCommit: commit,",
  "  dispositions: [{",
  '    findingId: "F-001",',
  '    disposition: "fixed",',
  '    evidence: "Committed the requested correction.",',
  "    commit,",
  "  }],",
  "};",
  'process.stdout.write("```json\\n" + JSON.stringify(report) + "\\n```\\n");',
].join("\n");

const blockedScript = [
  'const { spawnSync } = require("node:child_process");',
  'const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });',
  "if (result.status !== 0) {",
  '  process.stderr.write(result.stderr || result.stdout || "git failed");',
  "  process.exit(result.status || 1);",
  "}",
  "const report = {",
  '  reportVersion: "1",',
  "  candidateCommit: result.stdout.trim(),",
  "  dispositions: [{",
  '    findingId: "F-001",',
  '    disposition: "blocked",',
  '    evidence: "The blocker remains unresolved.",',
  "  }],",
  "};",
  'process.stdout.write("```json\\n" + JSON.stringify(report) + "\\n```\\n");',
].join("\n");

type Scenario = "fixed" | "blocked";

class FakeAdapter implements ProducerAdapter {
  readonly producerId = "codex";
  readonly calls = {
    implement: 0,
    correctness: 0,
    systems: 0,
    fixer: 0,
  };

  constructor(private readonly scenario: Scenario) {}

  async probe(context: ProbeContext): Promise<CapabilityReport> {
    return {
      producerId: this.producerId,
      available: true,
      reason: null,
      os: context.os,
      arch: context.arch,
      environmentType: context.environmentType,
      resolvedExecutable: nodeExecutable,
      version: "1.0.0",
      authState: "unknown",
      executionModes: ["edit"],
      structuredOutput: true,
      writeConfinementBackend: "macos-seatbelt",
      laneEligibility: { edit: true },
    };
  }

  buildInvocation(spec: DelegationSpec, _context: InvocationContext): ProducerInvocation {
    if (spec.objective.includes("[pipeline role: reviewer-correctness]")) {
      this.calls.correctness += 1;
      const report = this.scenario === "fixed" && this.calls.correctness > 1
        ? approve
        : requestedChanges(this.scenario === "fixed" ? "major" : "blocker");
      return emit(fenced(report));
    }
    if (spec.objective.includes("[pipeline role: reviewer-systems]")) {
      this.calls.systems += 1;
      return emit(fenced(approve));
    }
    if (spec.objective.includes("[pipeline role: fixer]")) {
      this.calls.fixer += 1;
      return {
        executable: nodeExecutable,
        args: ["-e", this.scenario === "fixed" ? fixedScript : blockedScript],
        requiredEnv: [],
        network: "denied",
      };
    }

    this.calls.implement += 1;
    return {
      executable: nodeExecutable,
      args: [editFixture, "a.txt", "candidate\n", "0"],
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
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;
let previousSeatbeltState: "certified" | "tested" | "unsupported" | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const directory = await realpath(await temporaryDirectory("ca-e2e-pipeline-repo-"));
  await runGit(directory, ["init", "-q"]);
  await writeFile(path.join(directory, "a.txt"), "base\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, [
    "-c",
    "user.name=Claude Architect Test",
    "-c",
    "user.email=claude-architect@example.invalid",
    "commit",
    "-q",
    "-m",
    "base",
  ]);
  return directory;
}

function validSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture file.",
    context: "a.txt is the only file in scope.",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
    successCriteria: ["a.txt contains the delegated edit."],
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
    expectedOutput: "candidate-patch",
    review: { reviewers: ["correctness", "systems"], maxRounds: 2 },
  };
}

function dependencies(adapter: FakeAdapter, runId: string): ToolDependencies {
  const ps = getPlatformServices();
  const attemptDependencies: AttemptRuntimeDependencies = {
    ps,
    producerRegistry: new ProducerRegistry([adapter]),
    verifier: passingVerifier,
    runId: () => runId,
    env: {},
    packagedVerifier: { version: "e2e", content: "trusted e2e verifier" },
  };
  const deps: ToolDependencies = { ps, attemptDependencies };
  deps.runPipeline = (checkoutPath, spec, pipelineDeps) =>
    runPipeline(checkoutPath, spec, {
      ...pipelineDeps,
      registry: new ProducerRegistry([adapter]),
    });
  return deps;
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-e2e-pipeline-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  const darwin = seatbelt?.platforms.find(platform =>
    platform.os === "darwin" && platform.environmentType === "native");
  if (darwin === undefined) throw new Error("macOS Seatbelt test backend is missing");
  previousSeatbeltState = darwin.state;
  darwin.state = "tested";
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;

  const seatbelt = SANDBOX_BACKENDS.find(backend => backend.id === "macos-seatbelt");
  const darwin = seatbelt?.platforms.find(platform =>
    platform.os === "darwin" && platform.environmentType === "native");
  if (darwin !== undefined && previousSeatbeltState !== undefined) {
    darwin.state = previousSeatbeltState;
  }
  previousSeatbeltState = undefined;

  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe.runIf(process.platform === "darwin")("end-to-end review pipeline", () => {
  it("full lifecycle: delegatePipeline -> decide -> integrate", async () => {
    const repo = await initRepo();
    const runId = "e2e-pipeline-full-lifecycle";
    const adapter = new FakeAdapter("fixed");
    const deps = dependencies(adapter, runId);

    const result = await handleDelegatePipeline(repo, validSpec(), deps);

    expect(result).toMatchObject({
      ok: true,
      result: { runId, status: "decision-ready" },
    });
    if (!result.ok) throw new Error("pipeline delegation unexpectedly failed");
    expect(result.result.rounds).toHaveLength(2);
    expect(adapter.calls).toEqual({ implement: 1, correctness: 2, systems: 2, fixer: 1 });

    const manifest = await new ArtifactStore(runId).readManifest(runId);
    expect(manifest).not.toBeNull();
    expect(manifest?.candidateManifestHash).not.toBeNull();
    await expect(handleDecideCandidate(
      repo,
      runId,
      "accepted",
      manifest!.candidateManifestHash!,
      deps,
    )).resolves.toEqual({
      recorded: true,
    });
    await expect(handleIntegrateCandidate(
      repo,
      runId,
      manifest!.candidateManifestHash!,
      deps,
    )).resolves.toMatchObject({ integration: "applied" });
    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("fixed\n");
  });

  it("pipeline with an unfixable blocker ends at human-decision-required", async () => {
    const repo = await initRepo();
    const runId = "e2e-pipeline-blocked";
    const adapter = new FakeAdapter("blocked");

    const result = await handleDelegatePipeline(
      repo,
      validSpec(),
      dependencies(adapter, runId),
    );

    expect(result).toMatchObject({
      ok: true,
      result: { runId, status: "human-decision-required" },
    });
    if (!result.ok) throw new Error("pipeline delegation unexpectedly failed");
    expect(result.result.rounds).toHaveLength(2);
    expect(adapter.calls).toEqual({ implement: 1, correctness: 2, systems: 2, fixer: 2 });
  });
});
