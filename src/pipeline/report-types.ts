// src/pipeline/report-types.ts
export type FindingSeverity = "blocker" | "major" | "minor" | "nit";

export type DispositionValue =
  | "fixed"
  | "already_satisfied"
  | "rejected_with_evidence"
  | "blocked"
  | "requires_human_decision";

/** A finding as emitted by a reviewer (no id yet — ids are assigned by the consolidator). */
export interface RawFinding {
  severity: FindingSeverity;
  location: string;        // "path/to/file.ts:line"
  claim: string;           // falsifiable claim
  evidence: string;
  reproduction: string;
  requiredOutcome: string;
  confidence: number;      // 0..1
}

/** A consolidated finding with a stable id and originating reviewer(s). */
export interface Finding extends RawFinding {
  id: string;              // "F-001", "F-002", ...
  reviewers: string[];     // e.g. ["correctness"] or ["correctness","systems"]
}

export interface ReviewReport {
  reportVersion: "1";
  verdict: "approve" | "request-changes";
  findings: RawFinding[];
  coverageGaps: string[];
}

export interface Disposition {
  findingId: string;
  disposition: DispositionValue;
  evidence: string;
  commit?: string;         // required for "fixed" (enforced by gates, not schema)
}

export interface FixReport {
  reportVersion: "1";
  candidateCommit: string; // 40- or 64-hex commit oid
  dispositions: Disposition[];
}

export interface IncrementReport {
  reportVersion: "1";
  candidateCommit: string;
  status: "complete" | "continue" | "blocked";
  summary: string;
  nextSteps?: string;
  blockers?: string;
}

export interface VerificationReport {
  reportVersion: "1";
  pass: boolean;
  commandResults: { id: string; exitCode: number; ok: boolean }[];
  workspaceClean: boolean;
  testsDeleted: number;
  testsSkipped: number;
  scopeViolations: string[];
}
