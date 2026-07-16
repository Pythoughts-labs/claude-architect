// src/pipeline/gates.ts
import type { Disposition, Finding, VerificationReport } from "./report-types.js";

export interface GateInput {
  findings: Finding[];
  dispositions: Disposition[];
  verification: VerificationReport | null;
  roundsUsed: number;
  maxRounds: number;
  artifactsValid: boolean;
  baselineDrift: boolean;
}

export interface GateResult {
  decisionReady: boolean;
  requiresHumanDecision: boolean;
  reasons: string[];
}

const RESOLVING = new Set(["fixed", "already_satisfied"]);
const HUMAN_ROUTED = new Set(["rejected_with_evidence", "blocked", "requires_human_decision"]);

export function evaluateGates(input: GateInput): GateResult {
  const reasons: string[] = [];
  let requiresHumanDecision = false;

  const dispositionsById = new Map(input.dispositions.map((d) => [d.findingId, d]));

  for (const finding of input.findings) {
    if (finding.severity === "nit") continue; // nits never block
    const disposition = dispositionsById.get(finding.id);
    if (!disposition) {
      reasons.push(`finding ${finding.id} (${finding.severity}) has no disposition`);
      if (finding.severity === "blocker" || finding.severity === "major") requiresHumanDecision = true;
      continue;
    }
    if (finding.severity === "minor") continue; // dispositioned minors never block
    if (RESOLVING.has(disposition.disposition)) {
      if (disposition.disposition === "fixed" && !disposition.commit) {
        reasons.push(`finding ${finding.id} marked fixed without a commit`);
      }
      continue;
    }
    reasons.push(`unresolved ${finding.severity} ${finding.id}: ${disposition.disposition}`);
    if (HUMAN_ROUTED.has(disposition.disposition)) requiresHumanDecision = true;
  }

  const v = input.verification;
  if (v === null) reasons.push("verification report missing (fail closed)");
  else {
    if (!v.pass) reasons.push("clean-room verification failed");
    if (v.testsDeleted > 0) reasons.push(`${v.testsDeleted} test(s) deleted`);
    if (v.testsSkipped > 0) reasons.push(`${v.testsSkipped} test(s) newly skipped`);
    if (!v.workspaceClean) reasons.push("verify worktree dirty after checks");
    if (v.scopeViolations.length > 0) reasons.push(`out-of-scope diff: ${v.scopeViolations.join(", ")}`);
  }

  if (!input.artifactsValid) reasons.push("missing or invalid artifact");
  if (input.baselineDrift) reasons.push("candidate no longer based on approved baseline");
  if (input.roundsUsed > input.maxRounds) {
    reasons.push(`round cap exceeded (${input.roundsUsed} > ${input.maxRounds})`);
    requiresHumanDecision = true;
  }

  return { decisionReady: reasons.length === 0, requiresHumanDecision, reasons };
}
