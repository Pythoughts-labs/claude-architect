import { createHash } from "node:crypto";
import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { CandidateArtifact, ChangedPath, AttemptResult } from "../protocol/attempt-result.js";
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
import { projectVerify } from "../verify/project-verifier.js";
import { structuralVerify, type StructuralFailure } from "../verify/structural-verifier.js";
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
}

export interface PipelineResult {
  runId: string;
  status: "decision-ready" | "human-decision-required" | "failed";
  attempt: AttemptResult;
  rounds: PipelineRound[];
  verification: VerificationReport | null;
  gate: GateResult;
  finalCandidateCommit: string;
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

function failedResult(
  attempt: AttemptResult,
  rounds: PipelineRound[],
  finalCandidateCommit: string,
  reason: string,
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

function splitNul(value: string): string[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function changeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

async function changedPathsFor(
  worktreePath: string,
  baselineCommit: string,
  candidateCommit: string,
): Promise<ChangedPath[]> {
  const fields = splitNul(await checkedGit(worktreePath, [
    "diff",
    "--name-status",
    "--no-renames",
    "-z",
    `${baselineCommit}..${candidateCommit}`,
  ]));
  if (fields.length % 2 !== 0) {
    throw new RuntimeError("git diff returned invalid name-status output");
  }

  const changes: ChangedPath[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const pathname = fields[index + 1];
    if (status === undefined || pathname === undefined) {
      throw new RuntimeError("git diff returned an incomplete name-status record");
    }
    const sourceCommit = status === "D" ? baselineCommit : candidateCommit;
    const entry = (await checkedGit(worktreePath, ["ls-tree", sourceCommit, "--", pathname])).trim();
    const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/.exec(entry);
    if (match === null) throw new RuntimeError(`git ls-tree omitted changed path: ${pathname}`);
    changes.push({
      path: pathname,
      changeType: changeType(status),
      mode: match[1] ?? "",
      contentHash: status === "D" ? null : match[2] ?? null,
    });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

async function candidateArtifact(args: {
  worktreePath: string;
  baselineCommit: string;
  candidateCommit: string;
  anchorRef: string;
  diffText: string;
}): Promise<CandidateArtifact> {
  const changedPaths = await changedPathsFor(
    args.worktreePath,
    args.baselineCommit,
    args.candidateCommit,
  );
  return {
    baseCommitOid: args.baselineCommit,
    candidateTreeOid: (await checkedGit(
      args.worktreePath,
      ["rev-parse", `${args.candidateCommit}^{tree}`],
    )).trim(),
    candidateCommitOid: args.candidateCommit,
    anchorRef: args.anchorRef,
    manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
    changedPaths,
    patch: args.diffText,
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
}): Promise<ParsedReview[] | null> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const parsed = await Promise.all(args.reviewers.map(async reviewer => {
    const callArgs = roleArgs({
      role: `reviewer-${reviewer}`,
      spec: args.spec,
      pkg: args.pkg,
      worktreePath: args.worktreePath,
      deps: args.deps,
      runId: args.runId,
    });
    const initial = await runner(callArgs);
    if (!initial.ok) return null;
    const outcome = await parseStructuredReport<ReviewReport>(
      initial.rawOutput,
      schemas.reviewReport,
      async validationErrors => {
        void validationErrors;
        const repair = await runner(callArgs);
        return repair.ok ? repair.rawOutput : "";
      },
    );
    return outcome.ok ? { reviewer, report: outcome.value } : null;
  }));
  return parsed.every((review): review is ParsedReview => review !== null) ? parsed : null;
}

async function runFix(args: {
  spec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  deps: PipelineDependencies;
  runId: string;
}): Promise<FixReport | null> {
  const runner = args.deps.roleRunner ?? defaultRunRole;
  const callArgs = roleArgs({
    role: "fixer",
    spec: args.spec,
    pkg: args.pkg,
    worktreePath: args.worktreePath,
    deps: args.deps,
    runId: args.runId,
  });
  const initial = await runner(callArgs);
  if (!initial.ok) return null;
  const outcome = await parseStructuredReport<FixReport>(
    initial.rawOutput,
    schemas.fixReport,
    async validationErrors => {
      void validationErrors;
      const repair = await runner(callArgs);
      return repair.ok ? repair.rawOutput : "";
    },
  );
  return outcome.ok ? outcome.value : null;
}

async function verifyCandidate(args: {
  checkoutPath: string;
  spec: DelegationSpec;
  deps: PipelineDependencies;
  attempt: AttemptResult;
  baselineCommit: string;
  candidateCommit: string;
}): Promise<{ verification: VerificationReport; baselineDrift: boolean }> {
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
    const [structural, project] = await Promise.all([
      structuralVerify({
        repoRoot: args.checkoutPath,
        worktreePath: fresh.path,
        baseCommitOid: args.baselineCommit,
        artifact,
        writeAllowlist: args.spec.writeAllowlist,
        forbiddenScope: args.spec.forbiddenScope,
      }),
      projectVerify({
        repoRoot: args.checkoutPath,
        artifact,
        commands: args.spec.verification,
        ps,
        verificationId: () => `${args.attempt.runId}-pipeline`,
      }),
    ]);
    const changedPaths = nameOnly.split("\n").map(line => line.trim()).filter(Boolean);
    const scopeViolations = changedPaths.filter(pathname =>
      !args.spec.writeAllowlist.some(pattern => globMatches(pattern, pathname))
      || args.spec.forbiddenScope.some(pattern => globMatches(pattern, pathname)));
    const weakened = detectWeakenedTests(diffText);
    const workspaceClean = status === "";
    const structuralFailures = structural.failures.filter(
      failure => !IGNORED_STRUCTURAL_FAILURES.has(failure),
    );
    return {
      verification: {
        reportVersion: "1",
        pass: structuralFailures.length === 0
          && project.failures.length === 0
          && workspaceClean
          && scopeViolations.length === 0,
        commandResults: project.commandOutcomes.map(command => ({
          id: command.id,
          exitCode: command.exitCode ?? -1,
          ok: command.exitCode !== null && command.exitCode === 0,
        })),
        workspaceClean,
        testsDeleted: weakened.testsDeleted,
        testsSkipped: weakened.testsSkipped,
        scopeViolations,
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
      const parsedReviews = await runReviews({
        reviewers,
        spec,
        pkg,
        worktreePath: candidateWorktree.path,
        deps,
        runId: attempt.runId,
      });
      if (parsedReviews === null) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "review phase did not produce valid structured output",
        );
      }

      const reviews = parsedReviews.map(review => ({
        reviewer: review.reviewer,
        report: review.report,
      }));
      const consolidated = consolidate(reviews);
      await Promise.all(parsedReviews.map(review => store.writePipelineArtifact(
        `round-${round}-review-${review.reviewer}`,
        review.report,
      )));
      await store.writePipelineArtifact(`round-${round}-consolidated`, consolidated);

      const blocking = consolidated.findings.some(
        finding => finding.severity === "blocker" || finding.severity === "major",
      );
      const approved = parsedReviews.every(review => review.report.verdict === "approve");
      if (!blocking && approved) {
        rounds.push({ round, reviews, consolidated, fix: null });
        break;
      }

      const fix = await runFix({
        spec,
        pkg: { ...pkg, findings: consolidated.findings },
        worktreePath: candidateWorktree.path,
        deps,
        runId: attempt.runId,
      });
      if (fix === null) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "fix phase did not produce valid structured output",
        );
      }
      await store.writePipelineArtifact(`round-${round}-fix`, fix);
      const commit = await git(candidateWorktree.path, [
        "cat-file",
        "-e",
        `${fix.candidateCommit}^{commit}`,
      ]);
      if (commit.exitCode !== 0) {
        return failedResult(
          attempt,
          rounds,
          currentCandidateCommit,
          "fix phase reported a missing candidate commit",
        );
      }
      currentCandidateCommit = fix.candidateCommit;
      rounds.push({ round, reviews, consolidated, fix });
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
    attempt,
    baselineCommit,
    candidateCommit: currentCandidateCommit,
  });
  await store.writePipelineArtifact("verification", verified.verification);
  const lastRound = rounds.at(-1);
  const gate = evaluateGates({
    findings: lastRound?.consolidated.findings ?? [],
    dispositions: lastRound?.fix?.dispositions ?? [],
    verification: verified.verification,
    roundsUsed: rounds.length,
    maxRounds,
    artifactsValid: true,
    baselineDrift: verified.baselineDrift,
  });
  const result: PipelineResult = {
    runId: attempt.runId,
    status: gate.decisionReady ? "decision-ready" : "human-decision-required",
    attempt,
    rounds,
    verification: verified.verification,
    gate,
    finalCandidateCommit: currentCandidateCommit,
  };
  await store.writePipelineArtifact("pipeline-result", result);
  return result;
}
