import { createHash } from "node:crypto";
import type { DelegationSpec } from "../../../src/protocol/delegation-spec.js";
import type { PipelineResult } from "../../../src/pipeline/pipeline-runtime.js";
import type { AdvisorReport } from "../../../src/pipeline/report-types.js";
import type { ReviewSnapshot } from "../../../src/runtime/review-snapshot.js";

export const manifestHash = createHash("sha256").update("[]").digest("hex");

export const advisorReport: AdvisorReport = {
  reportVersion: "1",
  verdict: "approve",
  rationale: "All frozen evidence agrees.",
  risks: [],
  coverageGaps: [],
};

export function autopilotSpec(): DelegationSpec {
  return {
    specVersion: "1",
    objective: "Implement the bounded change",
    context: "PEER-CONVERSATION-MUST-NOT-BE-SHARED",
    writeAllowlist: ["src/**"],
    forbiddenScope: ["docs/**"],
    successCriteria: ["The bounded behavior is verified"],
    verification: [{
      id: "unit",
      executable: "npm",
      args: ["test"],
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
}

export function reviewSnapshot(runId = "run-advisor"): ReviewSnapshot {
  return {
    runId,
    baseCommitOid: "a".repeat(40),
    candidateCommitOid: "b".repeat(40),
    candidateTreeOid: "c".repeat(40),
    manifestHash,
    patch: "diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;",
    changedPaths: [],
    evidence: { structural: "valid" },
    executedVerification: [{
      id: "unit",
      executable: "npm",
      args: ["test"],
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      stdoutRef: "logs/unit.stdout.log",
      stderrRef: "logs/unit.stderr.log",
    }],
  };
}

export function pipelineResult(runId = "run-advisor"): PipelineResult {
  const snapshot = reviewSnapshot(runId);
  const commandOutcome = snapshot.executedVerification[0]!;
  const approve = {
    reportVersion: "1" as const,
    verdict: "approve" as const,
    findings: [],
    coverageGaps: [],
  };
  return {
    runId,
    status: "decision-ready",
    attempt: {
      resultVersion: "1",
      runId,
      status: "verified-candidate",
      failure: null,
      summary: "verified",
      producerSummary: null,
      candidate: {
        baseCommitOid: snapshot.baseCommitOid,
        candidateCommitOid: snapshot.candidateCommitOid,
        candidateTreeOid: snapshot.candidateTreeOid,
        anchorRef: `refs/claude-architect/candidates/${runId}`,
        manifestHash,
        changedPaths: [],
        patch: snapshot.patch,
      },
      requestedVerification: [],
      executedVerification: [commandOutcome],
      unresolvedIssues: [],
      evidence: { structural: "valid" },
      logsRef: "logs/producer.log",
      producerId: "codex",
      producerVersion: "1.0.0",
      producerModel: null,
      durationMs: 100,
      sessionId: null,
    },
    increments: [],
    slices: [],
    haltedSliceIndex: null,
    rounds: [{
      round: 1,
      reviews: [
        { reviewer: "correctness", report: approve },
        { reviewer: "systems", report: approve },
      ],
      consolidated: { findings: [], contradictions: [] },
      fix: null,
      roleLogRefs: ["logs/reviewer-correctness.log", "logs/reviewer-systems.log"],
    }],
    verification: {
      reportVersion: "1",
      pass: true,
      commandResults: [{ id: "unit", exitCode: 0, ok: true }],
      workspaceClean: true,
      testsDeleted: 0,
      testsSkipped: 0,
      scopeViolations: [],
      evidence: {
        failures: [],
        acceptance: {},
        commandOutcomes: [commandOutcome],
      },
    },
    gate: { decisionReady: true, requiresHumanDecision: false, reasons: [] },
    finalCandidateCommit: snapshot.candidateCommitOid,
    failure: null,
  };
}
