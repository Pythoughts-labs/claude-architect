import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { applyCandidateTree } from "../../src/integrate/controlled-integrator.js";
import { delegatePipelineOutput } from "../../src/mcp/server.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type {
  AttemptResult,
  CandidateArtifact,
  ChangedPath,
} from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import {
  composeProgressNotes,
  detectWeakenedTests,
  runPipeline,
  type PipelineDependencies,
} from "../../src/pipeline/pipeline-runtime.js";
import { resolveLinkedWorktreeWritableRoots } from "../../src/pipeline/git-writable-roots.js";
import type { IncrementReport, ReviewReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { buildRunManifest } from "../../src/runtime/run-manifest.js";
import type { AcceptanceVerifierLike } from "../../src/runtime/attempt-runtime.js";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "../../src/runtime/redaction.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await git(cwd, args, env === undefined ? undefined : { env });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const directory = await realpath(await temporaryDirectory("ca-pipeline-repo-"));
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

function validSpec(reviewers: DelegationSpec["review"] = {
  reviewers: ["correctness", "systems"],
  maxRounds: 2,
}): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Update the authorized fixture file.",
    context: "a.txt is in scope.",
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
    timeoutMs: 10_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
    review: reviewers,
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
}

function success(rawOutput: string): RoleRunResult {
  return { ok: true, rawOutput, failure: null, producerId: "stub" };
}

const approve: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

const blocker: ReviewReport = {
  reportVersion: "1",
  verdict: "request-changes",
  findings: [{
    severity: "blocker",
    location: "a.txt:1",
    claim: "The candidate still needs a deterministic fix.",
    evidence: "The fixture contains the first implementation.",
    reproduction: "Read a.txt.",
    requiredOutcome: "Commit the corrected fixture.",
    confidence: 1,
  }],
  coverageGaps: [],
};

const passingVerifier: AcceptanceVerifierLike = {
  async verify() {
    return { ok: true, failures: [], evidence: {}, commandOutcomes: [] };
  },
};

function statusChangeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

async function artifactFor(
  repo: string,
  runId: string,
  baselineCommit: string,
  candidateCommit: string,
): Promise<CandidateArtifact> {
  const output = await runGit(repo, [
    "diff",
    "--name-status",
    "--no-renames",
    baselineCommit,
    candidateCommit,
  ]);
  const changedPaths: ChangedPath[] = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [status, pathname] = line.split("\t");
    if (status === undefined || pathname === undefined) throw new Error("invalid test diff");
    const sourceCommit = status === "D" ? baselineCommit : candidateCommit;
    const entry = await runGit(repo, ["ls-tree", sourceCommit, "--", pathname]);
    const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/.exec(entry);
    if (match === null) throw new Error("missing test tree entry");
    changedPaths.push({
      path: pathname,
      changeType: statusChangeType(status),
      mode: match[1] ?? "",
      contentHash: status === "D" ? null : match[2] ?? null,
    });
  }
  changedPaths.sort((left, right) => left.path.localeCompare(right.path));
  const anchorRef = `refs/claude-architect/candidates/${runId}`;
  await runGit(repo, ["update-ref", anchorRef, candidateCommit]);
  return {
    baseCommitOid: baselineCommit,
    candidateTreeOid: await runGit(repo, ["rev-parse", `${candidateCommit}^{tree}`]),
    candidateCommitOid: candidateCommit,
    anchorRef,
    manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
    changedPaths,
    patch: await runGit(repo, ["diff", "--binary", baselineCommit, candidateCommit]),
  };
}

function attemptResult(runId: string, candidate: CandidateArtifact): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "verified-candidate",
    failure: null,
    summary: "candidate produced and independently verified",
    producerSummary: "test producer",
    candidate,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "stub",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  };
}

function fakeAttempt(runId: string, edit: (repo: string) => Promise<void>) {
  return async (repo: string): Promise<AttemptResult> => {
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await edit(repo);
    await runGit(repo, ["add", "-A"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const result = attemptResult(
      runId,
      await artifactFor(repo, runId, baselineCommit, candidateCommit),
    );
    // Mirror AttemptRuntime, which archives result.json + manifest.json before
    // the pipeline runs; candidate promotion reads and replaces both.
    const store = new ArtifactStore(runId);
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest({
      runId,
      repoRoot: repo,
      baseCommitOid: baselineCommit,
      candidateManifestHash: result.candidate!.manifestHash,
      producer: { id: "stub", version: "1", model: null },
      effectivePolicy: { isolation: "temporary-home", retries: 0 },
      repositoryInstructions: [],
      prompt: "test",
      executionPolicy: { network: "denied", writeAllowlist: ["**"] },
      environment: [],
      packagedVerifier: { version: "1", content: "test" },
    }));
    return result;
  };
}

function dependencies(args: {
  runId: string;
  edit?: (repo: string) => Promise<void>;
  roleRunner: (args: RoleRunArgs) => Promise<RoleRunResult>;
}): PipelineDependencies {
  return {
    verifier: passingVerifier,
    ps: getPlatformServices(),
    registry: new ProducerRegistry([]),
    roleRunner: args.roleRunner,
    runAttempt: fakeAttempt(args.runId, args.edit ?? (async repo => {
      await writeFile(path.join(repo, "a.txt"), "candidate\n");
    })),
  };
}

function roundReviews(
  rounds: Array<{ correctness: ReviewReport; systems: ReviewReport }>,
  fixer: (args: RoleRunArgs, round: number) => Promise<RoleRunResult>,
): (args: RoleRunArgs) => Promise<RoleRunResult> {
  let reviewerCalls = 0;
  let fixerCalls = 0;
  return async args => {
    if (args.role === "fixer") {
      fixerCalls += 1;
      return fixer(args, fixerCalls);
    }
    const roundIndex = Math.floor(reviewerCalls / 2);
    reviewerCalls += 1;
    const reports = rounds[roundIndex];
    if (reports === undefined) throw new Error(`missing reviews for round ${roundIndex + 1}`);
    return success(fenced(
      args.role === "reviewer-correctness" ? reports.correctness : reports.systems,
    ));
  };
}

async function commitFix(args: RoleRunArgs, content: string): Promise<string> {
  if (args.gitObjectAccess === undefined) {
    throw new Error("fixer git object isolation is missing");
  }
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  await writeFile(path.join(args.worktreePath, "a.txt"), content);
  await runGit(args.worktreePath, ["add", "a.txt"], env);
  await runGit(args.worktreePath, ["commit", "-q", "-m", "fix"], env);
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

function implementationSpec(maxIncrements: number): DelegationSpec {
  const spec = validSpec({ reviewers: ["correctness"], maxRounds: 1 });
  spec.implementation = { maxIncrements };
  return spec;
}

function incrementRoleRunner(
  implementer: (args: RoleRunArgs, call: number) => Promise<RoleRunResult>,
): (args: RoleRunArgs) => Promise<RoleRunResult> {
  let implementerCalls = 0;
  return async args => {
    if (args.role === "implementer") {
      implementerCalls += 1;
      return implementer(args, implementerCalls);
    }
    if (args.role === "reviewer-correctness") return success(fenced(approve));
    throw new Error(`unexpected role ${args.role}`);
  };
}

async function commitIncrement(
  args: RoleRunArgs,
  content: string,
  allowEmpty = false,
): Promise<string> {
  if (args.gitObjectAccess === undefined) {
    throw new Error("implementer git object isolation is missing");
  }
  const env = {
    GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
  };
  if (allowEmpty) {
    await runGit(args.worktreePath, ["commit", "--allow-empty", "-q", "-m", "increment"], env);
  } else {
    await writeFile(path.join(args.worktreePath, "a.txt"), content);
    await runGit(args.worktreePath, ["add", "a.txt"], env);
    await runGit(args.worktreePath, ["commit", "-q", "-m", "increment"], env);
  }
  return runGit(args.worktreePath, ["rev-parse", "HEAD"], env);
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-pipeline-state-");
  process.env.NODE_ENV = "test";
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  clearRegisteredSecrets();
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("composeProgressNotes", () => {
  it("renders only the provided report deterministically and redacts secrets", () => {
    registerSecretValue("increment-secret-value");
    const earlier: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "a".repeat(40),
      status: "continue",
      summary: "increment two marker increment-secret-value",
      nextSteps: "continue increment two",
    };
    const latest: IncrementReport = {
      reportVersion: "1",
      candidateCommit: "b".repeat(40),
      status: "continue",
      summary: "increment three marker",
      nextSteps: "continue increment three",
    };

    const first = composeProgressNotes(earlier);
    const second = composeProgressNotes(latest);

    expect(first).not.toContain("increment-secret-value");
    expect(first).toContain("[s]");
    expect(second).not.toContain("increment two marker");
    expect(second).toContain("increment three marker");
    expect(composeProgressNotes(latest)).toBe(second);
  });

  it("caps schema-valid summary and next steps at 8000 characters", () => {
    const notes = composeProgressNotes({
      reportVersion: "1",
      candidateCommit: "c".repeat(40),
      status: "continue",
      summary: "a".repeat(4_000),
      nextSteps: "b".repeat(4_000),
    });

    expect(notes).toHaveLength(8_000);
    expect(notes).toMatch(/\[progress notes truncated\]$/);
  });
});

describe("runPipeline", () => {
  it("runs a completed increment, redacts and archives it, then reviews its diff", async () => {
    const repo = await initRepo();
    registerSecretValue("increment-secret-value");
    let reviewedDiff = "";
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "increment complete\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "completed with increment-secret-value",
      }));
    });
    const observingRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewedDiff = args.pkg.candidateDiff;
      return roleRunner(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-complete", roleRunner: observingRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.gate).toEqual({
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    });
    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]).toMatchObject({
      increment: 2,
      report: { status: "complete", summary: "completed with [s]" },
      roleLogRefs: ["logs/role-implementer-increment2.log"],
    });
    expect(reviewedDiff).toContain("increment complete");
    const store = new ArtifactStore("pipeline-increment-complete");
    await expect(store.readPipelineArtifact("pipeline-increment-complete", "increment-2"))
      .resolves.toMatchObject({ status: "complete", summary: "completed with [s]" });
    expect(delegatePipelineOutput.parse({ ok: true, result })).toMatchObject({
      result: { increments: [{ increment: 2, report: { status: "complete" } }] },
    });
    expect(delegatePipelineOutput.parse({ ok: true, result: { ...result, increments: [] } }))
      .toMatchObject({ result: { increments: [] } });
  }, { timeout: 120_000 });

  it("exhausts the increment budget after continued real progress and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(args, `increment ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-budget", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'budget-exhausted' without completion"],
    });
  }, { timeout: 120_000 });

  it("stops incrementing when blocked and still reviews", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => success(fenced({
      reportVersion: "1",
      candidateCommit: args.pkg.candidateCommit,
      status: "blocked",
      summary: "blocked by unavailable input",
      blockers: "input unavailable",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") reviewerCalls += 1;
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-blocked", roleRunner }),
    );

    expect(result.increments).toHaveLength(1);
    expect(result.increments[0]?.report.status).toBe("blocked");
    expect(reviewerCalls).toBe(1);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'blocked' without completion"],
    });
  }, { timeout: 120_000 });

  it("treats an allow-empty continuing increment as stalled", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-stalled", roleRunner }),
    );

    expect(result.increments).toHaveLength(2);
    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(result.status).toBe("human-decision-required");
    expect(result.gate).toMatchObject({
      decisionReady: false,
      requiresHumanDecision: true,
      reasons: ["increment loop ended 'stalled' without completion"],
    });
    const store = new ArtifactStore("pipeline-increment-stalled");
    await expect(store.readPipelineArtifact("pipeline-increment-stalled", "increment-2"))
      .resolves.toMatchObject({ summary: "increment 1" });
    await expect(store.readPipelineArtifact("pipeline-increment-stalled", "increment-3"))
      .resolves.toMatchObject({ summary: "increment 2" });
  }, { timeout: 120_000 });

  it("preserves completed increments when a later implementer role fails", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) {
        return {
          ok: false,
          rawOutput: "",
          failure: "timeout",
          producerId: "stub",
        };
      }
      const commit = await commitIncrement(args, "first increment\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: "first increment",
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId: "pipeline-increment-role-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("timeout");
    expect(result.increments).toHaveLength(1);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment3.log");
  }, { timeout: 120_000 });

  it("fails invalid increment output after one archived repair", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async (_args, call) =>
      success(call === 1 ? "not json" : "still not json"));

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-invalid", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("invalid-output");
    expect(result.increments).toEqual([]);
    expect(result.gate.reasons[0]).toContain("logs/role-implementer-increment2.log");
    const store = new ArtifactStore("pipeline-increment-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-implementer-increment2-repair.log"),
      "utf8",
    )).resolves.toBe("still not json");
  }, { timeout: 120_000 });

  it("fails closed when an increment leaves the worktree dirty", async () => {
    const repo = await initRepo();
    const roleRunner = incrementRoleRunner(async args => {
      const commit = await commitIncrement(args, "committed increment\n");
      await writeFile(path.join(args.worktreePath, "dirty.txt"), "uncommitted\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "complete",
        summary: "complete",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-dirty", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
  }, { timeout: 120_000 });

  it("rejects an increment report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      await commitIncrement(args, "real\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: args.pkg.candidateCommit,
        status: "complete",
        summary: "reported the stale candidate",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, { timeout: 120_000 });

  it("rejects an increment report whose candidate commit does not exist", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => success(fenced({
      reportVersion: "1",
      candidateCommit: "d".repeat(40),
      status: "complete",
      summary: "reported a nonexistent candidate",
    })));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-missing", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain("fix phase reported a missing candidate commit");
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, { timeout: 120_000 });

  it("rejects an increment HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("implementer git object isolation is missing");
      }
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const baselineTree = await runGit(
        args.worktreePath,
        ["rev-parse", `${args.pkg.baselineCommit}^{tree}`],
        env,
      );
      const sibling = await runGit(args.worktreePath, [
        "commit-tree",
        baselineTree,
        "-p",
        args.pkg.baselineCommit,
        "-m",
        "discard reviewed candidate",
      ], env);
      await runGit(args.worktreePath, [
        "update-ref",
        "HEAD",
        sibling,
        args.pkg.candidateCommit,
      ], env);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: sibling,
        status: "complete",
        summary: "replaced the reviewed lineage",
      }));
    });
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after increment provenance failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    expect(result.increments).toEqual([]);
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
    expect(reviewerCalls).toBe(0);
  }, { timeout: 120_000 });

  it("fails closed without review when implementer confinement is unavailable", async () => {
    const repo = await initRepo();
    let reviewerCalls = 0;
    const scripted = incrementRoleRunner(async () => ({
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId: "stub",
    }));
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      if (args.role === "reviewer-correctness") {
        reviewerCalls += 1;
        throw new Error("reviewer must not run after implementer confinement failure");
      }
      return scripted(args);
    };

    const result = await runPipeline(
      repo,
      implementationSpec(2),
      dependencies({ runId: "pipeline-increment-no-confinement", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.increments).toEqual([]);
    expect(reviewerCalls).toBe(0);
  }, { timeout: 120_000 });

  it("stops before dispatching another increment when only the commit oid changes", async () => {
    const repo = await initRepo();
    let implementerCalls = 0;
    const roleRunner = incrementRoleRunner(async (args, call) => {
      implementerCalls += 1;
      const commit = await commitIncrement(
        args,
        call === 1 ? "real progress\n" : "",
        call === 2,
      );
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: `increment ${call}`,
        nextSteps: "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-tree-progress", roleRunner }),
    );

    expect(result.increments.map(entry => entry.increment)).toEqual([2, 3]);
    expect(implementerCalls).toBe(2);
  }, { timeout: 120_000 });

  it("redacts increment secrets from archives, progress notes, and results", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-secret-hygiene";
    const secret = "increment-secret-XYZ";
    registerSecretValue(secret);
    let incrementThreeProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 2) incrementThreeProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `secret progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: call === 1 ? "continue" : "complete",
        summary: call === 1 ? `summary ${secret}` : "complete",
        ...(call === 1 ? { nextSteps: `next ${secret}` } : {}),
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(3),
      dependencies({ runId, roleRunner }),
    );

    const store = new ArtifactStore(runId);
    const archived = await store.readPipelineArtifact<IncrementReport>(runId, "increment-2");
    expect(archived?.summary).not.toContain(secret);
    expect(archived?.summary).toContain("[s]");
    expect(incrementThreeProgress).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  }, { timeout: 120_000 });

  it("passes only the immediately previous increment as progress", async () => {
    const repo = await initRepo();
    let incrementFourProgress = "";
    const roleRunner = incrementRoleRunner(async (args, call) => {
      if (call === 3) incrementFourProgress = args.pkg.progress ?? "";
      const commit = await commitIncrement(args, `progress ${call}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        status: "continue",
        summary: call === 1 ? "INCREMENT_TWO_MARKER" : `increment ${call + 1}`,
        nextSteps: call === 2 ? "INCREMENT_THREE_MARKER" : "continue",
      }));
    });

    const result = await runPipeline(
      repo,
      implementationSpec(4),
      dependencies({ runId: "pipeline-increment-progress", roleRunner }),
    );

    expect(result.increments).toHaveLength(3);
    expect(incrementFourProgress).toContain("INCREMENT_THREE_MARKER");
    expect(incrementFourProgress).not.toContain("INCREMENT_TWO_MARKER");
  }, { timeout: 120_000 });

  it("does not invoke an implementer without an implementation block", async () => {
    const repo = await initRepo();
    const roles: string[] = [];
    const roleRunner = async (args: RoleRunArgs): Promise<RoleRunResult> => {
      roles.push(args.role);
      if (args.role === "reviewer-correctness") return success(fenced(approve));
      throw new Error(`unexpected role ${args.role}`);
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-no-increments", roleRunner }),
    );

    expect(result.increments).toEqual([]);
    expect(roles).toEqual(["reviewer-correctness"]);
    const preIncrementGate = {
      decisionReady: true,
      requiresHumanDecision: false,
      reasons: [],
    };
    expect(result.status).toBe("decision-ready");
    expect(JSON.stringify(result.gate)).toBe(JSON.stringify(preIncrementGate));
  }, { timeout: 120_000 });

  it("preserves and skips a terminal run recovered after an increment archive", async () => {
    const repo = await initRepo();
    const runId = "pipeline-increment-crash";
    const baselineCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "candidate before crash\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, ["commit", "-q", "-m", "candidate before crash"]);
    const candidateCommit = await runGit(repo, ["rev-parse", "HEAD"]);
    const candidate = await artifactFor(repo, runId, baselineCommit, candidateCommit);
    const store = new ArtifactStore(runId);
    await store.writeResult(attemptResult(runId, candidate));
    const canonicalCommonDir = await realpath(path.join(repo, ".git"));
    const lockKey = createHash("sha256").update(canonicalCommonDir).digest("hex");
    const writerPid = 424_242;
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir,
      pid: writerPid,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
    })}\n`);
    await new WorktreeManager(
      repo,
      `${runId}-pipeline`,
      getPlatformServices(),
    ).create(candidateCommit);
    await store.writePipelineArtifact("increment-2", {
      reportVersion: "1",
      candidateCommit,
      status: "continue",
      summary: "increment two",
    });
    const terminated: number[] = [];

    const recovery = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    });

    expect(recovery).toEqual({ recovered: [] });
    expect(terminated).toEqual([]);
    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "verified-candidate",
    });
    const anchor = await git(repo, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/claude-architect/candidates/${runId}^{commit}`,
    ]);
    expect(anchor.exitCode, anchor.stderr).toBe(0);
    expect(anchor.stdout.trim()).toBe(candidateCommit);
    await expect(store.readPipelineArtifact(runId, "increment-2"))
      .resolves.toMatchObject({ summary: "increment two" });
  }, { timeout: 120_000 });

  it("returns decision-ready after a clean review round without fixing", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-clean", roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]?.fix).toBeNull();
    expect(result.rounds[0]?.roleLogRefs).toEqual([
      "logs/role-reviewer-correctness-round1.log",
      "logs/role-reviewer-systems-round1.log",
    ]);
    const store = new ArtifactStore("pipeline-clean");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-systems-round1.log"),
      "utf8",
    )).resolves.toBe(fenced(approve));
  });

  it("fixes a blocker and returns decision-ready after a clean re-review", async () => {
    const repo = await initRepo();
    let privateObjectsDir = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateObjectsDir = args.gitObjectAccess?.privateObjectsDir ?? "";
      const commit = await commitFix(args, "fixed\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fixed", roleRunner }),
    );

    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]?.roleLogRefs).toContain("logs/role-fixer-round1.log");
    expect(privateObjectsDir).not.toBe("");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`])).toBe("fixed");
    const promotedArtifact = result.attempt.candidate;
    expect(promotedArtifact).not.toBeNull();
    if (promotedArtifact === null) return;
    const checkoutHead = await runGit(repo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repo, "a.txt"), "base\n");
    await runGit(repo, ["add", "a.txt"]);
    await runGit(repo, [
      "update-ref",
      "HEAD",
      promotedArtifact.baseCommitOid,
      checkoutHead,
    ]);
    await expect(applyCandidateTree({
      repoRoot: repo,
      artifact: promotedArtifact,
      expectedArtifactHash: promotedArtifact.manifestHash,
    })).resolves.toMatchObject({ integration: "applied" });
    await expect(readFile(path.join(repo, "a.txt"), "utf8")).resolves.toBe("fixed\n");
  });

  it.each([
    {
      state: "tracked-file modification",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "a.txt"), "uncommitted\n");
      },
    },
    {
      state: "staged change",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        if (args.gitObjectAccess === undefined) {
          throw new Error("fixer git object isolation is missing");
        }
        await writeFile(path.join(args.worktreePath, "a.txt"), "staged\n");
        await runGit(args.worktreePath, ["add", "a.txt"], {
          GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
        });
      },
    },
    {
      state: "untracked file",
      dirtyWorktree: async (args: RoleRunArgs): Promise<void> => {
        await writeFile(path.join(args.worktreePath, "untracked.txt"), "uncommitted\n");
      },
    },
  ])("rejects fixer provenance with a $state", async ({ state, dirtyWorktree }) => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed\n");
      await dirtyWorktree(args);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: `pipeline-fix-dirty-${state.replaceAll(" ", "-")}`, roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree contains uncommitted state",
    );
  });

  it("fails closed when fixer worktree cleanliness cannot be read", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
      }
      const commit = await commitFix(args, "fixed\n");
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const indexPath = path.resolve(
        args.worktreePath,
        await runGit(args.worktreePath, ["rev-parse", "--git-path", "index"], env),
      );
      await rm(indexPath);
      await mkdir(indexPath);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-status-failure", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate worktree cleanliness could not be verified",
    );
  });

  it("validates fixer provenance through private objects before promotion", async () => {
    const repo = await initRepo();
    let privateCommit = "";
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
      privateCommit = await commitFix(args, "private-fixed\n");
      expect((await git(repo, [
        "cat-file",
        "-e",
        `${privateCommit}^{commit}`,
      ])).exitCode).not.toBe(0);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: privateCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit: privateCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-private-provenance", roleRunner }),
    );

    expect(privateCommit).not.toBe("");
    expect(result.status).toBe("decision-ready");
    expect((await git(repo, [
      "cat-file",
      "-e",
      `${result.finalCandidateCommit}^{commit}`,
    ])).exitCode).toBe(0);
    expect(await runGit(repo, ["show", `${result.finalCandidateCommit}:a.txt`]))
      .toBe("private-fixed");
  });

  it("rejects a fixer report whose candidate does not match worktree HEAD", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const reportedCommit = args.pkg.candidateCommit;
      await commitFix(args, "unreported-head\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: reportedCommit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Claimed the old candidate instead of the produced HEAD.",
          commit: reportedCommit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-head-mismatch", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase reported a candidate commit that does not match its worktree HEAD",
    );
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
  });

  it("rejects a fixer HEAD that is not descended from the reviewed candidate", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      if (args.gitObjectAccess === undefined) {
        throw new Error("fixer git object isolation is missing");
      }
      const env = {
        GIT_OBJECT_DIRECTORY: args.gitObjectAccess.privateObjectsDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: args.gitObjectAccess.sharedObjectsDir,
      };
      const baselineTree = await runGit(
        args.worktreePath,
        ["rev-parse", `${args.pkg.baselineCommit}^{tree}`],
        env,
      );
      const sibling = await runGit(args.worktreePath, [
        "commit-tree",
        baselineTree,
        "-p",
        args.pkg.baselineCommit,
        "-m",
        "discard reviewed candidate",
      ], env);
      await runGit(args.worktreePath, [
        "update-ref",
        "HEAD",
        sibling,
        args.pkg.candidateCommit,
      ], env);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: sibling,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Replaced the reviewed lineage.",
          commit: sibling,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-sibling", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("sandbox-violation");
    expect(result.gate.reasons).toContain(
      "fix phase candidate commit is not descended from the reviewed candidate",
    );
    expect(result.finalCandidateCommit).toBe(result.attempt.candidate?.candidateCommitOid);
  });

  it("rejects a fixer disposition that cites a nonexistent commit", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
    ], async args => {
      const commit = await commitFix(args, "fixed-with-false-evidence\n");
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Cited an object that does not exist.",
          commit: "d".repeat(40),
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-fix-missing-disposition", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("producer-failure");
    expect(result.gate.reasons).toContain(
      "fix phase disposition reported a missing commit object",
    );
  });

  it("requires human decision when the final-round fix was not re-reviewed", async () => {
    const repo = await initRepo();
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: blocker, systems: approve },
    ], async (args, round) => {
      const commit = await commitFix(args, `still-blocked-${round}\n`);
      return success(fenced({
        reportVersion: "1",
        candidateCommit: commit,
        dispositions: [{
          findingId: "F-001",
          disposition: "fixed",
          evidence: "Committed the requested correction.",
          commit,
        }],
      }));
    });

    const result = await runPipeline(
      repo,
      validSpec(),
      dependencies({ runId: "pipeline-capped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.gate.requiresHumanDecision).toBe(true);
    expect(result.gate.reasons).toContain("final fix was not re-reviewed");
    expect(result.rounds.at(-1)?.fix).not.toBeNull();
  });

  it("fails after invalid reviewer output and one invalid repair", async () => {
    const repo = await initRepo();
    let calls = 0;
    const roleRunner = async (): Promise<RoleRunResult> => {
      calls += 1;
      return success(calls === 1 ? "not json" : "not json either");
    };

    const result = await runPipeline(
      repo,
      validSpec({ reviewers: ["correctness"], maxRounds: 1 }),
      dependencies({ runId: "pipeline-invalid", roleRunner }),
    );

    expect(result.status).toBe("failed");
    expect(result.gate.reasons).toEqual([
      "review phase did not produce valid structured output (see logs/role-reviewer-correctness-round1.log)",
    ]);
    expect(calls).toBe(2);
    const store = new ArtifactStore("pipeline-invalid");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1.log"),
      "utf8",
    )).resolves.toBe("not json");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "role-reviewer-correctness-round1-repair.log"),
      "utf8",
    )).resolves.toBe("not json either");
  });

  it("requires human decision when the candidate adds a skipped test", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.writeAllowlist = ["a.txt", "tests/**"];
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );
    const edit = async (checkout: string): Promise<void> => {
      await writeFile(path.join(checkout, "a.txt"), "candidate\n");
      await mkdir(path.join(checkout, "tests"));
      await writeFile(path.join(checkout, "tests", "candidate.test.ts"), [
        "it.skip(\"newly skipped\", () => {});",
        "",
      ].join("\n"));
    };

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-weakened", roleRunner, edit }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.testsSkipped).toBeGreaterThan(0);
  });

  it("persists round and verification artifacts", async () => {
    const repo = await initRepo();
    const runId = "pipeline-artifacts";
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    await runPipeline(repo, validSpec(), dependencies({ runId, roleRunner }));

    const store = new ArtifactStore(runId);
    await expect(store.readPipelineArtifact(runId, "round-1-review-correctness"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact(runId, "round-1-review-systems"))
      .resolves.toEqual(approve);
    await expect(store.readPipelineArtifact(runId, "round-1-consolidated"))
      .resolves.toMatchObject({ findings: [], contradictions: [] });
    await expect(store.readPipelineArtifact(runId, "verification"))
      .resolves.toMatchObject({
        pass: true,
        workspaceClean: true,
        evidence: {
          failures: [],
          commandOutcomes: [{
            stdoutRef: "logs/pipeline-verification-0-stdout.log",
            stderrRef: "logs/pipeline-verification-0-stderr.log",
          }],
        },
      });
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stdout.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(readFile(
      path.join(store.runDirectory, "logs", "pipeline-verification-0-stderr.log"),
      "utf8",
    )).resolves.toBe("");
    await expect(store.readPipelineArtifact(runId, "pipeline-result"))
      .resolves.toMatchObject({ status: "decision-ready", runId });
  });

  it("fails the final gate when every verification command is platform-skipped", async () => {
    const repo = await initRepo();
    const spec = validSpec();
    spec.verification[0] = {
      ...spec.verification[0]!,
      platform: {
        os: [getPlatformServices().os === "darwin" ? "linux" : "darwin"],
      },
    };
    const roleRunner = roundReviews(
      [{ correctness: approve, systems: approve }],
      async () => { throw new Error("fixer must not run"); },
    );

    const result = await runPipeline(
      repo,
      spec,
      dependencies({ runId: "pipeline-all-skipped", roleRunner }),
    );

    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.pass).toBe(false);
    expect(result.verification?.evidence.failures).toContain("empty-verification");
    expect(result.gate.reasons).toContain("clean-room verification failed");
  });

  it("does not expose unimported private fixer objects after worktree cleanup", async () => {
    const repo = await initRepo();
    const linked = path.join(await temporaryDirectory("ca-private-objects-"), "linked");
    await runGit(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
    const objectAccess = await resolveLinkedWorktreeWritableRoots(linked);
    const env = {
      GIT_OBJECT_DIRECTORY: objectAccess.privateObjectsDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: objectAccess.sharedObjectsDir,
    };
    await writeFile(path.join(linked, "private.txt"), "private only\n");
    await runGit(linked, ["add", "private.txt"], env);
    await runGit(linked, ["commit", "-q", "-m", "private object"], env);
    const privateCommit = await runGit(linked, ["rev-parse", "HEAD"], env);

    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
    await runGit(repo, ["worktree", "remove", "--force", linked]);
    expect((await git(repo, ["cat-file", "-e", `${privateCommit}^{commit}`])).exitCode)
      .not.toBe(0);
  });

  it("propagates the attempt classification when the implement phase does not verify", async () => {
    const repo = await initRepo();
    const failing: AttemptResult = {
      resultVersion: "1",
      runId: "pipeline-attempt-classification",
      status: "failed",
      failure: "verification-failure",
      summary: "candidate did not pass independent verification",
      producerSummary: "test producer",
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: ["base-changed"],
      evidence: { structural: { failures: ["base-changed"] } },
      logsRef: "logs/producer.log",
      producerId: "stub",
      producerVersion: "1",
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    };

    const result = await runPipeline(repo, validSpec(), {
      verifier: passingVerifier,
      ps: getPlatformServices(),
      registry: new ProducerRegistry([]),
      roleRunner: async () => {
        throw new Error("roleRunner must not run for a non-verified implement phase");
      },
      runAttempt: async () => failing,
    });

    expect(result.status).toBe("failed");
    expect(result.failure).toBe("verification-failure");
    expect(result.gate.reasons).toContain("implement phase did not produce a verified candidate");
  });
});

describe("detectWeakenedTests", () => {
  it("counts deleted test files and added .skip calls", () => {
    const diff = [
      "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/bar.test.ts b/tests/bar.test.ts",
      "+it.skip(\"was passing\", () => {});",
    ].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 1, testsSkipped: 1 });
  });

  it("ignores skips in non-test files", () => {
    const diff = ["diff --git a/src/foo.ts b/src/foo.ts", "+it.skip(", ""].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 0 });
  });
});
