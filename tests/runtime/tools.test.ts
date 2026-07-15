import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GitResult } from "../../src/git/git-exec.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleIntegrateCandidate,
  handleReviewCandidate,
  type RunDecision,
  type ToolArtifactStore,
  type ToolDependencies,
} from "../../src/mcp/tools.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { PROTOCOL_VERSION } from "../../src/protocol/versions.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";

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
  protocolVersion: "1.0.0",
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
  verification: [],
  executionMode: "edit",
  timeoutMs: 60_000,
  producerPreferences: ["codex"],
  expectedOutput: "candidate-patch",
};

class FakeStore implements ToolArtifactStore {
  decision: RunDecision | null = null;

  constructor(private readonly storedResult: AttemptResult = result) {}

  async readResult(_runId: string): Promise<AttemptResult | null> {
    return this.storedResult;
  }

  async readManifest(_runId: string): Promise<RunManifest | null> {
    return manifest;
  }

  async writeDecision(decision: RunDecision): Promise<void> {
    this.decision = decision;
  }

  async readDecision(_runId: string): Promise<RunDecision | null> {
    return this.decision;
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
  } as PlatformServices;
}

function gitResult(stdout = "", exitCode = 0): GitResult {
  return { stdout, stderr: "", exitCode };
}

function dependencies(store = new FakeStore()): ToolDependencies {
  return {
    ps: fakePlatform(),
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

  it("regenerates an unredacted review patch from the anchored tree", async () => {
    const deps = dependencies();
    const gitCalls: string[][] = [];
    const originalGit = deps.git!;
    deps.git = async (cwd, args, indexFile) => {
      gitCalls.push(args);
      return originalGit(cwd, args, indexFile);
    };
    const output = await handleReviewCandidate("run-tools", deps);

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

    await expect(handleReviewCandidate("run-tools", deps)).resolves.toEqual({
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
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "aborted", detail: "no-accepted-decision" });
    expect(integrationCalls).toBe(0);

    await expect(handleDecideCandidate("run-tools", "accepted", deps)).resolves.toEqual({
      recorded: true,
    });
    expect(store.decision).toMatchObject({ decision: "accepted" });

    await expect(handleIntegrateCandidate(
      "run-tools",
      candidate.manifestHash,
      deps,
    )).resolves.toEqual({ integration: "applied", detail: "candidate tree applied" });
    expect(integrationCalls).toBe(1);
  });

  it("deletes the exact candidate anchor after recording rejection", async () => {
    const store = new FakeStore();
    const deps = dependencies(store);
    const gitCalls: string[][] = [];
    deps.git = async (_cwd, args) => {
      gitCalls.push(args);
      return gitResult();
    };

    await expect(handleDecideCandidate("run-tools", "rejected", deps)).resolves.toEqual({
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

    await expect(handleDecideCandidate("run-tools", "accepted", deps)).resolves.toEqual({
      ok: false,
      error: "candidate-not-verified",
      diagnostic: "candidate did not complete independent verification",
    });
    store.decision = { decision: "accepted", recordedAt: "2026-07-14T00:00:00.000Z" };
    await expect(handleIntegrateCandidate(
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
