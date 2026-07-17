import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  CandidateArtifact,
  AttemptResult,
  CommandOutcome,
  FailureClassification,
} from "../protocol/attempt-result.js";
import {
  resolveReviewConfig,
  type DelegationSpec,
  type ReviewerKind,
} from "../protocol/delegation-spec.js";
import { loadSchemas } from "../protocol/schema-loader.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";
import {
  runAttempt as defaultRunAttempt,
  type AttemptRuntimeDependencies,
} from "../runtime/attempt-runtime.js";
import { ArtifactStore } from "../runtime/artifact-store.js";
import { RuntimeError } from "../util/errors.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import {
  recomputeManifest,
  structuralVerify,
  type StructuralFailure,
} from "../verify/structural-verifier.js";
import { consolidate, type ConsolidationResult } from "./consolidator.js";
import { evaluateGates, type GateResult } from "./gates.js";
import type {
  FixReport,
  ReviewReport,
  VerificationReport,
} from "./report-types.js";
import type { PipelineRole, RolePackage } from "./role-prompts.js";
import {
  runRole as defaultRunRole,
  type RoleRunArgs,
  type RoleRunResult,
} from "./role-runner.js";
import { parseStructuredReport } from "./structured-output.js";

export interface PipelineRound {
  round: number;
  reviews: { reviewer: string; report: ReviewReport }[];
  consolidated: ConsolidationResult;
  fix: FixReport | null;
  roleLogRefs: string[];
}

export interface PipelineResult {
  runId: string;
  status: "decision-ready" | "human-decision-required" | "failed";
  attempt: AttemptResult;
  rounds: PipelineRound[];
  verification: PipelineVerificationReport | null;
  gate: GateResult;
  finalCandidateCommit: string;
  failure?: FailureClassification | null;
}

export interface PipelineVerificationEvidence {
  failures: string[];
  acceptance: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
}

export interface PipelineVerificationReport extends VerificationReport {
  evidence: PipelineVerificationEvidence;
}

export interface PipelineDependencies extends AttemptRuntimeDependencies {
  registry: ProducerRegistry;
  roleRunner?: (args: RoleRunArgs) => Promise<RoleRunResult>;
  runAttempt?: (
    checkoutPath: string,
    spec: DelegationSpec,
    deps: AttemptRuntimeDependencies,
  ) => Promise<AttemptResult>;
}

interface ParsedReview {
  reviewer: ReviewerKind;
  report: ReviewReport;
}

type ReviewRunResult =
  | { ok: true; reviews: ParsedReview[]; roleLogRefs: string[] }
  | { ok: false; failedRoleLogRef: string; roleLogRefs: string[] };

type FixRunResult =
  | { ok: true; fix: FixReport; roleLogRefs: string[] }
  | {
    ok: false;
    failure: FailureClassification;
    failedRoleLogRef: string;
    roleLogRefs: string[];
  };

const schemas = loadSchemas();
const IGNORED_STRUCTURAL_FAILURES = new Set<StructuralFailure>([
  "artifact-divergence",
  "base-changed",
]);

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

function roleArgs(args: {
  role: PipelineRole;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
}): RoleRunArgs {
  const ps = args.deps.ps ?? getPlatformServices();
  return {
    role: args.role,
    baseSpec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    ps,
    registry: args.deps.registry,
    runId: args.runId,
    ...(args.deps.env === undefined ? {} : { env: args.deps.env }),
    ...(args.deps.abortSignal === undefined ? {} : { abortSignal: args.deps.abortSignal }),
  };
}

async function runArchivedRole(
  runner: (args: RoleRunArgs) => Promise<RoleRunResult>,
  args: RoleRunArgs,
  store: ArtifactStore,
  logName: string,
): Promise<{ result: RoleRunResult; logRef: string }> {
  const result = await runner(args);
  const output = result.rawOutput === ""
    ? `role produced no stdout; failure: ${result.failure ?? "none"}\n`
    : result.archiveSafeRawOutput ?? result.rawOutput;
  const logRef = await store.writeLog(logName, output);
  return { result, logRef };
}

function failedResult(
  attempt: AttemptResult,
  rounds: PipelineRound[],
  finalCandidateCommit: string,
  reason: string,
  failure: FailureClassification = "producer-failure",
): PipelineResult {
  return {
    runId: attempt.runId,
    status: "failed",
    attempt,
    rounds,
    verification: null,
    gate: {
      decisionReady: false,
      requiresHumanDecision: false,
      reasons: [reason],
    },
    finalCandidateCommit,
    failure,
  };
}

function testEvidence(attempt: AttemptResult): string {
  return JSON.stringify(attempt.executedVerification.map(outcome => ({
    id: outcome.id,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  })));
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globMatches(pattern: string, candidate: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === undefined) break;
    if (character !== "*") {
      expression += escapeRegex(character);
      continue;
    }
    if (pattern[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }
    index += 1;
    if (pattern[index + 1] === "/") {
      expression += "(?:.*/)?";
      index += 1;
    } else {
      expression += ".*";
    }
  }
  return new RegExp(`${expression}$`).test(candidate);
}

async function candidateArtifact(args: {
  worktreePath: string;
  baselineCommit: string;
  candidateCommit: string;
  anchorRef: string;
  diffText: string;
}): Promise<CandidateArtifact> {
  const artifact: CandidateArtifact = {
    baseCommitOid: args.baselineCommit,
    candidateTreeOid: (await checkedGit(
      args.worktreePath,
      ["rev-parse", `${args.candidateCommit}^{tree}`],
    )).trim(),
    candidateCommitOid: args.candidateCommit,
    anchorRef: args.anchorRef,
    manifestHash: "",
    changedPaths: [],
    patch: args.diffText,
  };
  const canonical = await recomputeManifest({
    worktreePath: args.worktreePath,
    baseCommitOid: args.baselineCommit,
    artifact,
  });
  return {
    ...artifact,
    changedPaths: canonical.changedPaths,
    manifestHash: canonical.manifestHash,
  };
}

export function detectWeakenedTests(diff: string): { testsDeleted: number; testsSkipped: number } {
  let testsDeleted = 0;
  let testsSkipped = 0;
  let currentFileIsTest = false;
  for (const line of diff.split("\n")) {
    if (/^deleted file mode/.test(line)) {
      if (currentFileIsTest) testsDeleted++;
    }
    if (/^diff --git a\/(\S+)/.test(line)) {
      currentFileIsTest = /(^|\/)tests?\/|\.test\.|\.spec\./.test(line);
    }
    if (currentFileIsTest && /^\+.*\b(it|test|describe)\.(skip|todo)\(/.test(line)) testsSkipped++;
    if (currentFileIsTest && /^\+.*\bxit\(|^\+.*\bxdescribe\(/.test(line)) testsSkipped++;
  }
  return { testsDeleted, testsSkipped };
}

async function runReviews(args: {
  reviewers: ReviewerKind[];
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
}): Promise<ReviewRunResult> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const outcomes = await Promise.all(args.reviewers.map(async reviewer => {
    const role = `reviewer-${reviewer}` as const;
    const callArgs = roleArgs({
      role,
      spec: args.spec,
      pkg: args.pkg,
      worktreePath: args.worktreePath,
      deps: args.deps,
      runId: args.runId,
    });
    const logName = `role-${role}-round${args.round}`;
    const initial = await runArchivedRole(runner, callArgs, args.store, logName);
    const roleLogRefs = [initial.logRef];
    if (!initial.result.ok) {
      return { review: null, initialLogRef: initial.logRef, roleLogRefs };
    }
    const outcome = await parseStructuredReport<ReviewReport>(
      initial.result.rawOutput,
      schemas.reviewReport,
      async validationErrors => {
        void validationErrors;
        const repair = await runArchivedRole(
          runner,
          callArgs,
          args.store,
          `${logName}-repair`,
        );
        roleLogRefs.push(repair.logRef);
        return repair.result.ok ? repair.result.rawOutput : "";
      },
    );
    return {
      review: outcome.ok ? { reviewer, report: outcome.value } : null,
      initialLogRef: initial.logRef,
      roleLogRefs,
    };
  }));
  const roleLogRefs = outcomes.flatMap(outcome => outcome.roleLogRefs);
  const reviews = outcomes.map(outcome => outcome.review);
  if (reviews.every((review): review is ParsedReview => review !== null)) {
    return { ok: true, reviews, roleLogRefs };
  }
  const failed = outcomes.find(outcome => outcome.review === null);
  if (failed === undefined) throw new Error("unreachable invalid review state");
  return { ok: false, failedRoleLogRef: failed.initialLogRef, roleLogRefs };
}

async function runFix(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  round: number;
  store: ArtifactStore;
}): Promise<FixRunResult> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const callArgs = roleArgs({
    role: "fixer",
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
  });
  const logName = `role-fixer-round${args.round}`;
  const initial = await runArchivedRole(runner, callArgs, args.store, logName);
  const roleLogRefs = [initial.logRef];
  if (!initial.result.ok) {
    return {
      ok: false,
      failure: initial.result.failure ?? "producer-failure",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
  }
  const outcome = await parseStructuredReport<FixReport>(
    initial.result.rawOutput,
    schemas.fixReport,
    async validationErrors => {
      void validationErrors;
      const repair = await runArchivedRole(
        runner,
        callArgs,
        args.store,
        `${logName}-repair`,
      );
      roleLogRefs.push(repair.logRef);
      return repair.result.ok ? repair.result.rawOutput : "";
    },
  );
  return outcome.ok
    ? { ok: true, fix: outcome.value, roleLogRefs }
    : {
      ok: false,
      failure: "invalid-output",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
}

interface FixProvenanceFailure {
  failure: FailureClassification;
  reason: string;
}

async function validateFixProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  fix: FixReport;
}): Promise<FixProvenanceFailure | null> {
  const candidateObject = await git(args.worktreePath, [
    "cat-file",
    "-e",
    `${args.fix.candidateCommit}^{commit}`,
  ]);
  if (candidateObject.exitCode !== 0) {
    return {
      failure: "producer-failure",
      reason: "fix phase reported a missing candidate commit",
    };
  }

  const head = await git(args.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head.exitCode !== 0 || head.stdout.trim() !== args.fix.candidateCommit) {
    return {
      failure: "producer-failure",
      reason: "fix phase reported a candidate commit that does not match its worktree HEAD",
    };
  }

  const candidateAncestry = await git(args.worktreePath, [
    "merge-base",
    "--is-ancestor",
    args.previousCandidateCommit,
    args.fix.candidateCommit,
  ]);
  if (candidateAncestry.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: "fix phase candidate commit is not descended from the reviewed candidate",
    };
  }

  const dispositionCommits = new Set(args.fix.dispositions.flatMap(disposition =>
    disposition.commit === undefined ? [] : [disposition.commit]));
  for (const dispositionCommit of dispositionCommits) {
    const object = await git(args.worktreePath, [
      "cat-file",
      "-e",
      `${dispositionCommit}^{commit}`,
    ]);
    if (object.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition reported a missing commit object",
      };
    }
    const [afterPrevious, beforeCandidate] = await Promise.all([
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        args.previousCandidateCommit,
        dispositionCommit,
      ]),
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        dispositionCommit,
        args.fix.candidateCommit,
      ]),
    ]);
    if (afterPrevious.exitCode !== 0 || beforeCandidate.exitCode !== 0) {
      return {
        failure: "producer-failure",
        reason: "fix phase disposition commit is outside the produced candidate lineage",
      };
    }
  }
  return null;
}

async function verifyCandidate(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps: PipelineDependencies;
  attempt: AttemptResult;
  baselineCommit: string;
  candidateCommit: string;
  store: ArtifactStore;
}): Promise<{ verification: PipelineVerificationReport; baselineDrift: boolean }> {
  const ps = args.deps.ps ?? getPlatformServices();
  const manager = new WorktreeManager(
    args.checkoutPath,
    `${args.attempt.runId}-verify`,
    ps,
  );
  const fresh = await manager.create(args.candidateCommit);
  let primaryError: unknown;
  try {
    const [diffText, nameOnly, status, ancestry] = await Promise.all([
      checkedGit(fresh.path, ["diff", `${args.baselineCommit}..${args.candidateCommit}`]),
      checkedGit(fresh.path, [
        "diff",
        "--name-only",
        `${args.baselineCommit}..${args.candidateCommit}`,
      ]),
      checkedGit(fresh.path, ["status", "--porcelain"]),
      git(fresh.path, [
        "merge-base",
        "--is-ancestor",
        args.baselineCommit,
        args.candidateCommit,
      ]),
    ]);
    const artifact = await candidateArtifact({
      worktreePath: fresh.path,
      baselineCommit: args.baselineCommit,
      candidateCommit: args.candidateCommit,
      anchorRef: args.attempt.candidate?.anchorRef ?? "",
      diffText,
    });
    const verifier = new AcceptanceVerifier({
      structural: async structuralArgs => {
        const result = await structuralVerify(structuralArgs);
        const failures = result.failures.filter(
          failure => !IGNORED_STRUCTURAL_FAILURES.has(failure),
        );
        return { ...result, ok: failures.length === 0, failures };
      },
    });
    const acceptance = await verifier.verify({
      repoRoot: args.checkoutPath,
      worktreePath: fresh.path,
      baseCommitOid: args.baselineCommit,
      artifact,
      spec: args.spec,
      ps,
      artifactStore: args.store,
      verificationId: () => `${args.attempt.runId}-pipeline`,
      logNamePrefix: "pipeline-verification",
    });
    const changedPaths = nameOnly.split("\n").map(line => line.trim()).filter(Boolean);
    const scopeViolations = changedPaths.filter(pathname =>
      !args.spec.writeAllowlist.some(pattern => globMatches(pattern, pathname))
      || args.spec.forbiddenScope.some(pattern => globMatches(pattern, pathname)));
    const weakened = detectWeakenedTests(diffText);
    const workspaceClean = status === "";
    const verificationCommands = new Map(
      args.spec.verification.map(command => [command.id, command]),
    );
    return {
      verification: {
        reportVersion: "1",
        pass: acceptance.ok
          && workspaceClean
          && scopeViolations.length === 0,
        commandResults: acceptance.commandOutcomes.map(command => ({
          id: command.id,
          exitCode: command.exitCode ?? -1,
          ok: command.exitCode !== null
            && !command.timedOut
            && (verificationCommands.get(command.id)?.expectedExitCodes.includes(
              command.exitCode,
            ) ?? false),
        })),
        workspaceClean,
        testsDeleted: weakened.testsDeleted,
        testsSkipped: weakened.testsSkipped,
        scopeViolations,
        evidence: {
          failures: [...acceptance.failures],
          acceptance: acceptance.evidence,
          commandOutcomes: acceptance.commandOutcomes.map(outcome => ({
            ...outcome,
            args: [...outcome.args],
          })),
        },
      },
      baselineDrift: ancestry.exitCode !== 0,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await fresh.cleanup();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "pipeline verification failed and its worktree could not be cleaned up",
      );
    }
  }
}

export async function runPipeline(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: PipelineDependencies,
): Promise<PipelineResult> {
  const runAttemptFn = deps.runAttempt ?? defaultRunAttempt;
  const attempt = await runAttemptFn(checkoutPath, spec, deps);
  if (attempt.status !== "verified-candidate" || attempt.candidate === null) {
    return failedResult(
      attempt,
      [],
      "",
      "implement phase did not produce a verified candidate",
    );
  }

  const { reviewers, maxRounds } = resolveReviewConfig(spec);
  const store = new ArtifactStore(attempt.runId);
  let finalAttempt = attempt;
  const rounds: PipelineRound[] = [];
  const baselineCommit = attempt.candidate.baseCommitOid;
  let currentCandidateCommit = attempt.candidate.candidateCommitOid;
  const candidateWorktree = await new WorktreeManager(
    checkoutPath,
    `${attempt.runId}-pipeline`,
    deps.ps ?? getPlatformServices(),
  ).create(currentCandidateCommit);
  let primaryError: unknown;
  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      const diffText = await checkedGit(candidateWorktree.path, [
        "diff",
        `${baselineCommit}..${currentCandidateCommit}`,
      ]);
      const pkg: RolePackage = {
        spec,
        baselineCommit,
        candidateCommit: currentCandidateCommit,
        candidateDiff: diffText,
        testEvidence: testEvidence(attempt),
      };
      const reviewRun = await runReviews({
        reviewers,
        spec,
        pkg,
        worktreePath: candidateWorktree.path,
        deps,
        runId: attempt.runId,
        round,
        store,
      });
      if (!reviewRun.ok) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          `review phase did not produce valid structured output (see ${reviewRun.failedRoleLogRef})`,
        );
      }

      const reviews = reviewRun.reviews.map(review => ({
        reviewer: review.reviewer,
        report: review.report,
      }));
      const consolidated = consolidate(reviews);
      await Promise.all(reviewRun.reviews.map(review => store.writePipelineArtifact(
        `round-${round}-review-${review.reviewer}`,
        review.report,
      )));
      await store.writePipelineArtifact(`round-${round}-consolidated`, consolidated);

      const blocking = consolidated.findings.some(
        finding => finding.severity === "blocker" || finding.severity === "major",
      );
      const approved = reviewRun.reviews.every(review => review.report.verdict === "approve");
      if (!blocking && approved) {
        rounds.push({ round, reviews, consolidated, fix: null, roleLogRefs: reviewRun.roleLogRefs });
        break;
      }

      const fixRun = await runFix({
        spec,
        pkg: { ...pkg, findings: consolidated.findings },
        worktreePath: candidateWorktree.path,
        deps,
        runId: attempt.runId,
        round,
        store,
      });
      if (!fixRun.ok) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          `fix phase did not produce valid structured output (see ${fixRun.failedRoleLogRef})`,
          fixRun.failure,
        );
      }
      const { fix } = fixRun;
      await store.writePipelineArtifact(`round-${round}-fix`, fix);
      const provenanceFailure = await validateFixProvenance({
        worktreePath: candidateWorktree.path,
        previousCandidateCommit: currentCandidateCommit,
        fix,
      });
      if (provenanceFailure !== null) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          provenanceFailure.reason,
          provenanceFailure.failure,
        );
      }
      currentCandidateCommit = fix.candidateCommit;
      rounds.push({
        round,
        reviews,
        consolidated,
        fix,
        roleLogRefs: [...reviewRun.roleLogRefs, ...fixRun.roleLogRefs],
      });
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await candidateWorktree.cleanup();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "pipeline rounds failed and their worktree could not be cleaned up",
      );
    }
  }

  if (currentCandidateCommit !== attempt.candidate.candidateCommitOid) {
    const finalTree = (await checkedGit(
      checkoutPath,
      ["rev-parse", `${currentCandidateCommit}^{tree}`],
    )).trim();
    const canonicalCommit = (await checkedGit(checkoutPath, [
      "commit-tree",
      finalTree,
      "-p",
      baselineCommit,
      "-m",
      `candidate ${attempt.runId}`,
    ])).trim();
    await checkedGit(checkoutPath, [
      "update-ref",
      attempt.candidate.anchorRef,
      canonicalCommit,
      attempt.candidate.candidateCommitOid,
    ]);
    currentCandidateCommit = canonicalCommit;
    const diffText = await checkedGit(
      checkoutPath,
      ["diff", `${baselineCommit}..${canonicalCommit}`],
    );
    const candidate = await candidateArtifact({
      worktreePath: checkoutPath,
      baselineCommit,
      candidateCommit: canonicalCommit,
      anchorRef: attempt.candidate.anchorRef,
      diffText,
    });
    const manifest = await store.readManifest(attempt.runId);
    if (manifest === null) throw new RuntimeError("run manifest is missing during promotion");
    finalAttempt = { ...attempt, candidate };
    await store.promoteTerminalArtifacts({
      result: finalAttempt,
      manifest: { ...manifest, candidateManifestHash: candidate.manifestHash },
    });
  }

  const verified = await verifyCandidate({
    checkoutPath,
    spec,
    deps,
    attempt: finalAttempt,
    baselineCommit,
    candidateCommit: currentCandidateCommit,
    store,
  });
  await store.writePipelineArtifact("verification", verified.verification);
  const lastRound = rounds.at(-1);
  const gate = evaluateGates({
    findings: lastRound?.consolidated.findings ?? [],
    dispositions: lastRound?.fix?.dispositions ?? [],
    verification: verified.verification,
    roundsUsed: rounds.length,
    maxRounds,
    finalRoundReviewed: (lastRound?.fix ?? null) === null,
    artifactsValid: true,
    baselineDrift: verified.baselineDrift,
  });
  const result: PipelineResult = {
    runId: attempt.runId,
    status: gate.decisionReady ? "decision-ready" : "human-decision-required",
    attempt: finalAttempt,
    rounds,
    verification: verified.verification,
    gate,
    finalCandidateCommit: currentCandidateCommit,
    failure: null,
  };
  await store.writePipelineArtifact("pipeline-result", result);
  return result;
}
