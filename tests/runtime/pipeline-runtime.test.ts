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
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type {
  AttemptResult,
  CandidateArtifact,
  ChangedPath,
} from "../../src/protocol/attempt-result.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
import {
  detectWeakenedTests,
  runPipeline,
  type PipelineDependencies,
} from "../../src/pipeline/pipeline-runtime.js";
import type { ReviewReport } from "../../src/pipeline/report-types.js";
import type { RoleRunArgs, RoleRunResult } from "../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { AcceptanceVerifierLike } from "../../src/runtime/attempt-runtime.js";
import { clearRegisteredSecrets } from "../../src/runtime/redaction.js";

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousDelegated: string | undefined;

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
    return attemptResult(
      runId,
      await artifactFor(repo, runId, baselineCommit, candidateCommit),
    );
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
  await writeFile(path.join(args.worktreePath, "a.txt"), content);
  await runGit(args.worktreePath, ["add", "a.txt"]);
  await runGit(args.worktreePath, ["commit", "-q", "-m", "fix"]);
  return runGit(args.worktreePath, ["rev-parse", "HEAD"]);
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

describe("runPipeline", () => {
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
    const roleRunner = roundReviews([
      { correctness: blocker, systems: approve },
      { correctness: approve, systems: approve },
    ], async args => {
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
  });

  it("requires human decision when blockers remain at the round cap", async () => {
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
          disposition: "blocked",
          evidence: "The blocker remains unresolved.",
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
      .resolves.toMatchObject({ pass: true, workspaceClean: true });
    await expect(store.readPipelineArtifact(runId, "pipeline-result"))
      .resolves.toMatchObject({ status: "decision-ready", runId });
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
