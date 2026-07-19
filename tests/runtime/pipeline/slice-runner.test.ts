import { describe, expect, it, vi } from 'vitest';

import type { ConsolidationResult } from '../../../src/pipeline/consolidator.js';
import type { VerificationReport } from '../../../src/pipeline/report-types.js';
import {
  runSlicePhase,
  type SliceAttempt,
  type SliceAttemptEvidence,
} from '../../../src/pipeline/slice-runner.js';
import type { Slice } from '../../../src/protocol/delegation-spec.js';

function slice(objective: string): Slice {
  return {
    objective,
    context: '',
    writeAllowlist: [],
    forbiddenScope: [],
    successCriteria: [],
    verification: [],
  };
}

function verification(pass: boolean): VerificationReport {
  return {
    reportVersion: '1',
    pass,
    commandResults: [{ id: 'verify', exitCode: pass ? 0 : 1, ok: pass }],
    testsDeleted: 0,
    testsSkipped: 0,
    workspaceClean: true,
    scopeViolations: [],
  };
}

function attempt(candidateCommit: string, pass: boolean, hardBlocker = false): SliceAttempt {
  return {
    candidateCommit,
    verification: verification(pass),
    hardBlocker,
  };
}

function review(severity: 'blocker' | 'major' | 'minor'): ConsolidationResult {
  return {
    findings: [{
      id: 'F-001',
      severity,
      location: 'src/example.ts:1',
      claim: 'objective finding',
      evidence: 'review evidence',
      reproduction: 'inspect the candidate',
      requiredOutcome: 'correct the candidate',
      confidence: 1,
      reviewers: ['correctness'],
    }],
    contradictions: [],
  };
}

function evidencedAttempt(candidateCommit: string, severity: 'major' | 'minor' = 'minor') {
  return {
    ...attempt(candidateCommit, true),
    perSliceReview: review(severity),
    roleLogRefs: ['logs/objective.log'],
  } satisfies SliceAttempt;
}

function mutateNestedEvidence(evidence: {
  verification: VerificationReport | null;
  perSliceReview?: ConsolidationResult | null;
}): void {
  if (evidence.verification === null || evidence.perSliceReview == null) {
    throw new Error('test requires complete objective evidence');
  }
  evidence.verification.pass = false;
  evidence.verification.commandResults[0]!.id = 'mutated';
  evidence.verification.commandResults.push({ id: 'injected', exitCode: 1, ok: false });
  evidence.verification.scopeViolations.push('mutated-scope');
  evidence.perSliceReview.findings[0]!.severity = 'blocker';
  evidence.perSliceReview.findings[0]!.reviewers.push('mutator');
  evidence.perSliceReview.contradictions.push('mutated contradiction');
}

function expectObjectiveEvidence(
  evidence: {
    verification: VerificationReport | null;
    perSliceReview?: ConsolidationResult | null;
  },
  severity: 'major' | 'minor' = 'minor',
): void {
  expect(evidence.verification).toEqual(verification(true));
  expect(evidence.perSliceReview).toEqual(review(severity));
}

describe('runSlicePhase', () => {
  it('advances through all green slices', async () => {
    const runSlice = vi
      .fn()
      .mockResolvedValueOnce(attempt('slice-1-commit', true))
      .mockResolvedValueOnce(attempt('slice-2-commit', true));

    const result = await runSlicePhase([slice('first'), slice('second')], 'start', {
      runSlice,
      maxRounds: 1,
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'slice-2-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices).toEqual([
      expect.objectContaining({ index: 1, route: 'advance', roundsUsed: 0 }),
      expect.objectContaining({ index: 2, route: 'advance', roundsUsed: 0 }),
    ]);
    expect(runSlice).toHaveBeenNthCalledWith(1, expect.anything(), 1, 'start', 0);
    expect(runSlice).toHaveBeenNthCalledWith(2, expect.anything(), 2, 'slice-1-commit', 0);
  });

  it('consumes a green initial attempt before running slice 2 from its commit', async () => {
    const slices = [slice('seeded'), slice('second')];
    const runSlice = vi.fn().mockResolvedValue(attempt('slice-2-commit', true));

    const result = await runSlicePhase(slices, 'start', {
      runSlice,
      maxRounds: 1,
      initialAttempt: attempt('seed-commit', true),
    });

    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(runSlice).toHaveBeenCalledWith(slices[1], 2, 'seed-commit', 0);
    expect(result.slices.map(({ index, candidateCommit }) => ({ index, candidateCommit }))).toEqual([
      { index: 1, candidateCommit: 'seed-commit' },
      { index: 2, candidateCommit: 'slice-2-commit' },
    ]);
    expect(result.slices[0]?.attempts).toEqual([
      expect.objectContaining({ sliceIndex: 1, attempt: 0, route: 'advance' }),
    ]);
  });

  it('repairs a red initial attempt from the original base at attempt 1', async () => {
    const seededSlice = slice('seeded repair');
    const runSlice = vi.fn().mockResolvedValue(attempt('repaired-commit', true));

    const result = await runSlicePhase([seededSlice], 'start', {
      runSlice,
      maxRounds: 1,
      initialAttempt: attempt('red-seed-commit', false),
    });

    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(runSlice).toHaveBeenCalledWith(seededSlice, 1, 'start', 1);
    expect(result.slices[0]?.attempts).toEqual([
      expect.objectContaining({ attempt: 0, candidateCommit: 'red-seed-commit', route: 'repair' }),
      expect.objectContaining({ attempt: 1, candidateCommit: 'repaired-commit', route: 'advance' }),
    ]);
  });

  it.each(['blocker', 'major'] as const)(
    'routes a green verification with a %s review finding to halt',
    async severity => {
      const perSliceReview = review(severity);
      const runSlice = vi.fn().mockResolvedValue({
        ...attempt('reviewed-commit', true),
        perSliceReview,
      });

      const result = await runSlicePhase([slice('reviewed')], 'start', {
        runSlice,
        maxRounds: 0,
      });

      expect(result).toMatchObject({
        finalCandidateCommit: 'start',
        haltedSliceIndex: 1,
      });
      expect(result.slices[0]).toMatchObject({
        route: 'halt',
        perSliceReview,
        reasons: ['per-slice review found blocking findings'],
      });
      expect(result.slices[0]?.attempts[0]).toMatchObject({
        perSliceReview,
        route: 'halt',
      });
    },
  );

  it('repairs a green verification with a major review finding when a round remains', async () => {
    const runSlice = vi
      .fn()
      .mockResolvedValueOnce({
        ...attempt('reviewed-commit', true),
        perSliceReview: review('major'),
      })
      .mockResolvedValueOnce(attempt('clean-commit', true));

    const result = await runSlicePhase([slice('review repair')], 'start', {
      runSlice,
      maxRounds: 1,
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'clean-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({ perSliceReview: null, route: 'advance' });
    expect(result.slices[0]?.attempts).toEqual([
      expect.objectContaining({
        attempt: 0,
        route: 'repair',
        reasons: ['per-slice review found blocking findings'],
      }),
      expect.objectContaining({ attempt: 1, route: 'advance', reasons: [] }),
    ]);
  });

  it.each([undefined, null])(
    'preserves verification-only routing when review evidence is %s',
    async perSliceReview => {
      const runSlice = vi.fn().mockResolvedValue({
        ...attempt('verified-commit', true),
        ...(perSliceReview === undefined ? {} : { perSliceReview }),
      });

      const result = await runSlicePhase([slice('verification only')], 'start', {
        runSlice,
        maxRounds: 0,
      });

      expect(result).toMatchObject({
        finalCandidateCommit: 'verified-commit',
        haltedSliceIndex: null,
      });
      expect(result.slices[0]).toMatchObject({
        route: 'advance',
        perSliceReview: null,
        reasons: [],
      });
    },
  );

  it('halts a slice that stays red past the maximum rounds', async () => {
    const runSlice = vi
      .fn()
      .mockResolvedValueOnce(attempt('slice-1-commit', true))
      .mockResolvedValueOnce(attempt('slice-2-attempt-0', false))
      .mockResolvedValueOnce(attempt('slice-2-attempt-1', false));

    const result = await runSlicePhase(
      [slice('first'), slice('second'), slice('not run')],
      'start',
      { runSlice, maxRounds: 1 },
    );

    expect(result).toMatchObject({
      finalCandidateCommit: 'slice-1-commit',
      haltedSliceIndex: 2,
    });
    expect(result.slices).toEqual([
      expect.objectContaining({ index: 1, route: 'advance', roundsUsed: 0 }),
      expect.objectContaining({
        index: 2,
        route: 'halt',
        candidateCommit: 'slice-2-attempt-1',
        roundsUsed: 1,
      }),
    ]);
    expect(runSlice).toHaveBeenCalledTimes(3);
  });

  it('retries a red slice and advances a later green attempt', async () => {
    const firstRoleLogRefs = ['logs/attempt-0.log'];
    const secondRoleLogRefs = ['logs/attempt-1.log'];
    const runSlice = vi
      .fn()
      .mockResolvedValueOnce({
        ...attempt('failed-attempt', false),
        roleLogRefs: firstRoleLogRefs,
      })
      .mockResolvedValueOnce({
        ...attempt('repaired-commit', true),
        roleLogRefs: secondRoleLogRefs,
      });
    const observed: SliceAttemptEvidence[] = [];

    const result = await runSlicePhase([slice('repairable')], 'start', {
      runSlice,
      maxRounds: 2,
      onAttempt: async evidence => {
        observed.push({
          ...evidence,
          reasons: [...evidence.reasons],
          roleLogRefs: [...evidence.roleLogRefs],
        });
        evidence.reasons.push('callback mutation');
        evidence.roleLogRefs.push('logs/callback-mutation.log');
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'repaired-commit',
      haltedSliceIndex: null,
    });
    expect(observed).toEqual([
      expect.objectContaining({
        sliceIndex: 1,
        attempt: 0,
        candidateCommit: 'failed-attempt',
        route: 'repair',
        reasons: ['slice verification failed'],
        roleLogRefs: ['logs/attempt-0.log'],
      }),
      expect.objectContaining({
        sliceIndex: 1,
        attempt: 1,
        candidateCommit: 'repaired-commit',
        route: 'advance',
        reasons: [],
        roleLogRefs: ['logs/attempt-1.log'],
      }),
    ]);
    expect(result.slices).toEqual([
      expect.objectContaining({
        route: 'advance',
        candidateCommit: 'repaired-commit',
        roundsUsed: 1,
        perSliceReview: null,
        reasons: [],
        roleLogRefs: ['logs/attempt-0.log', 'logs/attempt-1.log'],
        attempts: observed,
      }),
    ]);
    firstRoleLogRefs.push('logs/caller-mutation.log');
    secondRoleLogRefs.length = 0;
    expect(result.slices[0]?.attempts.map(entry => entry.roleLogRefs)).toEqual([
      ['logs/attempt-0.log'],
      ['logs/attempt-1.log'],
    ]);
    expect(result.slices[0]?.roleLogRefs).toEqual([
      'logs/attempt-0.log',
      'logs/attempt-1.log',
    ]);
    expect(result.slices[0]?.reasons).not.toBe(result.slices[0]?.attempts[1]?.reasons);
    expect(runSlice).toHaveBeenNthCalledWith(2, expect.anything(), 1, 'start', 1);
  });

  it('snapshots the source attempt before onAttempt can mutate it', async () => {
    const sourceAttempt = evidencedAttempt('source-commit');

    const result = await runSlicePhase([slice('source isolation')], 'start', {
      runSlice: vi.fn().mockResolvedValue(sourceAttempt),
      maxRounds: 0,
      onAttempt: async () => {
        sourceAttempt.candidateCommit = 'mutated-source-commit';
        sourceAttempt.hardBlocker = true;
        sourceAttempt.roleLogRefs.push('logs/mutated-source.log');
        mutateNestedEvidence(sourceAttempt);
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'source-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'source-commit',
      route: 'advance',
      reasons: [],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expect(result.slices[0]?.attempts[0]).toMatchObject({
      candidateCommit: 'source-commit',
      route: 'advance',
      reasons: [],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!);
  });

  it('isolates retained evidence from nested onAttempt mutations', async () => {
    const result = await runSlicePhase([slice('attempt callback isolation')], 'start', {
      runSlice: vi.fn().mockResolvedValue(evidencedAttempt('callback-commit')),
      maxRounds: 0,
      onAttempt: async evidence => {
        evidence.candidateCommit = 'mutated-callback-commit';
        evidence.reasons.push('mutated callback reason');
        evidence.roleLogRefs.push('logs/mutated-callback.log');
        mutateNestedEvidence(evidence);
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'callback-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'callback-commit',
      route: 'advance',
      reasons: [],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expect(result.slices[0]?.attempts[0]).toMatchObject({
      candidateCommit: 'callback-commit',
      reasons: [],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!);
  });

  it('rejects failed attempt persistence before onSlice or another slice starts', async () => {
    const runSlice = vi.fn().mockResolvedValue(attempt('candidate', true));
    const onAttempt = vi.fn().mockRejectedValue(new Error('attempt persistence failed'));
    const onSlice = vi.fn().mockResolvedValue(undefined);

    await expect(runSlicePhase([slice('first'), slice('not run')], 'start', {
      runSlice,
      maxRounds: 1,
      onAttempt,
      onSlice,
    })).rejects.toThrow('attempt persistence failed');

    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onSlice).not.toHaveBeenCalled();
  });

  it('isolates an advanced result from nested onSlice mutations', async () => {
    const result = await runSlicePhase([slice('advance callback isolation')], 'start', {
      runSlice: vi.fn().mockResolvedValue(evidencedAttempt('advanced-commit')),
      maxRounds: 0,
      onSlice: async terminal => {
        terminal.candidateCommit = 'mutated-advanced-commit';
        terminal.route = 'halt';
        terminal.reasons.push('mutated callback reason');
        terminal.roleLogRefs.push('logs/mutated-callback.log');
        mutateNestedEvidence(terminal);
        terminal.attempts[0]!.candidateCommit = 'mutated-attempt-commit';
        mutateNestedEvidence(terminal.attempts[0]!);
        terminal.attempts.length = 0;
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'advanced-commit',
      haltedSliceIndex: null,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'advanced-commit',
      route: 'advance',
      reasons: [],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!);
    expect(result.slices[0]?.attempts).toHaveLength(1);
    expect(result.slices[0]?.attempts[0]).toMatchObject({
      candidateCommit: 'advanced-commit',
      route: 'advance',
    });
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!);
  });

  it('isolates a halted result from nested onSlice mutations', async () => {
    const result = await runSlicePhase([slice('halt callback isolation')], 'start', {
      runSlice: vi.fn().mockResolvedValue(evidencedAttempt('halted-commit', 'major')),
      maxRounds: 0,
      onSlice: async terminal => {
        terminal.candidateCommit = 'mutated-halted-commit';
        terminal.route = 'advance';
        terminal.reasons.length = 0;
        terminal.roleLogRefs.push('logs/mutated-callback.log');
        mutateNestedEvidence(terminal);
        terminal.attempts.length = 0;
      },
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'start',
      haltedSliceIndex: 1,
    });
    expect(result.slices[0]).toMatchObject({
      candidateCommit: 'halted-commit',
      route: 'halt',
      reasons: ['per-slice review found blocking findings'],
      roleLogRefs: ['logs/objective.log'],
    });
    expectObjectiveEvidence(result.slices[0]!, 'major');
    expect(result.slices[0]?.attempts).toHaveLength(1);
    expect(result.slices[0]?.attempts[0]).toMatchObject({
      candidateCommit: 'halted-commit',
      route: 'halt',
    });
    expectObjectiveEvidence(result.slices[0]!.attempts[0]!, 'major');
  });

  it('halts immediately on a hard blocker', async () => {
    const runSlice = vi.fn().mockResolvedValue(attempt('blocked-commit', true, true));
    const onAttempt = vi.fn().mockResolvedValue(undefined);

    const result = await runSlicePhase([slice('blocked'), slice('not run')], 'start', {
      runSlice,
      maxRounds: 2,
      onAttempt,
    });

    expect(result).toMatchObject({
      finalCandidateCommit: 'start',
      haltedSliceIndex: 1,
    });
    expect(result.slices).toEqual([
      expect.objectContaining({
        index: 1,
        route: 'halt',
        candidateCommit: 'blocked-commit',
        roundsUsed: 0,
        reasons: ['unrecoverable blocker'],
      }),
    ]);
    expect(runSlice).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledOnce();
    expect(onAttempt).toHaveBeenCalledWith(expect.objectContaining({
      sliceIndex: 1,
      attempt: 0,
      route: 'halt',
      reasons: ['unrecoverable blocker'],
    }));
  });
});
