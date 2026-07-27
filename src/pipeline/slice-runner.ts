import type { Slice } from '../protocol/delegation-spec.js';
import type { ConsolidationResult } from './consolidator.js';
import type { VerificationReport } from './report-types.js';
import { planSliceWaves } from './slice-scheduler.js';
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
    /**
     * What every earlier attempt on this slice produced and why it was routed
     * to repair. A repair used to receive only a round number, so a
     * fresh-context implementer could not see the failure it was meant to fix
     * and reproduced it until the budget ran out.
     */
    priorAttempts?: readonly SliceAttemptEvidence[],
  ) => Promise<SliceAttempt>;
  maxRounds: number;
  initialAttempt?: SliceAttempt;
  onAttempt?: (evidence: SliceAttemptEvidence) => Promise<void>;
  onSlice?: (result: PipelineSlice) => Promise<void>;
  /**
   * Maximum slices executed at once. Slices only share a wave when their
   * declared dependencies allow it and their write allowlists are pairwise
   * disjoint, so the default of one reproduces sequential execution.
   */
  concurrency?: number;
  /**
   * Replays a slice's changes onto the wave's composed head. Only called when a
   * wave produced more than one slice: with a single slice the composed head is
   * already that slice's commit, so sequential runs keep today's exact chain.
   */
  composeSlice?: (args: {
    head: string;
    base: string;
    sliceCommit: string;
    sliceIndex: number;
  }) => Promise<string>;
}

export interface SlicePhaseResult {
  slices: PipelineSlice[];
  finalCandidateCommit: string;
  haltedSliceIndex: number | null;
}

interface SliceOutcome {
  slice: PipelineSlice;
  advanced: boolean;
}

async function runSliceToCompletion(
  slice: Slice,
  index: number,
  base: string,
  deps: SlicePhaseDeps,
  initialAttempt: SliceAttempt | undefined,
): Promise<SliceOutcome> {
  let roundsUsed = 0;
  const attempts: SliceAttemptEvidence[] = [];

  while (true) {
    const sourceAttempt = roundsUsed === 0 && initialAttempt !== undefined
      ? initialAttempt
      : await deps.runSlice(slice, index, base, roundsUsed, attempts.map(e => structuredClone(e)));
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

    if (route.route === 'repair') {
      roundsUsed += 1;
      continue;
    }
    return { slice: pipelineSlice, advanced: route.route === 'advance' };
  }
}

export async function runSlicePhase(
  slices: Slice[],
  startCommit: string,
  deps: SlicePhaseDeps,
): Promise<SlicePhaseResult> {
  let currentCommit = startCommit;
  const results: PipelineSlice[] = [];

  for (const wave of planSliceWaves(slices, deps.concurrency ?? 1)) {
    const base = currentCommit;
    const outcomes = await Promise.all(wave.indices.map(index => runSliceToCompletion(
      slices[index - 1]!,
      index,
      base,
      deps,
      index === 1 ? deps.initialAttempt : undefined,
    )));

    // Compose in slice order so the candidate chain reads the way the spec was
    // written, whatever order the wave happened to finish in.
    for (const outcome of outcomes) {
      const composed = wave.indices.length === 1 || deps.composeSlice === undefined
        ? outcome.slice.candidateCommit
        : await deps.composeSlice({
          head: currentCommit,
          base,
          sliceCommit: outcome.slice.candidateCommit,
          sliceIndex: outcome.slice.index,
        });
      const recorded: PipelineSlice = { ...outcome.slice, candidateCommit: composed };
      results.push(recorded);
      if (deps.onSlice) {
        await deps.onSlice(structuredClone(recorded));
      }
      if (!outcome.advanced) {
        return {
          slices: results,
          finalCandidateCommit: currentCommit,
          haltedSliceIndex: recorded.index,
        };
      }
      currentCommit = composed;
    }
  }

  return {
    slices: results,
    finalCandidateCommit: currentCommit,
    haltedSliceIndex: null,
  };
}
