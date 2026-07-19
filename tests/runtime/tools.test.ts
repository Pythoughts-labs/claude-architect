import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitResult } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  handleReviewCandidate,
  type RunDecision,
  type ToolArtifactStore,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import type { PipelineResult } from "../../src/pipeline/pipeline-runtime.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import type { PipelineActiveMarker } from "../../src/runtime/artifact-store.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";
import { RuntimeError } from "../../src/util/errors.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const changedPaths: CandidateArtifact["changedPaths"] = [{
  path: "src/example.ts",
  changeType: "modified",
  mode: "100644",
  contentHash: "5".repeat(40),
}];

const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateTreeOid: "2".repeat(40),
  candidateCommitOid: "3".repeat(40),
  anchorRef: "refs/claude-architect/candidates/run-tools",
  manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
  changedPaths,
  patch: "redacted archived patch",
};

const result: AttemptResult = {
  resultVersion: "1",
  runId: "run-tools",
  status: "verified-candidate",
  failure: null,
  summary: "verified",
  producerSummary: "done",
  candidate,
  requestedVerification: [],
  executedVerification: [{
    id: "test",
    executable: "npm",
    args: ["test"],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdoutRef: "logs/test-stdout.log",
    stderrRef: "logs/test-stderr.log",
  }],
  unresolvedIssues: [],
  evidence: { structural: { manifestHash: candidate.manifestHash } },
  logsRef: "logs/producer.log",
  producerId: "fake",
  producerVersion: "1.0.0",
  producerModel: null,
  durationMs: 1,
  sessionId: null,
};

const pipelineResult: PipelineResult = {
  runId: "run-tools",
  status: "decision-ready",
  attempt: result,
  rounds: [],
  increments: [],
  slices: [],
  haltedSliceIndex: null,
  verification: null,
  gate: {
    decisionReady: true,
    requiresHumanDecision: false,
    reasons: [],
  },
  finalCandidateCommit: candidate.candidateCommitOid,
};

const manifest = {
  manifestVersion: "1",
  runId: "run-tools",
  repoRoot: "/canonical/repo",
  baseCommitOid: candidate.baseCommitOid,
  candidateManifestHash: candidate.manifestHash,
  producer: { id: "fake", version: "1.0.0", model: null },
  effectivePolicy: {},
  repositoryInstructions: [],
  promptHash: "6".repeat(64),
  executionPolicy: {},
  environment: [],
  runtimeVersion: "0.8.0",
  protocolVersion: PROTOCOL_VERSION,
  schemaVersions: { delegationSpec: "1", attemptResult: "1" },
  packagedVerifier: { version: "test", hash: "7".repeat(64) },
  manifestHash: "8".repeat(64),
} satisfies RunManifest;

const validSpec: DelegationSpec = {
  specVersion: "1",
  objective: "change one file",
  context: "test",
  writeAllowlist: ["src/**"],
  forbiddenScope: [],
  successCriteria: ["tests pass"],
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
};

class FakeStore implements ToolArtifactStore {
  decision: RunDecision | null = null;
  pipelineActiveMarker: PipelineActiveMarker | null = null;

  constructor(
    private readonly storedResult: AttemptResult = result,
    private readonly storedManifest: RunManifest = manifest,
  ) {}

  async readResult(_runId: string): Promise<AttemptResult | null> {
    return this.storedResult;
  }

  async readManifest(_runId: string): Promise<RunManifest | null> {
    return this.storedManifest;
  }

  async writeDecision(decision: RunDecision): Promise<void> {
    if (this.decision?.decision === decision.decision) return;
    if (this.decision !== null) {
      throw new RuntimeError(
        `candidate decision conflict: recorded ${this.decision.decision}, attempted ${decision.decision}`,
        { toolError: "decision-conflict" },
      );
    }
    this.decision = decision;
  }

  async readDecision(_runId: string): Promise<RunDecision | null> {
    return this.decision;
  }

  async readPipelineActiveMarker(_runId: string): Promise<PipelineActiveMarker | null> {
    return this.pipelineActiveMarker;
  }
}

function fakePlatform(): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async input => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async checkout => ({
      key: checkout,
      release: async () => {},
    }),
  } as PlatformServices;
}

function gitResult(stdout = "", exitCode = 0): GitResult {
  return { stdout, stderr: "", exitCode };
}

function dependencies(
  store = new FakeStore(),
  ps: PlatformServices = fakePlatform(),
): ToolDependencies {
  return {
    ps,
    storeFactory: () => store,
    git: async (_cwd, args) => {
      if (args[0] === "diff") return gitResult("exact unredacted patch\n");
      if (args.includes(`${candidate.anchorRef}^{commit}`)) {
        return gitResult(`${candidate.candidateCommitOid}\n`);
      }
      if (args.includes(`${candidate.candidateCommitOid}^{tree}`)) {
        return gitResult(`${candidate.candidateTreeOid}\n`);
      }
      if (args[0] === "update-ref") return gitResult();
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runAttempt: async () => result,
    applyCandidateTree: async () => ({
      integration: "applied",
      detail: "candidate tree applied",
    }),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const output = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return output.stdout.trim();
}

async function createRepository(): Promise<string> {
  const rawRoot = await mkdtemp(join(tmpdir(), "claude-architect-tools-repo-"));
  const repoRoot = await realpath(rawRoot);
  temporaryPaths.push(repoRoot);
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["commit", "--allow-empty", "-m", "base"]);
  return repoRoot;
}

async function createLinkedWorktree(repoRoot: string): Promise<string> {
  const rawParent = await mkdtemp(join(tmpdir(), "claude-architect-tools-worktree-"));
  const parent = await realpath(rawParent);
  temporaryPaths.push(parent);
  const linked = join(parent, "linked");
  await git(repoRoot, ["worktree", "add", "--detach", linked]);
  return realpath(linked);
}

function manifestFor(
  repoRoot: string,
  archivedCandidate: CandidateArtifact = candidate,
): RunManifest {
  return {
    ...manifest,
    repoRoot,
    baseCommitOid: archivedCandidate.baseCommitOid,
    candidateManifestHash: archivedCandidate.manifestHash,
  };
}

describe("handleDelegatePipeline", () => {
  it("validates spec and returns pipeline result with runPipeline called once", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    const injectedRunAttempt = deps.runAttempt;
    deps.runPipeline = async (checkoutPath, spec, pipelineDeps) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      expect(pipelineDeps.ps).toBe(deps.ps);
      expect(pipelineDeps.verifier).toBeDefined();
      expect(pipelineDeps.registry).toBeDefined();
      expect(pipelineDeps.runAttempt).toBe(injectedRunAttempt);
      return pipelineResult;
    };

    const output = await handleDelegatePipeline("/repo", validSpec, deps);

    expect(output).toEqual({ ok: true, result: pipelineResult });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("invalid spec returns error without invoking pipeline", async () => {
    let calls = 0;
    const deps = dependencies();
    deps.runPipeline = async () => {
      calls += 1;
      return pipelineResult;
    };

    const output = await handleDelegatePipeline("/repo", { specVersion: "1" }, deps);

    expect(output).toMatchObject({ ok: false, error: "invalid-specification" });
    expect("validationErrors" in output && output.validationErrors.length).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });

  it("accepts spec as JSON string", async () => {
    const deps = dependencies();
    deps.runPipeline = async () => pipelineResult;

    const output = await handleDelegatePipeline("/repo", JSON.stringify(validSpec), deps);

    expect(output).toEqual({ ok: true, result: pipelineResult });
  });
});

describe("MCP tool handlers", () => {
  it("returns repairable validation errors without touching a producer", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", { specVersion: "1" }, deps);

    expect(output).toMatchObject({ ok: false });
    expect("validationErrors" in output && output.validationErrors.length).toBeGreaterThan(0);
    expect(attempted).toBe(false);
  });

  it("accepts a JSON-encoded string spec from schemaless MCP clients", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    deps.runAttempt = async (checkoutPath, spec) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      return result;
    };

    const output = await handleDelegate("/repo", JSON.stringify(validSpec), deps);

    expect(output).toEqual({ ok: true, result });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("reports a repairable error for a string spec that is not valid JSON", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", "{not json", deps);

    expect(output).toMatchObject({ ok: false, error: "invalid-specification" });
    expect(attempted).toBe(false);
  });

  it("bounds repository-sized ignored-path evidence on the returned result", async () => {
    const deps = dependencies();
    const bigResult = {
      ...result,
      evidence: { ...result.evidence, ignoredPaths: Array.from({ length: 500 }, (_, i) => `node_modules/pkg-${i}`) },
    };
    deps.runAttempt = async () => bigResult;

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output.ok).toBe(true);
    const evidence = (output as { result: { evidence: Record<string, unknown> } }).result.evidence;
    expect((evidence.ignoredPaths as string[]).length).toBe(50);
    expect(evidence.ignoredPathsOmitted).toBe(450);
    expect(bigResult.evidence.ignoredPaths.length).toBe(500); // archived copy untouched
  });

  it("forwards host progress reporting into the attempt dependencies", async () => {
    const phases: string[] = [];
    const deps = dependencies();
    deps.onProgress = message => phases.push(message);
    deps.runAttempt = async (_checkout, _spec, attemptDeps) => {
      attemptDeps.onPhase?.("probing producers");
      return result;
    };

    await handleDelegate("/repo", validSpec, deps);

    expect(phases).toEqual(["probing producers"]);
  });

  it("returns an actionable protocol mismatch without touching a producer", async () => {
    let attempted = false;
    const deps = dependencies();
    deps.skillProtocolVersion = "0.9.0";
    deps.runAttempt = async () => {
      attempted = true;
      return result;
    };

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output).toEqual({
      ok: false,
      diagnostic: `protocol version mismatch: skill declares 0.9.0, runtime expects ${PROTOCOL_VERSION}`,
    });
    expect(attempted).toBe(false);
  });

  it("canonicalizes and serializes a valid delegation before running it", async () => {
    const calls: string[] = [];
    const deps = dependencies();
    deps.runAttempt = async (checkoutPath, spec, attemptDeps) => {
      calls.push(checkoutPath);
      expect(spec).toEqual(validSpec);
      expect(attemptDeps.ps).toBe(deps.ps);
      expect(attemptDeps.verifier).toBeDefined();
      return result;
    };

    const output = await handleDelegate("/repo", validSpec, deps);

    expect(output).toEqual({ ok: true, result });
    expect(calls).toEqual(["/canonical/repo"]);
  });

  it("binds every candidate lifecycle tool to the archived repository and accepts its linked worktree", async () => {
    const repoRoot = await createRepository();
    const linkedWorktree = await createLinkedWorktree(repoRoot);
    const store = new FakeStore(result, manifestFor(repoRoot));
    const deps = dependencies(store, getPlatformServices());

    for (const checkoutPath of [repoRoot, linkedWorktree]) {
      await expect(handleReviewCandidate(checkoutPath, "run-tools", deps)).resolves.toMatchObject({
        patch: "exact unredacted patch\n",
      });
      await expect(handleDecideCandidate(
        checkoutPath,
        "run-tools",
        "accepted",
        deps,
      )).resolves.toEqual({ recorded: true });
      await expect(handleIntegrateCandidate(
        checkoutPath,
        "run-tools",
        candidate.manifestHash,
        deps,
      )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    }
  });

  it("rejects cross-project lifecycle authority and preserves the candidate anchor", async () => {
    const repoA = await createRepository();
    const repoB = await createRepository();
    const commitOid = await git(repoA, ["rev-parse", "HEAD"]);
    const treeOid = await git(repoA, ["rev-parse", "HEAD^{tree}"]);
    const archivedCandidate: CandidateArtifact = {
      ...candidate,
      baseCommitOid: commitOid,
      candidateCommitOid: commitOid,
      candidateTreeOid: treeOid,
      anchorRef: "refs/claude-architect/candidates/run-cross-project",
    };
    const archivedResult: AttemptResult = {
      ...result,
      candidate: archivedCandidate,
    };
    await git(repoA, ["update-ref", archivedCandidate.anchorRef, commitOid]);
    const store = new FakeStore(archivedResult, manifestFor(repoA, archivedCandidate));
    const deps = dependencies(store, getPlatformServices());
    const mismatch = {
      ok: false,
      error: "run-checkout-mismatch",
      diagnostic: "candidate run belongs to a different repository than the supplied checkoutPath",
    };

    await expect(handleReviewCandidate(repoB, "run-tools", deps)).resolves.toEqual(mismatch);
    await expect(handleDecideCandidate(
      repoB,
      "run-tools",
      "rejected",
      deps,
    )).resolves.toEqual(mismatch);
    await expect(handleIntegrateCandidate(
      repoB,
      "run-tools",
      archivedCandidate.manifestHash,
      deps,
    )).resolves.toEqual(mismatch);

    await expect(git(repoA, ["rev-parse", archivedCandidate.anchorRef])).resolves.toBe(commitOid);
    expect(store.decision).toBeNull();
  });

  it("holds the checkout file lock while recording a decision and releases it afterwards", async () => {
    const repoRoot = await createRepository();
    const ps = getPlatformServices();
    const store = new FakeStore(result, manifestFor(repoRoot));
    let markEntered!: () => void;
    let allowWrite!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const writeAllowed = new Promise<void>(resolve => { allowWrite = resolve; });
    store.writeDecision = async record => {
      markEntered();
      await writeAllowed;
      store.decision = record;
    };
    const pending = handleDecideCandidate(
      repoRoot,
      "run-tools",
      "accepted",
      dependencies(store, ps),
    );
    await entered;

    await expect(ps.acquireCheckoutLock(repoRoot)).rejects.toThrow(/checkout is locked/u);
    allowWrite();
    await expect(pending).resolves.toEqual({ recorded: true });

    const subsequent = await ps.acquireCheckoutLock(repoRoot);
    await subsequent.release();
  });

  it("holds the checkout file lock while deleting a rejected candidate anchor", async () => {
    const repoRoot = await createRepository();
    const ps = getPlatformServices();
    const store = new FakeStore(result, manifestFor(repoRoot));
    let markDeleting!: () => void;
    let allowDelete!: () => void;
    const deleting = new Promise<void>(resolve => { markDeleting = resolve; });
    const deleteAllowed = new Promise<void>(resolve => { allowDelete = resolve; });
    const deps = dependencies(store, ps);
    deps.git = async (_cwd, args) => {
      if (args[0] === "update-ref") {
        markDeleting();
        await deleteAllowed;
      }
      return gitResult();
    };
    const pending = handleDecideCandidate(
      repoRoot,
      "run-tools",
      "rejected",
      deps,
    );
    await deleting;

    await expect(ps.acquireCheckoutLock(repoRoot)).rejects.toThrow(/checkout is locked/u);
    allowDelete();
    await expect(pending).resolves.toEqual({ recorded: true });

    const subsequent = await ps.acquireCheckoutLock(repoRoot);
    await subsequent.release();
  });

  it("records decisions idempotently and rejects a contradictory decision", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    const recordedAt = [
      new Date("2026-07-18T12:00:00.000Z"),
      new Date("2026-07-18T12:01:00.000Z"),
      new Date("2026-07-18T12:02:00.000Z"),
    ];
    deps.now = () => recordedAt.shift()!;

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      deps,
    )).resolves.toEqual({ recorded: true });
    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      deps,
    )).resolves.toEqual({ recorded: true });
    expect(store.decision).toEqual({
      decision: "accepted",
      recordedAt: "2026-07-18T12:00:00.000Z",
    });

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "revision-requested",
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "decision-conflict",
      diagnostic: "candidate decision conflict: recorded accepted, attempted revision-requested",
    });
    expect(store.decision).toEqual({
      decision: "accepted",
      recordedAt: "2026-07-18T12:00:00.000Z",
    });
  });

  it("regenerates an unredacted review patch from the anchored tree", async () => {
    const deps = dependencies();
    const gitCalls: string[][] = [];
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      gitCalls.push(args);
      return originalGit(cwd, args, indexFile);
    };
    const output = await handleReviewCandidate("/canonical/repo", "run-tools", deps);

    expect(output).toEqual({
      patch: "exact unredacted patch\n",
      changedPaths: candidate.changedPaths,
      evidence: result.evidence,
      executedVerification: result.executedVerification,
    });
    expect(gitCalls.at(-1)).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      candidate.baseCommitOid,
      candidate.candidateTreeOid,
      "--",
    ]);
  });

  it("fails closed when an exact review patch exceeds the Git capture bound", async () => {
    const deps = dependencies();
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      const output = await originalGit(cwd, args, indexFile);
      return args[0] === "diff"
        ? { ...output, truncated: { stdout: true, stderr: false } }
        : output;
    };

    await expect(handleReviewCandidate("/canonical/repo", "run-tools", deps)).resolves.toEqual({
      ok: false,
      error: "candidate-review-failed",
      diagnostic: "failed to regenerate candidate patch",
    });
  });

  it("persists decisions and gates integration on the latest accepted decision", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    let integrationCalls = 0;
    deps.applyCandidateTree = async args => {
      integrationCalls += 1;
      expect(args).toEqual({
        repoRoot: "/canonical/repo",
        artifact: candidate,
        expectedArtifactHash: candidate.manifestHash,
      });
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
    expect(integrationCalls).toBe(0);

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      deps,
    )).resolves.toEqual({
      recorded: true,
    });
    expect(store.decision).toMatchObject({ decision: "accepted" });

    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    expect(integrationCalls).toBe(1);
  });

  it("refuses to decide while the delegation pipeline is active", async () => {
    const store = new FakeStore();
    store.pipelineActiveMarker = {
      pid: process.pid,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: true,
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      dependencies(store),
    )).resolves.toEqual({
      ok: false,
      error: "pipeline-active",
      diagnostic: "the delegation pipeline for this run is still active",
    });
    expect(store.decision).toBeNull();
  });

  it("refuses to integrate while the delegation pipeline is active", async () => {
    const store = new FakeStore();
    store.pipelineActiveMarker = {
      pid: process.pid,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    };
    store.decision = { decision: "accepted", recordedAt: "2026-07-18T12:01:00.000Z" };
    const deps = dependencies(store);
    let integrationCalls = 0;
    deps.applyCandidateTree = async () => {
      integrationCalls += 1;
      return { integration: "applied", detail: "candidate tree applied" };
    };

    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "pipeline-active",
      diagnostic: "the delegation pipeline for this run is still active",
    });
    expect(integrationCalls).toBe(0);
  });

  it("deletes the exact candidate anchor after recording rejection", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    const gitCalls: string[][] = [];
    deps.git = async (_cwd, args) => {
      gitCalls.push(args);
      return gitResult();
    };

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "rejected",
      deps,
    )).resolves.toEqual({
      recorded: true,
    });

    expect(store.decision).toMatchObject({ decision: "rejected" });
    expect(gitCalls).toEqual([[
      "update-ref",
      "--no-deref",
      "-d",
      candidate.anchorRef,
      candidate.candidateCommitOid,
    ]]);
    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
  });

  it("refuses to accept or integrate a candidate that failed verification", async () => {
    const failedResult: AttemptResult = {
      ...result,
      status: "failed",
      failure: "verification-failure",
      summary: "verification failed",
    };
    const store = new FakeStore(failedResult);
    const deps = dependencies(store);

    await expect(handleDecideCandidate(
      "/canonical/repo",
      "run-tools",
      "accepted",
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
    store.decision = { decision: "accepted", recordedAt: "2026-07-14T00:00:00.000Z" };
    await expect(handleIntegrateCandidate(
      "/canonical/repo",
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
  });
});
