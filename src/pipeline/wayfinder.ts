import type { ConsolidationResult } from './consolidator.js';
import type { VerificationReport } from './report-types.js';

export type SliceRoute = 'advance' | 'repair' | 'halt';

export interface SliceGateInput {
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  roundsUsed: number;
  maxRounds: number;
  hardBlocker: boolean;
}

export interface SliceGateResult {
  route: SliceRoute;
  reasons: string[];
}

export function routeSlice(input: SliceGateInput): SliceGateResult {
  if (input.hardBlocker) {
    return { route: 'halt', reasons: ['unrecoverable blocker'] };
  }

  const reasons: string[] = [];
  const { verification } = input;

  if (verification === null) {
    return { route: 'halt', reasons: ['verification report missing (fail closed)'] };
  }

  if (!verification.pass) {
    reasons.push('slice verification failed');
  }
  if (verification.testsDeleted > 0) {
    reasons.push(`${verification.testsDeleted} test(s) deleted`);
  }
  if (verification.testsSkipped > 0) {
    reasons.push(`${verification.testsSkipped} test(s) newly skipped`);
  }
  if (!verification.workspaceClean) {
    reasons.push('verify worktree dirty after checks');
  }
  if (verification.scopeViolations.length > 0) {
    reasons.push(`out-of-scope diff: ${verification.scopeViolations.join(', ')}`);
  }

  if (
    input.perSliceReview !== null &&
    input.perSliceReview.findings.some(
      (finding) => finding.severity === 'blocker' || finding.severity === 'major',
    )
  ) {
    reasons.push('per-slice review found blocking findings');
  }

  if (reasons.length === 0) {
    return { route: 'advance', reasons };
  }

  // A slice sees exactly one review round, so there is nothing here from which
  // non-convergence could be observed: an earlier check halted whenever two
  // findings at one location were worded differently, which stopped slices whose
  // findings were merely complementary. Let the repair budget do its job; the
  // round cap below is the real backstop, and cross-round non-convergence is
  // evaluated at the final gate where the round history actually exists.
  if (input.roundsUsed < input.maxRounds) {
    return { route: 'repair', reasons };
  }

  return { route: 'halt', reasons };
}
