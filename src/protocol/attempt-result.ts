import type { VerificationCommand } from "./delegation-spec.js";

export type AttemptStatus = "unavailable" | "failed" | "cancelled" | "verified-candidate";

// Precedence order is the ARRAY order below (earliest wins). AttemptRuntime.classify()
// walks this list; the first applicable reason is the canonical FailureClassification.
export const FAILURE_PRECEDENCE = [
  "invalid-specification",
  "unavailable",                 // pre-launch unavailability
  "authentication-required",     // pre-launch; never triggers fallback
  "spawn-failure",
  "cancelled",                   // per the initiating runtime event
  "timeout",
  "sandbox-violation",
  "invalid-output",
  "producer-failure",
  "verification-failure",
] as const;
export type FailureClassification = (typeof FAILURE_PRECEDENCE)[number];

export interface ChangedPath {
  path: string;                  // repo-relative, forward-slash normalized
  changeType: "added" | "modified" | "deleted";
  mode: string;                  // git mode, e.g. "100644"
  contentHash: string | null;    // blob oid; null for deletions
}

export interface CandidateArtifact {
  baseCommitOid: string;
  candidateTreeOid: string;
  candidateCommitOid: string;    // anchors the tree against GC (Task 9)
  anchorRef: string;             // refs/claude-architect/candidates/<runId>
  manifestHash: string;          // sha256 over the sorted ChangedPath manifest
  changedPaths: ChangedPath[];
  patch: string;                 // git diff --binary --full-index (review/portability only)
}

export interface CommandOutcome {
  id: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutRef: string;             // archive pointer (redacted, bounded)
  stderrRef: string;
}

export interface AttemptResult {
  resultVersion: "1";
  runId: string;
  status: AttemptStatus;
  failure: FailureClassification | null;   // null iff status === "verified-candidate"
  summary: string;                          // runtime-authored; producer summary is a separate untrusted field
  producerSummary: string | null;           // UNTRUSTED
  // Non-null whenever freezing SUCCEEDED, regardless of verification outcome. Spec: "a changed base
  // preserves the Candidate Artifact but yields verification-failed." So a verification-failure result
  // still carries the frozen artifact (tree oid, anchor ref, manifest, patch) and archives it.
  // Null only when no candidate was ever frozen (unavailable / spawn-failure / invalid-output / empty-candidate).
  candidate: CandidateArtifact | null;
  requestedVerification: VerificationCommand[];
  executedVerification: CommandOutcome[];
  unresolvedIssues: string[];
  evidence: Record<string, unknown>;        // structural + project verification evidence
  logsRef: string;                          // archive pointer
  producerId: string | null;
  producerVersion: string | null;
  producerModel: string | null;
  durationMs: number;
  sessionId: string | null;
}

export type FailureSignals = Partial<Record<FailureClassification, boolean>>;
export function classifyFailure(s: FailureSignals): FailureClassification | null {
  for (const reason of FAILURE_PRECEDENCE) if (s[reason]) return reason;
  return null;
}
