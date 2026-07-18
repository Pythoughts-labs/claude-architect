import path from "node:path";
import { git, type GitExecOptions, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  CandidateArtifact,
  AttemptResult,
  CommandOutcome,
  FailureClassification,
} from "../protocol/attempt-result.js";
import {
  resolveImplementationConfig,
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
import { redact, redactRecord } from "../runtime/redaction.js";
import type { RunStartContext } from "../runtime/run-start.js";
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
  IncrementReport,
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
import {
  resolveLinkedWorktreeWritableRoots,
  type LinkedWorktreeGitAccess,
} from "./git-writable-roots.js";

export interface PipelineRound {
  round: number;
  reviews: { reviewer: string; report: ReviewReport }[];
  consolidated: ConsolidationResult;
  fix: FixReport | null;
  roleLogRefs: string[];
}

export interface PipelineIncrement {
  increment: number;
  report: IncrementReport;
  roleLogRefs: string[];
}

export interface PipelineResult {
  runId: string;
  status: "decision-ready" | "human-decision-required" | "failed";
  attempt: AttemptResult;
  increments: PipelineIncrement[];
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

type StructuredRoleRunResult<T> =
  | { ok: true; report: T; roleLogRefs: string[] }
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

async function checkedGit(
  cwd: string,
  args: string[],
  options?: GitExecOptions,
): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

function privateObjectReadOptions(access: LinkedWorktreeGitAccess): GitExecOptions {
  return {
    env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: access.privateObjectsDir },
  };
}

async function importPromotedObjects(args: {
  checkoutPath: string;
  baselineCommit: string;
  promotedCommit: string;
  access: LinkedWorktreeGitAccess;
}): Promise<void> {
  const privateObjects = privateObjectReadOptions(args.access);
  const packPrefix = path.join(args.access.sharedObjectsDir, "pack", "pack");
  await checkedGit(
    args.checkoutPath,
    ["pack-objects", "--revs", packPrefix],
    {
      ...privateObjects,
      stdin: `${args.promotedCommit}\n^${args.baselineCommit}\n`,
    },
  );

  await checkedGit(args.checkoutPath, ["cat-file", "-e", `${args.promotedCommit}^{commit}`]);
  await checkedGit(args.checkoutPath, ["rev-parse", `${args.promotedCommit}^{tree}`]);
  await checkedGit(args.checkoutPath, [
    "rev-list",
    "--objects",
    args.promotedCommit,
    "--not",
    args.baselineCommit,
  ]);
}

function roleArgs(args: {
  role: PipelineRole;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  runStart?: RunStartContext;
  gitObjectAccess?: LinkedWorktreeGitAccess;
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
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    ...(args.gitObjectAccess === undefined ? {} : { gitObjectAccess: args.gitObjectAccess }),
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

async function runStructuredRole<T>(args: {
  role: PipelineRole;
  schema: Parameters<typeof parseStructuredReport>[1];
  logName: string;
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  store: ArtifactStore;
  runStart?: RunStartContext;
  gitObjectAccess?: LinkedWorktreeGitAccess;
}): Promise<StructuredRoleRunResult<T>> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const callArgs = roleArgs({
    role: args.role,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    ...(args.gitObjectAccess === undefined ? {} : { gitObjectAccess: args.gitObjectAccess }),
  });
  const initial = await runArchivedRole(runner, callArgs, args.store, args.logName);
  const roleLogRefs = [initial.logRef];
  if (!initial.result.ok) {
    return {
      ok: false,
      failure: initial.result.failure ?? "producer-failure",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
  }
  const outcome = await parseStructuredReport<T>(
    initial.result.rawOutput,
    args.schema,
    async validationErrors => {
      void validationErrors;
      const repair = await runArchivedRole(
        runner,
        callArgs,
        args.store,
        `${args.logName}-repair`,
      );
      roleLogRefs.push(repair.logRef);
      return repair.result.ok ? repair.result.rawOutput : "";
    },
  );
  return outcome.ok
    ? { ok: true, report: outcome.value, roleLogRefs }
    : {
      ok: false,
      failure: "invalid-output",
      failedRoleLogRef: initial.logRef,
      roleLogRefs,
    };
}

function failedResult(
  attempt: AttemptResult,
  rounds: PipelineRound[],
  finalCandidateCommit: string,
  reason: string,
  failure: FailureClassification = "producer-failure",
  increments: PipelineIncrement[] = [],
): PipelineResult {
  return {
    runId: attempt.runId,
    status: "failed",
    attempt,
    increments,
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

const MAX_PROGRESS_NOTES_LENGTH = 8_000;
const PROGRESS_TRUNCATION_NOTE = "\n\n[progress notes truncated]";

export function composeProgressNotes(
  previous: IncrementReport | { producerSummary: string | null; summary: string },
): string {
  const summary = "producerSummary" in previous
    ? previous.producerSummary ?? previous.summary
    : previous.summary;
  const nextSteps = "nextSteps" in previous ? previous.nextSteps : undefined;
  const rendered = redact([
    `Summary:\n${summary}`,
    ...(nextSteps === undefined ? [] : [`Next steps:\n${nextSteps}`]),
  ].join("\n\n"));
  if (rendered.length <= MAX_PROGRESS_NOTES_LENGTH) return rendered;
  return `${rendered.slice(
    0,
    MAX_PROGRESS_NOTES_LENGTH - PROGRESS_TRUNCATION_NOTE.length,
  )}${PROGRESS_TRUNCATION_NOTE}`;
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
  const outcomes = await Promise.all(args.reviewers.map(async reviewer => {
    const role = `reviewer-${reviewer}` as const;
    const outcome = await runStructuredRole<ReviewReport>({
      role,
      schema: schemas.reviewReport,
      logName: `role-${role}-round${args.round}`,
      spec: args.spec,
      pkg: args.pkg,
      worktreePath: args.worktreePath,
      deps: args.deps,
      runId: args.runId,
      store: args.store,
    });
    return {
      review: outcome.ok ? { reviewer, report: outcome.report } : null,
      initialLogRef: outcome.ok ? null : outcome.failedRoleLogRef,
      roleLogRefs: outcome.roleLogRefs,
    };
  }));
  const roleLogRefs = outcomes.flatMap(outcome => outcome.roleLogRefs);
  const reviews = outcomes.map(outcome => outcome.review);
  if (reviews.every((review): review is ParsedReview => review !== null)) {
    return { ok: true, reviews, roleLogRefs };
  }
  const failed = outcomes.find(outcome => outcome.review === null);
  if (failed?.initialLogRef === null || failed === undefined) {
    throw new Error("unreachable invalid review state");
  }
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
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext;
}): Promise<FixRunResult> {
  const outcome = await runStructuredRole<FixReport>({
    role: "fixer",
    schema: schemas.fixReport,
    logName: `role-fixer-round${args.round}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
  return outcome.ok
    ? { ok: true, fix: outcome.report, roleLogRefs: outcome.roleLogRefs }
    : outcome;
}

async function runIncrement(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
  increment: number;
  store: ArtifactStore;
  gitObjectAccess: LinkedWorktreeGitAccess;
  runStart?: RunStartContext;
}): Promise<StructuredRoleRunResult<IncrementReport>> {
  return runStructuredRole<IncrementReport>({
    role: "implementer",
    schema: schemas.incrementReport,
    logName: `role-implementer-increment${args.increment}`,
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
    store: args.store,
    ...(args.runStart === undefined ? {} : { runStart: args.runStart }),
    gitObjectAccess: args.gitObjectAccess,
  });
}

interface CandidateProvenanceFailure {
  failure: FailureClassification;
  reason: string;
}

async function validateCandidateProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  candidateCommit: string;
  gitObjectAccess: LinkedWorktreeGitAccess;
}): Promise<CandidateProvenanceFailure | null> {
  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const candidateObject = await git(args.worktreePath, [
    "cat-file",
    "-e",
    `${args.candidateCommit}^{commit}`,
  ], privateObjects);
  if (candidateObject.exitCode !== 0) {
    return {
      failure: "producer-failure",
      reason: "fix phase reported a missing candidate commit",
    };
  }

  const head = await git(
    args.worktreePath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    privateObjects,
  );
  if (head.exitCode !== 0 || head.stdout.trim() !== args.candidateCommit) {
    return {
      failure: "producer-failure",
      reason: "fix phase reported a candidate commit that does not match its worktree HEAD",
    };
  }

  const candidateAncestry = await git(args.worktreePath, [
    "merge-base",
    "--is-ancestor",
    args.previousCandidateCommit,
    args.candidateCommit,
  ], privateObjects);
  if (candidateAncestry.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: "fix phase candidate commit is not descended from the reviewed candidate",
    };
  }

  const worktreeStatus = await git(args.worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ], privateObjects);
  if (worktreeStatus.exitCode !== 0) {
    return {
      failure: "sandbox-violation",
      reason: "fix phase candidate worktree cleanliness could not be verified",
    };
  }
  if (worktreeStatus.stdout.length > 0) {
    return {
      failure: "sandbox-violation",
      reason: "fix phase candidate worktree contains uncommitted state",
    };
  }

  return null;
}

async function validateFixProvenance(args: {
  worktreePath: string;
  previousCandidateCommit: string;
  fix: FixReport;
  gitObjectAccess: LinkedWorktreeGitAccess;
}): Promise<CandidateProvenanceFailure | null> {
  const provenanceFailure = await validateCandidateProvenance({
    worktreePath: args.worktreePath,
    previousCandidateCommit: args.previousCandidateCommit,
    candidateCommit: args.fix.candidateCommit,
    gitObjectAccess: args.gitObjectAccess,
  });
  if (provenanceFailure !== null) return provenanceFailure;

  const privateObjects = privateObjectReadOptions(args.gitObjectAccess);
  const dispositionCommits = new Set(args.fix.dispositions.flatMap(disposition =>
    disposition.commit === undefined ? [] : [disposition.commit]));
  for (const dispositionCommit of dispositionCommits) {
    const object = await git(args.worktreePath, [
      "cat-file",
      "-e",
      `${dispositionCommit}^{commit}`,
    ], privateObjects);
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
      ], privateObjects),
      git(args.worktreePath, [
        "merge-base",
        "--is-ancestor",
        dispositionCommit,
        args.fix.candidateCommit,
      ], privateObjects),
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
  let runStart: RunStartContext | undefined;
  const inheritedOnRunStart = deps.onRunStart;
  const attempt = await runAttemptFn(checkoutPath, spec, {
    ...deps,
    onRunStart(context) {
      runStart = context;
      inheritedOnRunStart?.(context);
    },
  });
  if (attempt.status !== "verified-candidate" || attempt.candidate === null) {
    return failedResult(
      attempt,
      [],
      "",
      "implement phase did not produce a verified candidate",
    );
  }

  const { reviewers, maxRounds } = resolveReviewConfig(spec);
  const { maxIncrements } = resolveImplementationConfig(spec);
  const store = new ArtifactStore(attempt.runId);
  let finalAttempt = attempt;
  const increments: PipelineIncrement[] = [];
  const rounds: PipelineRound[] = [];
  const baselineCommit = attempt.candidate.baseCommitOid;
  let currentCandidateCommit = attempt.candidate.candidateCommitOid;
  const frozenTestEvidence = testEvidence(attempt);
  const candidateWorktree = await new WorktreeManager(
    checkoutPath,
    `${attempt.runId}-pipeline`,
    deps.ps ?? getPlatformServices(),
  ).create(currentCandidateCommit);
  let gitObjectAccess: LinkedWorktreeGitAccess | null = null;
  let primaryError: unknown;
  try {
    if (maxIncrements > 1) {
      try {
        gitObjectAccess = await resolveLinkedWorktreeWritableRoots(candidateWorktree.path);
      } catch {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "increment git object isolation could not be established",
          "sandbox-violation",
          increments,
        );
      }

      try {
        for (let increment = 2; increment <= maxIncrements; increment += 1) {
          const previousCandidateCommit = currentCandidateCommit;
          const diffText = await checkedGit(candidateWorktree.path, [
            "diff",
            `${baselineCommit}..${currentCandidateCommit}`,
          ], privateObjectReadOptions(gitObjectAccess));
          const incrementRun = await runIncrement({
            spec,
            pkg: {
              spec,
              baselineCommit,
              candidateCommit: currentCandidateCommit,
              candidateDiff: diffText,
              testEvidence: frozenTestEvidence,
              progress: composeProgressNotes(increments.at(-1)?.report ?? attempt),
            },
            worktreePath: candidateWorktree.path,
            deps,
            runId: attempt.runId,
            increment,
            store,
            gitObjectAccess,
            ...(runStart === undefined ? {} : { runStart }),
          });
          if (!incrementRun.ok) {
            return failedResult(
              attempt,
              rounds,
              currentCandidateCommit,
              `increment phase did not produce valid structured output (see ${incrementRun.failedRoleLogRef})`,
              incrementRun.failure,
              increments,
            );
          }

          const report = redactRecord(incrementRun.report);
          await store.writePipelineArtifact(`increment-${increment}`, report);
          const provenanceFailure = await validateCandidateProvenance({
            worktreePath: candidateWorktree.path,
            previousCandidateCommit,
            candidateCommit: report.candidateCommit,
            gitObjectAccess,
          });
          if (provenanceFailure !== null) {
            return failedResult(
              attempt,
              rounds,
              currentCandidateCommit,
              provenanceFailure.reason,
              provenanceFailure.failure,
              increments,
            );
          }

          const privateObjects = privateObjectReadOptions(gitObjectAccess);
          const [previousTree, candidateTree] = await Promise.all([
            checkedGit(
              candidateWorktree.path,
              ["rev-parse", `${previousCandidateCommit}^{tree}`],
              privateObjects,
            ),
            checkedGit(
              candidateWorktree.path,
              ["rev-parse", `${report.candidateCommit}^{tree}`],
              privateObjects,
            ),
          ]);
          const progressed = previousTree.trim() !== candidateTree.trim();
          if (report.candidateCommit !== previousCandidateCommit) {
            try {
              await importPromotedObjects({
                checkoutPath,
                baselineCommit: previousCandidateCommit,
                promotedCommit: report.candidateCommit,
                access: gitObjectAccess,
              });
            } catch {
              return failedResult(
                attempt,
                rounds,
                currentCandidateCommit,
                "increment objects could not be imported into the shared git object store",
                "sandbox-violation",
                increments,
              );
            }
          }
          currentCandidateCommit = report.candidateCommit;
          increments.push({
            increment,
            report,
            roleLogRefs: incrementRun.roleLogRefs,
          });

          if (report.status === "complete" || report.status === "blocked") break;
          if (!progressed) break;
        }
      } catch {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "increment phase failed unexpectedly",
          "producer-failure",
          increments,
        );
      }
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      const diffText = await checkedGit(candidateWorktree.path, [
        "diff",
        `${baselineCommit}..${currentCandidateCommit}`,
      ], gitObjectAccess === null ? undefined : privateObjectReadOptions(gitObjectAccess));
      const pkg: RolePackage = {
        spec,
        baselineCommit,
        candidateCommit: currentCandidateCommit,
        candidateDiff: diffText,
        testEvidence: frozenTestEvidence,
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
          "producer-failure",
          increments,
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

      try {
        gitObjectAccess ??= await resolveLinkedWorktreeWritableRoots(candidateWorktree.path);
      } catch {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "fixer git object isolation could not be established",
          "sandbox-violation",
          increments,
        );
      }

      const fixRun = await runFix({
        spec,
        pkg: { ...pkg, findings: consolidated.findings },
        worktreePath: candidateWorktree.path,
        deps,
        runId: attempt.runId,
        round,
        store,
        gitObjectAccess,
        ...(runStart === undefined ? {} : { runStart }),
      });
      if (!fixRun.ok) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          `fix phase did not produce valid structured output (see ${fixRun.failedRoleLogRef})`,
          fixRun.failure,
          increments,
        );
      }
      const { fix } = fixRun;
      await store.writePipelineArtifact(`round-${round}-fix`, fix);
      const provenanceFailure = await validateFixProvenance({
        worktreePath: candidateWorktree.path,
        previousCandidateCommit: currentCandidateCommit,
        fix,
        gitObjectAccess,
      });
      if (provenanceFailure !== null) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          provenanceFailure.reason,
          provenanceFailure.failure,
          increments,
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

    if (currentCandidateCommit !== attempt.candidate.candidateCommitOid) {
      if (gitObjectAccess === null) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "fixer git object isolation state is missing during promotion",
          "sandbox-violation",
          increments,
        );
      }
      let canonicalCommit: string;
      try {
        const privateObjects = privateObjectReadOptions(gitObjectAccess);
        const finalTree = (await checkedGit(
          checkoutPath,
          ["rev-parse", `${currentCandidateCommit}^{tree}`],
          privateObjects,
        )).trim();
        canonicalCommit = (await checkedGit(checkoutPath, [
          "commit-tree",
          finalTree,
          "-p",
          baselineCommit,
          "-m",
          `candidate ${attempt.runId}`,
        ], privateObjects)).trim();
        await importPromotedObjects({
          checkoutPath,
          baselineCommit,
          promotedCommit: canonicalCommit,
          access: gitObjectAccess,
        });
      } catch {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "fixer objects could not be imported into the shared git object store",
          "sandbox-violation",
          increments,
        );
      }
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
    increments,
    rounds,
    verification: verified.verification,
    gate,
    finalCandidateCommit: currentCandidateCommit,
    failure: null,
  };
  await store.writePipelineArtifact("pipeline-result", result);
  return result;
}
