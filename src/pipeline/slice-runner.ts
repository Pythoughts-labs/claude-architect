import type { Slice } from '../protocol/delegation-spec.js';
import type { ConsolidationResult } from './consolidator.js';
import type { VerificationReport } from './report-types.js';
import { routeSlice, type SliceRoute } from './wayfinder.js';

export interface SliceAttemptEvidence {
  sliceIndex: number;
  attempt: number;
  candidateCommit: string;
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  route: SliceRoute;
  reasons: string[];
  roleLogRefs: string[];
}

export interface PipelineSlice {
  index: number;
  objective: string;
  route: SliceRoute;
  candidateCommit: string;
  roundsUsed: number;
  verification: VerificationReport | null;
  perSliceReview: ConsolidationResult | null;
  reasons: string[];
  attempts: SliceAttemptEvidence[];
  roleLogRefs: string[];
}

export interface SliceAttempt {
  candidateCommit: string;
  verification: VerificationReport | null;
  perSliceReview?: ConsolidationResult | null;
  roleLogRefs?: string[];
  hardBlocker?: boolean;
}

export interface SlicePhaseDeps {
  runSlice: (
    slice: Slice,
    index: number,
    base: string,
    attempt: number,
  ) => Promise<SliceAttempt>;
  maxRounds: number;
  initialAttempt?: SliceAttempt;
  onAttempt?: (evidence: SliceAttemptEvidence) => Promise<void>;
  onSlice?: (result: PipelineSlice) => Promise<void>;
}

export interface SlicePhaseResult {
  slices: PipelineSlice[];
  finalCandidateCommit: string;
  haltedSliceIndex: number | null;
}

export async function runSlicePhase(
  slices: Slice[],
  startCommit: string,
  deps: SlicePhaseDeps,
): Promise<SlicePhaseResult> {
  let currentCommit = startCommit;
  const results: PipelineSlice[] = [];

  for (const [offset, slice] of slices.entries()) {
    const index = offset + 1;
    let roundsUsed = 0;
    const attempts: SliceAttemptEvidence[] = [];

    while (true) {
      const sourceAttempt = index === 1 && roundsUsed === 0 && deps.initialAttempt !== undefined
        ? deps.initialAttempt
        : await deps.runSlice(slice, index, currentCommit, roundsUsed);
      const attempt = structuredClone(sourceAttempt);
      const perSliceReview = attempt.perSliceReview ?? null;
      const route = routeSlice({
        verification: attempt.verification,
        perSliceReview,
        roundsUsed,
        maxRounds: deps.maxRounds,
        hardBlocker: attempt.hardBlocker ?? false,
      });
      const evidence: SliceAttemptEvidence = {
        sliceIndex: index,
        attempt: roundsUsed,
        candidateCommit: attempt.candidateCommit,
        verification: attempt.verification,
        perSliceReview,
        route: route.route,
        reasons: [...route.reasons],
        roleLogRefs: [...(attempt.roleLogRefs ?? [])],
      };

      if (deps.onAttempt) {
        await deps.onAttempt(structuredClone(evidence));
      }
      attempts.push(evidence);

      const pipelineSlice: PipelineSlice = {
        index,
        objective: slice.objective,
        route: route.route,
        candidateCommit: attempt.candidateCommit,
        roundsUsed,
        verification: attempt.verification,
        perSliceReview,
        reasons: [...route.reasons],
        attempts: attempts.map(entry => ({
          ...entry,
          reasons: [...entry.reasons],
          roleLogRefs: [...entry.roleLogRefs],
        })),
        roleLogRefs: attempts.flatMap(entry => entry.roleLogRefs),
      };

      if (route.route === 'advance') {
        results.push(pipelineSlice);
        if (deps.onSlice) {
          await deps.onSlice(structuredClone(pipelineSlice));
        }
        currentCommit = attempt.candidateCommit;
        break;
      }

      if (route.route === 'repair') {
        roundsUsed += 1;
        continue;
      }

      results.push(pipelineSlice);
      if (deps.onSlice) {
        await deps.onSlice(structuredClone(pipelineSlice));
      }
      return {
        slices: results,
        finalCandidateCommit: currentCommit,
        haltedSliceIndex: index,
      };
    }
  }

  return {
    slices: results,
    finalCandidateCommit: currentCommit,
    haltedSliceIndex: null,
  };
}
