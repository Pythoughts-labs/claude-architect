import { createHash } from "node:crypto";
import { manifestHashOf } from "../git/changed-path-manifest.js";
import type { AttemptResult } from "../protocol/attempt-result.js";
import type { AutopilotDecisionEligibilityV1 } from "../protocol/candidate-decision.js";
import type { PipelineResult, PipelineVerificationReport } from "../pipeline/pipeline-runtime.js";
import type { AdvisorReport, Finding, ReviewReport } from "../pipeline/report-types.js";
import type { GateResult } from "../pipeline/gates.js";
import {
  reviewSnapshotHash as hashReviewSnapshot,
  type ReviewSnapshot,
} from "../runtime/review-snapshot.js";

const SHA256 = /^[0-9a-f]{64}$/u;

export interface AutopilotEligibilityRecord {
  recordVersion: "1";
  policyVersion: "1";
  runId: string;
  eligible: boolean;
  reasons: string[];
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  candidateManifestHash: string;
  reviewSnapshotHash: string;
  pipelineResultHash: string;
  advisorReportHash: string;
  evaluatedAt: string;
}

export interface EligibilityReview {
  reviewer: string;
  report: ReviewReport;
}

/** A normalized, caller-independent description of the complete frozen evidence. */
export interface AutopilotEligibilityInput {
  runId: string;
  status: PipelineResult["status"];
  gate: GateResult;
  attemptStatus: AttemptResult["status"];
  verification: PipelineVerificationReport | null;
  finalReviews: EligibilityReview[];
  finalFindings: Finding[];
  finalFixReReviewed: boolean;
  advisor: AdvisorReport;
  baseCommitOid: string;
  candidateCommitOid: string;
  candidateTreeOid: string;
  candidateManifestHash: string;
  reviewRunId: string;
  reviewBaseCommitOid: string;
  reviewCandidateCommitOid: string;
  reviewCandidateTreeOid: string;
  reviewManifestHash: string;
  reviewSnapshotHash: string;
  pipelineResultHash: string;
  advisorReportHash: string;
  evaluatedAt: string;
  pipelineResult: PipelineResult;
  reviewSnapshot: ReviewSnapshot;
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("artifact contains a non-JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonValue(item)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("artifact contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`).join(",")}}`;
}

export function canonicalArtifactHash(value: unknown): string {
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown;
  return createHash("sha256").update(canonicalJsonValue(jsonValue)).digest("hex");
}

export function pipelineResultHash(result: PipelineResult): string {
  return canonicalArtifactHash(result);
}

export function advisorReportHash(report: AdvisorReport): string {
  return canonicalArtifactHash(report);
}

export function autopilotEligibilityRecordHash(record: AutopilotEligibilityRecord): string {
  return canonicalArtifactHash(record);
}

export function autopilotDecisionEligibilityProjection(
  record: AutopilotEligibilityRecord,
): AutopilotDecisionEligibilityV1 {
  if (!record.eligible || record.reasons.length !== 0) {
    throw new TypeError("an ineligible autopilot record cannot authorize a decision");
  }
  return {
    eligibilityVersion: "1",
    eligible: true,
    candidateManifestHash: record.candidateManifestHash,
    evidenceHash: autopilotEligibilityRecordHash(record),
    policyVersion: record.policyVersion,
  };
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function hashesAgree(actual: string, expected: string): boolean {
  return SHA256.test(actual) && actual === expected;
}

export function eligibilityInputFromArtifacts(args: {
  pipelineResult: PipelineResult;
  reviewSnapshot: ReviewSnapshot;
  advisor: AdvisorReport;
  evaluatedAt: string;
}): AutopilotEligibilityInput {
  const { pipelineResult, reviewSnapshot, advisor } = args;
  const candidate = pipelineResult.attempt.candidate;
  const lastRound = pipelineResult.rounds.at(-1);
  return {
    runId: pipelineResult.runId,
    status: pipelineResult.status,
    gate: structuredClone(pipelineResult.gate),
    attemptStatus: pipelineResult.attempt.status,
    verification: pipelineResult.verification === null
      ? null
      : structuredClone(pipelineResult.verification),
    finalReviews: structuredClone(lastRound?.reviews ?? []),
    finalFindings: structuredClone(lastRound?.consolidated.findings ?? []),
    finalFixReReviewed: lastRound?.fix === null,
    advisor: structuredClone(advisor),
    baseCommitOid: candidate?.baseCommitOid ?? reviewSnapshot.baseCommitOid,
    candidateCommitOid: candidate?.candidateCommitOid ?? reviewSnapshot.candidateCommitOid,
    candidateTreeOid: candidate?.candidateTreeOid ?? reviewSnapshot.candidateTreeOid,
    candidateManifestHash: candidate?.manifestHash ?? reviewSnapshot.manifestHash,
    reviewRunId: reviewSnapshot.runId,
    reviewBaseCommitOid: reviewSnapshot.baseCommitOid,
    reviewCandidateCommitOid: reviewSnapshot.candidateCommitOid,
    reviewCandidateTreeOid: reviewSnapshot.candidateTreeOid,
    reviewManifestHash: reviewSnapshot.manifestHash,
    reviewSnapshotHash: hashReviewSnapshot(reviewSnapshot),
    pipelineResultHash: pipelineResultHash(pipelineResult),
    advisorReportHash: advisorReportHash(advisor),
    evaluatedAt: args.evaluatedAt,
    pipelineResult: structuredClone(pipelineResult),
    reviewSnapshot: structuredClone(reviewSnapshot),
  };
}

/** Pure, deterministic derivation. No caller-supplied eligibility is accepted. */
export function evaluateAutopilotEligibility(
  input: AutopilotEligibilityInput,
): AutopilotEligibilityRecord {
  const reasons: string[] = [];

  if (input.status !== "decision-ready") addReason(reasons, "pipeline status is not decision-ready");
  if (!input.gate.decisionReady) addReason(reasons, "pipeline gate is not decision-ready");
  if (input.gate.requiresHumanDecision) addReason(reasons, "pipeline gate requires human decision");
  for (const reason of input.gate.reasons) addReason(reasons, `pipeline gate: ${reason}`);
  if (input.attemptStatus !== "verified-candidate") {
    addReason(reasons, "attempt is not a verified candidate");
  }

  const verification = input.verification;
  if (verification === null) {
    addReason(reasons, "trusted verification is missing");
  } else {
    if (!verification.pass) addReason(reasons, "trusted verification did not pass");
    if (verification.commandResults.length === 0) {
      addReason(reasons, "trusted verification executed no applicable command");
    }
    if (!verification.workspaceClean) addReason(reasons, "verification worktree is not clean");
    if (verification.testsDeleted > 0) addReason(reasons, "verification detected deleted tests");
    if (verification.testsSkipped > 0) addReason(reasons, "verification detected newly skipped tests");
    if (verification.scopeViolations.length > 0) {
      addReason(reasons, "verification detected scope violations");
    }
    if (!Array.isArray(verification.evidence?.failures)) {
      addReason(reasons, "trusted verification evidence is missing");
    } else if (verification.evidence.failures.length > 0) {
      addReason(reasons, "trusted verification evidence contains failures");
    }
  }

  for (const reviewer of ["correctness", "systems"] as const) {
    const report = input.finalReviews.find(review => review.reviewer === reviewer)?.report;
    if (report?.verdict !== "approve") {
      addReason(reasons, `final ${reviewer} review does not approve`);
    }
    if ((report?.coverageGaps.length ?? 1) > 0) {
      addReason(reasons, `final ${reviewer} review has coverage gaps`);
    }
  }
  if (input.finalFindings.some(finding =>
    finding.severity === "blocker" || finding.severity === "major")) {
    addReason(reasons, "final review contains blocker or major findings");
  }
  if (!input.finalFixReReviewed) addReason(reasons, "final fix was not independently re-reviewed");

  if (input.advisor.verdict !== "approve") addReason(reasons, "advisor does not approve");
  if (input.advisor.risks.some(risk => risk.severity === "blocker" || risk.severity === "major")) {
    addReason(reasons, "advisor reported blocker or major risk");
  }
  if (input.advisor.coverageGaps.length > 0) addReason(reasons, "advisor reported coverage gaps");

  if (input.runId !== input.reviewRunId) addReason(reasons, "review snapshot run id mismatch");
  if (input.baseCommitOid !== input.reviewBaseCommitOid) {
    addReason(reasons, "review snapshot base commit mismatch");
  }
  if (input.candidateCommitOid !== input.reviewCandidateCommitOid) {
    addReason(reasons, "review snapshot candidate commit mismatch");
  }
  if (input.candidateTreeOid !== input.reviewCandidateTreeOid) {
    addReason(reasons, "review snapshot candidate tree mismatch");
  }
  if (input.candidateManifestHash !== input.reviewManifestHash) {
    addReason(reasons, "review snapshot candidate manifest mismatch");
  }

  if (!SHA256.test(input.reviewSnapshotHash)) addReason(reasons, "review snapshot hash is invalid");
  if (!SHA256.test(input.pipelineResultHash)) addReason(reasons, "pipeline result hash is invalid");
  if (!SHA256.test(input.advisorReportHash)) addReason(reasons, "advisor report hash is invalid");
  if (input.reviewSnapshot === undefined) {
    addReason(reasons, "review snapshot source artifact is missing");
  } else {
    try {
      if (!hashesAgree(input.reviewSnapshotHash, hashReviewSnapshot(input.reviewSnapshot))) {
        addReason(reasons, "review snapshot hash mismatch");
      }
    } catch {
      addReason(reasons, "review snapshot is malformed");
    }
  }
  if (input.pipelineResult === undefined) {
    addReason(reasons, "pipeline result source artifact is missing");
  } else {
    try {
      if (!hashesAgree(input.pipelineResultHash, pipelineResultHash(input.pipelineResult))) {
        addReason(reasons, "pipeline result hash mismatch");
      }
      const sourceLastRound = input.pipelineResult.rounds.at(-1);
      if (input.pipelineResult.status !== input.status
        || input.pipelineResult.attempt.status !== input.attemptStatus
        || canonicalArtifactHash(input.pipelineResult.gate) !== canonicalArtifactHash(input.gate)
        || canonicalArtifactHash(input.pipelineResult.verification) !== canonicalArtifactHash(input.verification)
        || canonicalArtifactHash(sourceLastRound?.reviews ?? [])
          !== canonicalArtifactHash(input.finalReviews)
        || canonicalArtifactHash(sourceLastRound?.consolidated.findings ?? [])
          !== canonicalArtifactHash(input.finalFindings)
        || (sourceLastRound?.fix === null) !== input.finalFixReReviewed) {
        addReason(reasons, "pipeline result eligibility projection mismatch");
      }
      const candidate = input.pipelineResult.attempt.candidate;
      if (input.pipelineResult.runId !== input.runId
        || input.pipelineResult.attempt.runId !== input.runId
        || input.pipelineResult.finalCandidateCommit !== input.candidateCommitOid
        || candidate === null
        || candidate.baseCommitOid !== input.baseCommitOid
        || candidate.candidateCommitOid !== input.candidateCommitOid
        || candidate.candidateTreeOid !== input.candidateTreeOid
        || candidate.manifestHash !== input.candidateManifestHash
        || manifestHashOf(candidate.changedPaths) !== candidate.manifestHash) {
        addReason(reasons, "pipeline result candidate binding mismatch");
      }
    } catch {
      addReason(reasons, "pipeline result is malformed");
    }
  }
  try {
    if (!hashesAgree(input.advisorReportHash, advisorReportHash(input.advisor))) {
      addReason(reasons, "advisor report hash mismatch");
    }
  } catch {
    addReason(reasons, "advisor report is malformed");
  }

  return {
    recordVersion: "1",
    policyVersion: "1",
    runId: input.runId,
    eligible: reasons.length === 0,
    reasons,
    baseCommitOid: input.baseCommitOid,
    candidateCommitOid: input.candidateCommitOid,
    candidateTreeOid: input.candidateTreeOid,
    candidateManifestHash: input.candidateManifestHash,
    reviewSnapshotHash: input.reviewSnapshotHash,
    pipelineResultHash: input.pipelineResultHash,
    advisorReportHash: input.advisorReportHash,
    evaluatedAt: input.evaluatedAt,
  };
}
