import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import finalBranchReportSchema from "../../../runtime/schemas/final-branch-report.v1.json" with { type: "json" };
import {
  branchArtifactHashOf,
  FINAL_ADVISOR_REF,
  FINAL_BRANCH_ARTIFACT_REF,
  FINAL_BRANCH_REPORT_REF,
  FINAL_CORRECTNESS_REVIEW_REF,
  FINAL_SYSTEMS_REVIEW_REF,
  FINAL_VERIFICATION_REF,
  FinalBranchReviewer,
  type FinalBranchReport,
  type FinalBranchTaskEvidence,
} from "../../../src/autopilot/final-branch-reviewer.js";
import { canonicalArtifactHash } from "../../../src/autopilot/autopilot-eligibility.js";
import type {
  WorkflowBranchIdentity,
  WorkflowBranchManager,
} from "../../../src/autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git } from "../../../src/git/git-exec.js";
import type { AutopilotSpec } from "../../../src/protocol/autopilot-spec.js";
import type {
  AcceptanceVerifyArgs,
  AcceptanceVerifyResult,
} from "../../../src/verify/acceptance-verifier.js";
import type { ReviewReport } from "../../../src/pipeline/report-types.js";
import type { RolePackage } from "../../../src/pipeline/role-prompts.js";
import type { RoleRunArgs, RoleRunResult } from "../../../src/pipeline/role-runner.js";
import { ArtifactStore } from "../../../src/runtime/artifact-store.js";

interface FixtureCore {
  root: string;
  repo: string;
  store: WorkflowStore;
  workflowId: string;
  baseOid: string;
  headOid: string;
  revision: number;
}

interface Fixture extends FixtureCore {
  evidence: FinalBranchTaskEvidence;
}

interface CumulativeFixture extends FixtureCore {
  firstPromotionOid: string;
  evidence: FinalBranchTaskEvidence[];
  spec: AutopilotSpec;
}

const temporaryDirectories: string[] = [];
const requiredTaskEvidenceRefs = [
  "decision.json",
  "manifest.json",
  "pipeline/pipeline-result.json",
  "pipeline/post-pipeline-autopilot.json",
  "result.json",
  "review-snapshot.json",
];
const finalBranchReportAjv = new Ajv2020({ allErrors: true, strict: false });
finalBranchReportAjv.addFormat("date-time", {
  type: "string",
  validate: value => !Number.isNaN(Date.parse(value)),
});
const validateFinalBranchReport = finalBranchReportAjv.compile(finalBranchReportSchema);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function initialState(args: {
  workflowId: string;
  repo: string;
  baseOid: string;
  spec?: AutopilotSpec;
  taskIds?: string[];
}): AutopilotWorkflowState {
  const taskIds = args.taskIds ?? ["task-1"];
  return {
    stateVersion: "1",
    workflowId: args.workflowId,
    repositoryIdentity: path.join(args.repo, ".git"),
    baseCommitOid: args.baseOid,
    workflowRef: "refs/heads/main",
    worktreePath: args.repo,
    autopilotSpecHash: canonicalArtifactHash(args.spec ?? finalSpec()),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: taskIds.map(id => ({
      id,
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    })),
    intentJournal: {
      ref: "journal.ndjson",
      entryCount: 0,
      lastEntryHash: null,
    },
    finalGate: null,
    shipping: {
      branch: "main",
      prNumber: null,
      prUrl: null,
      ciDeadlineAt: "2026-07-20T22:00:00.000Z",
    },
    ciObservations: [],
    cleanup: null,
    terminal: null,
    createdAt: "2026-07-20T20:00:00.000Z",
    updatedAt: "2026-07-20T20:00:00.000Z",
  };
}

async function cumulativeFixture(): Promise<CumulativeFixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "final-branch-cumulative-")));
  temporaryDirectories.push(root);
  const repo = path.join(root, "repository");
  const stateDirectory = path.join(root, "state");
  await Promise.all([mkdir(repo), mkdir(stateDirectory)]);
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "--local", "user.name", "Final Branch Test"]);
  await runGit(repo, ["config", "--local", "user.email", "final-branch@example.invalid"]);
  await writeFile(path.join(repo, "contract.txt"), "base contract\n");
  await writeFile(path.join(repo, "payload.bin"), new Uint8Array([0, 1, 2, 3, 4]));
  await runGit(repo, ["add", "contract.txt", "payload.bin"]);
  await runGit(repo, ["commit", "-q", "-m", "base"]);
  const baseOid = await runGit(repo, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repo, "contract.txt"), "task one contract\n");
  await writeFile(path.join(repo, "consumer.txt"), "consumer from task one\n");
  await runGit(repo, ["add", "contract.txt", "consumer.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "task one promotion"]);
  const firstPromotionOid = await runGit(repo, ["rev-parse", "HEAD"]);

  await writeFile(path.join(repo, "payload.bin"), new Uint8Array([0, 9, 8, 7, 6, 5]));
  await writeFile(path.join(repo, "added.txt"), "added by task two\n");
  await runGit(repo, ["add", "payload.bin", "added.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "task two promotion"]);
  const headOid = await runGit(repo, ["rev-parse", "HEAD"]);

  const spec = cumulativeSpec();
  const workflowId = "final-branch-cumulative-fixture";
  const store = new WorkflowStore(workflowId, {
    stateDirectory,
    now: () => "2026-07-20T20:01:00.000Z",
  });
  await store.create(initialState({
    workflowId,
    repo,
    baseOid,
    spec,
    taskIds: ["task-1", "task-2"],
  }));
  await store.transition({ expectedRevision: 0, to: "running-task" });
  await store.transition({ expectedRevision: 1, to: "promoting-task" });
  const state = await store.transition({
    expectedRevision: 2,
    to: "final-review",
    update(draft) {
      draft.currentTaskIndex = 2;
      draft.tasks = [{
        id: "task-1",
        runId: "run-task-1",
        candidateManifestHash: "a".repeat(64),
        eligibilityHash: "c".repeat(64),
        promotionCommitOid: firstPromotionOid,
        status: "promoted",
      }, {
        id: "task-2",
        runId: "run-task-2",
        candidateManifestHash: "b".repeat(64),
        eligibilityHash: "d".repeat(64),
        promotionCommitOid: headOid,
        status: "promoted",
      }];
    },
  });
  return {
    root,
    repo,
    store,
    workflowId,
    baseOid,
    headOid,
    firstPromotionOid,
    revision: state.revision,
    spec,
    evidence: [{
      taskId: "task-1",
      runId: "run-task-1",
      candidateManifestHash: "a".repeat(64),
      promotionCommitOid: firstPromotionOid,
      evidenceRefs: [
        "task-1/advisor.json",
        "task-1/fix-1.json",
        "task-1/review-correctness.json",
        "task-1/review-systems.json",
        "task-1/verification.json",
      ],
    }, {
      taskId: "task-2",
      runId: "run-task-2",
      candidateManifestHash: "b".repeat(64),
      promotionCommitOid: headOid,
      evidenceRefs: [
        "task-2/advisor.json",
        "task-2/fix-1.json",
        "task-2/review-correctness.json",
        "task-2/review-systems.json",
        "task-2/verification.json",
      ],
    }],
  };
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "final-branch-reviewer-")));
  temporaryDirectories.push(root);
  const repo = path.join(root, "repository");
  const stateDirectory = path.join(root, "state");
  await Promise.all([mkdir(repo), mkdir(stateDirectory)]);
  await runGit(repo, ["init", "-q", "-b", "main"]);
  await runGit(repo, ["config", "--local", "user.name", "Final Branch Test"]);
  await runGit(repo, ["config", "--local", "user.email", "final-branch@example.invalid"]);
  await writeFile(path.join(repo, "contract.txt"), "base contract\n");
  await runGit(repo, ["add", "contract.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "base"]);
  const baseOid = await runGit(repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "contract.txt"), "cumulative contract\n");
  await writeFile(path.join(repo, "added.txt"), "added by task\n");
  await runGit(repo, ["add", "contract.txt", "added.txt"]);
  await runGit(repo, ["commit", "-q", "-m", "task promotion"]);
  const headOid = await runGit(repo, ["rev-parse", "HEAD"]);

  const workflowId = "final-branch-fixture";
  const store = new WorkflowStore(workflowId, {
    stateDirectory,
    now: () => "2026-07-20T20:01:00.000Z",
  });
  await store.create(initialState({ workflowId, repo, baseOid }));
  await store.transition({ expectedRevision: 0, to: "running-task" });
  await store.transition({ expectedRevision: 1, to: "promoting-task" });
  const state = await store.transition({
    expectedRevision: 2,
    to: "final-review",
    update(draft) {
      draft.currentTaskIndex = 1;
      draft.tasks[0] = {
        id: "task-1",
        runId: "run-task-1",
        candidateManifestHash: "a".repeat(64),
        eligibilityHash: "c".repeat(64),
        promotionCommitOid: headOid,
        status: "promoted",
      };
    },
  });
  return {
    root,
    repo,
    store,
    workflowId,
    baseOid,
    headOid,
    revision: state.revision,
    evidence: {
      taskId: "task-1",
      runId: "run-task-1",
      candidateManifestHash: "a".repeat(64),
      promotionCommitOid: headOid,
      evidenceRefs: [
        "pipeline/verification.json",
        "pipeline/review-correctness.json",
        "pipeline/advisor.json",
        "pipeline/promotion.json",
      ],
    },
  };
}

function localBranchManager(f: FixtureCore): WorkflowBranchManager {
  const identity = {
    workflowId: f.workflowId,
    repositoryIdentity: path.join(f.repo, ".git"),
    worktreePath: f.repo,
    branchRef: "refs/heads/main",
    baseCommitOid: f.baseOid,
  } as WorkflowBranchIdentity;
  return {
    load: vi.fn().mockResolvedValue(identity),
    revalidate: vi.fn().mockImplementation(async (
      _identity: WorkflowBranchIdentity,
      expectedHead: string,
    ) => {
      const head = await git(f.repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const status = await git(f.repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
      return head.exitCode === 0 && head.stdout.trim() === expectedHead && status.stdout === ""
        ? { ok: true }
        : { ok: false, classification: "head-changed" };
    }),
  } as unknown as WorkflowBranchManager;
}

function reviewerFor(f: FixtureCore): FinalBranchReviewer {
  return new FinalBranchReviewer({
    branchManager: localBranchManager(f),
    workflowStore: () => f.store,
    evidenceStore: inMemoryEvidenceStore(new Map(), archivedRefsForFixture(f)),
    taskEvidenceValidator: async () => {},
  });
}

function evidenceKey(runId: string, reference: string): string {
  return `${runId}\0${reference}`;
}

function evidenceBytes(runId: string, reference: string): string {
  return `${JSON.stringify({ runId, reference, verdict: "frozen" })}\n`;
}

function expectedEvidenceRefs(references: string[]): string[] {
  return [...new Set([...references, ...requiredTaskEvidenceRefs])].sort();
}

function archivedRefsForFixture(f: FixtureCore): Map<string, string[]> {
  const fixtureEvidence = (f as Fixture | CumulativeFixture).evidence;
  const tasks = Array.isArray(fixtureEvidence) ? fixtureEvidence : [fixtureEvidence];
  return new Map(tasks.map(task => [
    task.runId,
    expectedEvidenceRefs(task.evidenceRefs),
  ]));
}

function inMemoryEvidenceStore(
  overrides = new Map<string, string | null>(),
  archivedRefs = new Map<string, string[]>(),
) {
  return (runId: string) => ({
    listEvidenceReferences: async (): Promise<string[]> =>
      archivedRefs.get(runId) ?? [...requiredTaskEvidenceRefs],
    readEvidence: async (reference: string): Promise<string | null> => {
      const key = evidenceKey(runId, reference);
      return overrides.has(key) ? overrides.get(key)! : evidenceBytes(runId, reference);
    },
  });
}

function finalSpec(): AutopilotSpec {
  return {
    specVersion: "1",
    topic: "final-branch-fixture",
    base: { remote: "origin", branch: "main" },
    tasks: [{
      id: "task-1",
      commitMessage: "task one",
      delegation: {
        specVersion: "1",
        objective: "implement task one",
        context: "",
        writeAllowlist: ["**"],
        forbiddenScope: [],
        successCriteria: ["task one works"],
        verification: [],
        executionMode: "edit",
        timeoutMs: 600_000,
        producerPreferences: ["codex"],
        expectedOutput: "candidate-patch",
      },
    }],
    finalSuccessCriteria: ["the cumulative branch works"],
    finalVerification: [{
      id: "final-test",
      executable: "node",
      args: ["--test"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "denied",
      expectedExitCodes: [0],
    }],
    shipping: {
      provider: "github",
      draft: true,
      markReadyWhenRequiredChecksPass: true,
      requiredChecksTimeoutMs: 600_000,
      pullRequestTitle: "Final branch fixture",
      pullRequestBody: "Fixture body",
    },
  };
}

function cumulativeSpec(): AutopilotSpec {
  const spec = finalSpec();
  return {
    ...spec,
    tasks: [
      ...spec.tasks,
      {
        id: "task-2",
        commitMessage: "task two",
        delegation: {
          ...structuredClone(spec.tasks[0]!.delegation),
          objective: "implement task two",
        },
      },
    ],
  };
}

function passingVerification(): AcceptanceVerifyResult {
  return {
    ok: true,
    failures: [],
    evidence: { commands: ["final-test"] },
    commandOutcomes: [{
      id: "final-test",
      executable: "node",
      args: ["--test"],
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdoutRef: "logs/final-test.stdout.log",
      stderrRef: "logs/final-test.stderr.log",
    }],
  };
}

const approvingReview: ReviewReport = {
  reportVersion: "1",
  verdict: "approve",
  findings: [],
  coverageGaps: [],
};

function roleOutput(value: unknown): RoleRunResult {
  return {
    ok: true,
    rawOutput: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    failure: null,
    producerId: "fixture",
  };
}

function approvingRoleRunner(args: RoleRunArgs): Promise<RoleRunResult> {
  return Promise.resolve(roleOutput(args.role === "advisor" ? {
    reportVersion: "1",
    verdict: "approve",
    rationale: "The frozen evidence covers every final criterion.",
    risks: [],
    coverageGaps: [],
  } : approvingReview));
}

function finalReviewerFor(f: FixtureCore, overrides: {
  verify?: (args: AcceptanceVerifyArgs) => Promise<AcceptanceVerifyResult>;
  roleRunner?: (args: RoleRunArgs) => Promise<RoleRunResult>;
  cleanup?: () => Promise<void>;
  git?: typeof git;
  evidence?: Map<string, string | null>;
  materializeFailure?: Error;
  useDefaultVerifier?: boolean;
  now?: () => string;
} = {}): FinalBranchReviewer {
  let materializationIndex = 0;
  return new FinalBranchReviewer({
    ...(overrides.git === undefined ? {} : { git: overrides.git }),
    branchManager: localBranchManager(f),
    workflowStore: () => f.store,
    ...(overrides.useDefaultVerifier === true ? {} : {
      acceptanceVerifier: { verify: overrides.verify ?? (async () => passingVerification()) },
    }),
    roleRunner: overrides.roleRunner ?? approvingRoleRunner,
    artifactStore: () => ({ writeLog: async name => `logs/${name}.log` }),
    evidenceStore: inMemoryEvidenceStore(overrides.evidence, archivedRefsForFixture(f)),
    taskEvidenceValidator: async () => {},
    materialize: async ({ headCommitOid }) => {
      if (overrides.materializeFailure !== undefined) throw overrides.materializeFailure;
      const scratch = path.join(f.root, `final-materialization-${materializationIndex++}`);
      await runGit(f.repo, ["worktree", "add", "--detach", scratch, headCommitOid]);
      return {
        path: scratch,
        cleanup: overrides.cleanup ?? (async () => {
          await runGit(f.repo, ["worktree", "remove", "--force", scratch]);
        }),
      };
    },
    now: overrides.now ?? (() => "2026-07-20T20:02:00.000Z"),
  });
}

async function freezeForFinalReview(f: Fixture, reviewer: FinalBranchReviewer) {
  return await reviewer.freezeCumulativeArtifact({
    workflowId: f.workflowId,
    expectedRevision: f.revision,
    taskEvidence: [f.evidence],
  });
}

describe("FinalBranchReport v1", () => {
  const valid = {
    reportVersion: "1",
    workflowId: "workflow-1",
    baseCommitOid: "1".repeat(40),
    headCommitOid: "2".repeat(40),
    branchArtifactHash: "3".repeat(64),
    verificationHash: "4".repeat(64),
    reviewHashes: ["5".repeat(64), "6".repeat(64)],
    advisorHash: "7".repeat(64),
    taskEvidenceHashes: ["8".repeat(64)],
    eligible: true,
    reasons: [],
    status: "ready-to-ship",
    evaluatedAt: "2026-07-20T20:00:00.000Z",
  } satisfies FinalBranchReport;

  it("strictly mirrors every FinalBranchReport field", () => {
    expect(validateFinalBranchReport(valid)).toBe(true);
    expect(validateFinalBranchReport({ ...valid, unknown: true })).toBe(false);
    for (const key of Object.keys(valid)) {
      const missing = { ...valid } as Record<string, unknown>;
      delete missing[key];
      expect(validateFinalBranchReport(missing), key).toBe(false);
    }
  });
});

describe("FinalBranchReviewer cumulative artifact", () => {
  it("freezes the whole branch and atomically persists its canonical hash", async () => {
    const f = await fixture();
    const reviewer = reviewerFor(f);
    const artifact = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [{
        ...f.evidence,
        evidenceRefs: [
          ...f.evidence.evidenceRefs.slice().reverse(),
          "pipeline/advisor.json",
        ],
      }],
    });

    expect(artifact).toMatchObject({
      artifactVersion: "1",
      workflowId: f.workflowId,
      baseCommitOid: f.baseOid,
      headCommitOid: f.headOid,
      taskEvidence: [{
        taskId: "task-1",
        runId: "run-task-1",
        candidateManifestHash: "a".repeat(64),
        promotionCommitOid: f.headOid,
      }],
    });
    expect(artifact.changedPaths.map(change => change.path)).toEqual(["added.txt", "contract.txt"]);
    expect(artifact.patch).toContain("diff --git a/added.txt b/added.txt");
    expect(artifact.patch).toMatch(/index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64}/u);
    expect(artifact.taskEvidence[0]!.evidenceRefs).toEqual(
      expectedEvidenceRefs(f.evidence.evidenceRefs),
    );
    expect(artifact.taskEvidence[0]!.evidence).toEqual(
      artifact.taskEvidence[0]!.evidenceRefs.map(reference => ({
        reference,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        content: evidenceBytes("run-task-1", reference),
      })),
    );
    const { branchArtifactHash, ...unhashed } = artifact;
    expect(branchArtifactHash).toBe(branchArtifactHashOf(unhashed));
    const persisted = JSON.parse(await readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_ARTIFACT_REF),
      "utf8",
    )) as typeof artifact;
    expect(persisted).toEqual(artifact);
    const verification = vi.fn(async () => JSON.parse(await readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_ARTIFACT_REF),
      "utf8",
    )) as typeof artifact);
    expect(await reviewer.runHeadBoundPhase(
      artifact,
      "verification",
      verification,
      f.repo,
    )).toEqual(artifact);
    expect(verification).toHaveBeenCalledOnce();
  });

  it("keeps the artifact hash stable across reordered and duplicate evidence refs", async () => {
    const f = await fixture();
    const reviewer = reviewerFor(f);
    const first = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [f.evidence],
    });
    const second = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [{
        ...f.evidence,
        evidenceRefs: [...f.evidence.evidenceRefs.slice().reverse(), f.evidence.evidenceRefs[0]!],
      }],
    });

    expect(second.branchArtifactHash).toBe(first.branchArtifactHash);
    expect(second).toEqual(first);
  });

  it("detects head drift before verification executes", async () => {
    const f = await fixture();
    const reviewer = reviewerFor(f);
    const artifact = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [f.evidence],
    });
    await writeFile(path.join(f.repo, "drift.txt"), "unreviewed branch bytes\n");
    await runGit(f.repo, ["add", "drift.txt"]);
    await runGit(f.repo, ["commit", "-q", "-m", "drift"]);
    const verification = vi.fn(async () => ({ pass: true }));

    await expect(reviewer.runHeadBoundPhase(
      artifact,
      "verification",
      verification,
      f.repo,
    )).rejects.toMatchObject({ classification: "head-changed" });
    expect(verification).not.toHaveBeenCalled();
  });

  it("detects head drift introduced during a later phase", async () => {
    const f = await fixture();
    const reviewer = reviewerFor(f);
    const artifact = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [f.evidence],
    });

    await expect(reviewer.runHeadBoundPhase(artifact, "correctness-review", async () => {
      await writeFile(path.join(f.repo, "during-review.txt"), "drift\n");
      await runGit(f.repo, ["add", "during-review.txt"]);
      await runGit(f.repo, ["commit", "-q", "-m", "review drift"]);
      return { verdict: "approve" };
    }, f.repo)).rejects.toMatchObject({ classification: "head-changed" });
  });

  it("fails closed when cumulative task evidence is missing", async () => {
    const f = await fixture();
    await expect(reviewerFor(f).freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [],
    })).rejects.toMatchObject({ classification: "missing-task-evidence" });
  });

  it("fails closed when a referenced evidence artifact is missing", async () => {
    const f = await fixture();
    const missing = new Map<string, string | null>([[
      evidenceKey(f.evidence.runId, f.evidence.evidenceRefs[0]!),
      null,
    ]]);
    const reviewer = new FinalBranchReviewer({
      branchManager: localBranchManager(f),
      workflowStore: () => f.store,
      evidenceStore: inMemoryEvidenceStore(missing, archivedRefsForFixture(f)),
      taskEvidenceValidator: async () => {},
    });

    await expect(freezeForFinalReview(f, reviewer)).rejects.toMatchObject({
      classification: "missing-task-evidence",
    });
  });

  it("uses the production archive validator before trusting caller-listed evidence", async () => {
    const f = await fixture();
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = path.join(f.root, "production-evidence-state");
    try {
      const archive = new ArtifactStore(f.evidence.runId);
      await archive.writePipelineArtifact("pipeline-result", { runId: f.evidence.runId });
      const reviewer = new FinalBranchReviewer({
        branchManager: localBranchManager(f),
        workflowStore: () => f.store,
      });

      await expect(freezeForFinalReview(f, reviewer)).rejects.toMatchObject({
        classification: "missing-task-evidence",
      });
    } finally {
      if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });

  it("rejects traversal before consulting the evidence store", async () => {
    const f = await fixture();
    const readEvidence = vi.fn(async () => "unexpected");
    const reviewer = new FinalBranchReviewer({
      branchManager: localBranchManager(f),
      workflowStore: () => f.store,
      evidenceStore: () => ({
        readEvidence,
        listEvidenceReferences: async () => [...requiredTaskEvidenceRefs],
      }),
      taskEvidenceValidator: async () => {},
    });

    await expect(reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [{ ...f.evidence, evidenceRefs: ["../decision.json"] }],
    })).rejects.toMatchObject({ classification: "missing-task-evidence" });
    expect(readEvidence).not.toHaveBeenCalled();
  });

  it("rejects evidence bytes changed after the artifact was frozen", async () => {
    const f = await fixture();
    const evidence = new Map<string, string | null>();
    const reviewer = new FinalBranchReviewer({
      branchManager: localBranchManager(f),
      workflowStore: () => f.store,
      evidenceStore: inMemoryEvidenceStore(evidence, archivedRefsForFixture(f)),
      taskEvidenceValidator: async () => {},
    });
    const artifact = await freezeForFinalReview(f, reviewer);
    evidence.set(
      evidenceKey(f.evidence.runId, f.evidence.evidenceRefs[0]!),
      "tampered evidence\n",
    );
    const execute = vi.fn(async () => true);

    await expect(reviewer.runHeadBoundPhase(
      artifact,
      "tampered-evidence",
      execute,
      f.repo,
    )).rejects.toMatchObject({ classification: "missing-task-evidence" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("derives complete task evidence from the archive and tracks unlisted repairs", async () => {
    const f = await fixture();
    const repairRef = "pipeline/round-1-fix.json";
    const archivedRefs = archivedRefsForFixture(f);
    archivedRefs.set(f.evidence.runId, [
      ...archivedRefs.get(f.evidence.runId)!,
      repairRef,
    ].sort());
    const evidence = new Map<string, string | null>();
    const reviewer = new FinalBranchReviewer({
      branchManager: localBranchManager(f),
      workflowStore: () => f.store,
      evidenceStore: inMemoryEvidenceStore(evidence, archivedRefs),
      taskEvidenceValidator: async () => {},
    });

    const artifact = await freezeForFinalReview(f, reviewer);
    expect(artifact.taskEvidence[0]!.evidenceRefs).toContain(repairRef);
    expect(artifact.taskEvidence[0]!.evidence.find(item => item.reference === repairRef))
      .toMatchObject({ content: evidenceBytes(f.evidence.runId, repairRef) });

    const frozenReferences = [...archivedRefs.get(f.evidence.runId)!];
    archivedRefs.set(f.evidence.runId, [
      ...frozenReferences,
      "pipeline/unlisted-advisor.json",
    ].sort());
    await expect(reviewer.runHeadBoundPhase(
      artifact,
      "complete-evidence-membership-revalidation",
      async () => true,
      f.repo,
    )).rejects.toMatchObject({ classification: "missing-task-evidence" });

    archivedRefs.set(f.evidence.runId, frozenReferences);
    evidence.set(evidenceKey(f.evidence.runId, repairRef), "tampered repair evidence\n");
    await expect(reviewer.runHeadBoundPhase(
      artifact,
      "complete-evidence-revalidation",
      async () => true,
      f.repo,
    )).rejects.toMatchObject({ classification: "missing-task-evidence" });
  });

  it("rejects a promoted task commit outside the direct base-to-head chain", async () => {
    const f = await fixture();
    const unrelated = await runGit(f.repo, [
      "commit-tree",
      `${f.headOid}^{tree}`,
      "-p",
      f.baseOid,
      "-m",
      "unrelated promotion",
    ]);
    const state = await f.store.read();
    state.tasks[0]!.promotionCommitOid = unrelated;
    await writeFile(f.store.statePath, `${JSON.stringify(state, null, 2)}\n`);

    await expect(reviewerFor(f).freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [{ ...f.evidence, promotionCommitOid: unrelated }],
    })).rejects.toMatchObject({ classification: "workflow-state-mismatch" });
  });

  it("detects uncommitted source checkout drift", async () => {
    const f = await fixture();
    const reviewer = reviewerFor(f);
    const artifact = await freezeForFinalReview(f, reviewer);
    await writeFile(path.join(f.repo, "contract.txt"), "dirty source bytes\n");
    const execute = vi.fn(async () => true);

    await expect(reviewer.runHeadBoundPhase(
      artifact,
      "dirty-source",
      execute,
      f.repo,
    )).rejects.toMatchObject({ classification: "head-changed" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("FinalBranchReviewer strict final gate", () => {
  it("gives every final role the complete cumulative evidence package and no conversation channel", async () => {
    const f = await cumulativeFixture();
    const calls: RoleRunArgs[] = [];
    const reviewer = finalReviewerFor(f, {
      roleRunner: async args => {
        calls.push(args);
        return await approvingRoleRunner(args);
      },
    });
    const artifact = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: f.evidence,
    });
    const expectedDiff = await git(f.repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--full-index",
      f.baseOid,
      `${f.headOid}^{tree}`,
    ]);
    expect(expectedDiff.exitCode, expectedDiff.stderr).toBe(0);

    await reviewer.runFinalReview({
      artifact,
      autopilotSpec: f.spec,
      checkoutPath: f.repo,
    });

    expect(calls.map(call => call.role)).toEqual([
      "reviewer-correctness",
      "reviewer-systems",
      "advisor",
    ]);
    expect(new Set(calls.map(call => call.pkg)).size).toBe(1);
    const pkg = calls[0]!.pkg;
    expect(Object.keys(pkg).sort()).toEqual([
      "advisorEvidence",
      "baselineCommit",
      "candidateCommit",
      "candidateDiff",
      "spec",
      "testEvidence",
    ]);
    expect(pkg).not.toHaveProperty("progress");
    expect(pkg).not.toHaveProperty("conversation");
    expect(pkg).not.toHaveProperty("messages");
    expect(pkg.spec.context).toBe("");
    expect(pkg.spec.objective).toContain("[task-2] implement task two");
    expect(pkg.spec.successCriteria).toContain("[task-2] task one works");
    expect(pkg.baselineCommit).toBe(f.baseOid);
    expect(pkg.candidateCommit).toBe(f.headOid);
    expect(pkg.candidateDiff).toBe(expectedDiff.stdout);
    expect(pkg.candidateDiff).toContain("GIT binary patch");
    expect(pkg.candidateDiff).toContain("diff --git a/contract.txt b/contract.txt");
    expect(pkg.candidateDiff).toContain("diff --git a/payload.bin b/payload.bin");

    expect(artifact.taskEvidence.map(evidence => ({
      taskId: evidence.taskId,
      runId: evidence.runId,
      candidateManifestHash: evidence.candidateManifestHash,
      promotionCommitOid: evidence.promotionCommitOid,
    }))).toEqual([{
      taskId: "task-1",
      runId: "run-task-1",
      candidateManifestHash: "a".repeat(64),
      promotionCommitOid: f.firstPromotionOid,
    }, {
      taskId: "task-2",
      runId: "run-task-2",
      candidateManifestHash: "b".repeat(64),
      promotionCommitOid: f.headOid,
    }]);
    expect(artifact.taskEvidence.flatMap(evidence => evidence.evidenceRefs)).toEqual(
      f.evidence.flatMap(evidence => expectedEvidenceRefs(evidence.evidenceRefs)),
    );

    const testEvidence = JSON.parse(pkg.testEvidence) as Record<string, unknown>;
    expect(testEvidence).toEqual(pkg.advisorEvidence);
    expect(testEvidence).toMatchObject({
      autopilotSpec: f.spec,
      artifact: {
        patch: expectedDiff.stdout,
        taskEvidence: artifact.taskEvidence,
      },
      taskEvidence: artifact.taskEvidence,
      verification: passingVerification(),
    });
  });

  it("persists a green report whose hashes bind every frozen evidence object", async () => {
    const f = await fixture();
    const packages: RolePackage[] = [];
    const reviewer = finalReviewerFor(f, {
      roleRunner: async args => {
        packages.push(args.pkg);
        return await approvingRoleRunner(args);
      },
    });
    const artifact = await freezeForFinalReview(f, reviewer);
    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report).toMatchObject({ eligible: true, status: "ready-to-ship", reasons: [] });
    expect(new Set(packages).size).toBe(1);
    const evidence = await Promise.all([
      FINAL_VERIFICATION_REF,
      FINAL_CORRECTNESS_REVIEW_REF,
      FINAL_SYSTEMS_REVIEW_REF,
      FINAL_ADVISOR_REF,
    ].map(async reference => JSON.parse(await readFile(
      path.join(f.store.workflowDirectory, reference),
      "utf8",
    )) as unknown));
    expect(report.verificationHash).toBe(canonicalArtifactHash(evidence[0]));
    expect(report.reviewHashes).toEqual([
      canonicalArtifactHash(evidence[1]),
      canonicalArtifactHash(evidence[2]),
    ]);
    expect(report.advisorHash).toBe(canonicalArtifactHash(evidence[3]));
    expect(report.taskEvidenceHashes).toEqual([
      canonicalArtifactHash(artifact.taskEvidence[0]),
    ]);
    const persistedReport: unknown = JSON.parse(await readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_REPORT_REF),
      "utf8",
    ));
    expect(
      validateFinalBranchReport(persistedReport),
      JSON.stringify(validateFinalBranchReport.errors),
    ).toBe(true);
    expect(persistedReport).toEqual(report);
  });

  it("implements review() as the public freeze-and-gate operation", async () => {
    const f = await fixture();
    const worktrees = new Set<string>();
    const reviewer = finalReviewerFor(f, {
      verify: async args => {
        worktrees.add(args.worktreePath);
        return passingVerification();
      },
      roleRunner: async args => {
        worktrees.add(args.worktreePath);
        return await approvingRoleRunner(args);
      },
    });

    const report = await reviewer.review({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: [f.evidence],
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report).toMatchObject({ eligible: true, status: "ready-to-ship" });
    expect(worktrees.size).toBe(4);
  });

  it("proves a multi-commit cumulative artifact without suppressing structural failures", async () => {
    const f = await cumulativeFixture();
    const reviewer = finalReviewerFor(f, { useDefaultVerifier: true });
    const artifact = await reviewer.freezeCumulativeArtifact({
      workflowId: f.workflowId,
      expectedRevision: f.revision,
      taskEvidence: f.evidence,
    });

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: f.spec,
      checkoutPath: f.repo,
    });

    expect(report.reasons).not.toContain("final verification failed: artifact-divergence");
    expect(report.reasons).not.toContain("final verification failed: base-changed");
  });

  it("fails verification when it dirties its materialization and reviews pristine fresh bytes", async () => {
    const f = await fixture();
    const roleWorktrees = new Set<string>();
    const reviewer = finalReviewerFor(f, {
      verify: async args => {
        await writeFile(path.join(args.worktreePath, "contract.txt"), "verification mutation\n");
        return passingVerification();
      },
      roleRunner: async args => {
        roleWorktrees.add(args.worktreePath);
        expect(await readFile(path.join(args.worktreePath, "contract.txt"), "utf8"))
          .toBe("cumulative contract\n");
        return await approvingRoleRunner(args);
      },
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons.some(reason => reason.includes("checkout is dirty"))).toBe(true);
    expect(roleWorktrees.size).toBe(3);
  });

  it("fails closed when a final verification command fails", async () => {
    const f = await fixture();
    const failed = passingVerification();
    failed.ok = false;
    failed.failures = ["final-test exited with 1"];
    failed.commandOutcomes[0]!.exitCode = 1;
    const reviewer = finalReviewerFor(f, { verify: async () => failed });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.status).toBe("human-decision-required");
    expect(report.reasons).toContain("final verification failed: final-test exited with 1");
  });

  it("fails closed when no final verification command applies", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f, {
      verify: async () => ({ ok: true, failures: [], evidence: {}, commandOutcomes: [] }),
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("final verification had zero applicable commands");
  });

  it.each([
    { exitCode: 1, timedOut: false },
    { exitCode: null, timedOut: true },
  ])("rejects an internally inconsistent green verification result: %o", async outcome => {
    const f = await fixture();
    const inconsistent = passingVerification();
    inconsistent.commandOutcomes[0] = {
      ...inconsistent.commandOutcomes[0]!,
      ...outcome,
    };
    const reviewer = finalReviewerFor(f, { verify: async () => inconsistent });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("final verification command was not green: final-test");
  });

  it("revalidates the source immediately before final report publication", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f, {
      now: () => {
        writeFileSync(path.join(f.repo, "contract.txt"), "post-advisor drift\n");
        return "2026-07-20T20:02:00.000Z";
      },
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    await expect(reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    })).rejects.toMatchObject({ classification: "head-changed" });
    await expect(readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_REPORT_REF),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates every frozen task artifact before final report publication", async () => {
    const f = await fixture();
    const evidence = new Map<string, string | null>();
    const reference = f.evidence.evidenceRefs[0]!;
    const reviewer = finalReviewerFor(f, {
      evidence,
      now: () => {
        evidence.set(evidenceKey(f.evidence.runId, reference), "post-advisor tampering\n");
        return "2026-07-20T20:02:00.000Z";
      },
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    await expect(reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    })).rejects.toMatchObject({ classification: "missing-task-evidence" });
    await expect(readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_REPORT_REF),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a changed source head between fresh roles", async () => {
    const f = await fixture();
    const roles: string[] = [];
    let correctnessReturned = false;
    let correctnessPostRevalidated = false;
    let drifted = false;
    const reviewer = finalReviewerFor(f, {
      git: async (cwd, args, options) => {
        const sourceHeadRead = cwd === f.repo
          && args[0] === "rev-parse"
          && args.includes("HEAD^{commit}");
        if (sourceHeadRead && correctnessReturned) {
          if (!correctnessPostRevalidated) {
            correctnessPostRevalidated = true;
          } else if (!drifted) {
            drifted = true;
            await writeFile(path.join(f.repo, "between-roles.txt"), "unreviewed\n");
            await runGit(f.repo, ["add", "between-roles.txt"]);
            await runGit(f.repo, ["commit", "-q", "-m", "head drift between roles"]);
          }
        }
        return await git(cwd, args, options);
      },
      roleRunner: async args => {
        roles.push(args.role);
        if (args.role === "reviewer-correctness") {
          correctnessReturned = true;
        }
        return await approvingRoleRunner(args);
      },
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    await expect(reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    })).rejects.toMatchObject({ classification: "head-changed" });

    expect(roles).toEqual(["reviewer-correctness"]);
    await expect(readFile(
      path.join(f.store.workflowDirectory, FINAL_BRANCH_REPORT_REF),
      "utf8",
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an advisor coverage gap", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f, {
      roleRunner: async args => args.role === "advisor"
        ? roleOutput({
          reportVersion: "1",
          verdict: "approve",
          rationale: "The reviewed evidence is incomplete.",
          risks: [],
          coverageGaps: ["Windows behavior was not covered."],
        })
        : roleOutput(approvingReview),
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("advisor reported coverage gaps");
  });

  it("fails closed on invalid structured role output", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f, {
      roleRunner: async args => args.role === "reviewer-systems"
        ? roleOutput({ reportVersion: "1", verdict: "approve" })
        : await approvingRoleRunner(args),
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("systems review requested changes");
    expect(report.reasons).toContain("systems review reported coverage gaps");
  });

  it("fails closed when a fresh materialization cannot be created", async () => {
    const f = await fixture();
    const roleRunner = vi.fn(approvingRoleRunner);
    const reviewer = finalReviewerFor(f, {
      materializeFailure: new Error("fixture materialization failure"),
      roleRunner,
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons.some(reason => reason.includes("materialization failure"))).toBe(true);
    expect(roleRunner).not.toHaveBeenCalled();
  });

  it("catches a cross-task interface break only visible to the final review", async () => {
    const f = await fixture();
    const interfaceBreak: ReviewReport = {
      reportVersion: "1",
      verdict: "request-changes",
      findings: [{
        severity: "major",
        location: "contract.txt:1",
        claim: "The cumulative contract no longer matches the consumer added by another task.",
        evidence: "The frozen whole-branch diff contains incompatible producer and consumer shapes.",
        reproduction: "Exercise the consumer against the cumulative contract.",
        requiredOutcome: "Restore one compatible cross-task interface.",
        confidence: 1,
      }],
      coverageGaps: [],
    };
    const reviewer = finalReviewerFor(f, {
      roleRunner: async args => args.role === "reviewer-correctness"
        ? roleOutput(interfaceBreak)
        : await approvingRoleRunner(args),
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons).toContain("correctness review reported blocking findings");
  });

  it("makes scratch-worktree cleanup failures visible in the strict report", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f, {
      cleanup: async () => { throw new Error("fixture cleanup failure"); },
    });
    const artifact = await freezeForFinalReview(f, reviewer);

    const report = await reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    });

    expect(report.eligible).toBe(false);
    expect(report.reasons.some(reason => reason.includes("cleanup failed"))).toBe(true);
  });

  it("rejects an atomic final-report publication collision", async () => {
    const f = await fixture();
    const reviewer = finalReviewerFor(f);
    const artifact = await freezeForFinalReview(f, reviewer);
    await writeFile(path.join(f.store.workflowDirectory, FINAL_BRANCH_REPORT_REF), "{}\n");

    await expect(reviewer.runFinalReview({
      artifact,
      autopilotSpec: finalSpec(),
      checkoutPath: f.repo,
    })).rejects.toMatchObject({ classification: "artifact-persistence-failed" });
  });
});
