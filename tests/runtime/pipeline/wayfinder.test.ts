import { describe, expect, it } from 'vitest';

import type { VerificationReport } from '../../../src/pipeline/report-types.js';
import { routeSlice } from '../../../src/pipeline/wayfinder.js';

function verification(pass: boolean): VerificationReport {
  return {
    pass,
    testsDeleted: 0,
    testsSkipped: 0,
    workspaceClean: true,
    scopeViolations: [],
  } as unknown as VerificationReport;
}

describe('routeSlice', () => {
  it('advances when all gates are green', () => {
    expect(
      routeSlice({
        verification: verification(true),
        perSliceReview: null,
        roundsUsed: 0,
        maxRounds: 2,
        hardBlocker: false,
      }),
    ).toEqual({ route: 'advance', reasons: [] });
  });

  it('repairs a red gate while rounds remain', () => {
    expect(
      routeSlice({
        verification: verification(false),
        perSliceReview: null,
        roundsUsed: 0,
        maxRounds: 2,
        hardBlocker: false,
      }),
    ).toEqual({ route: 'repair', reasons: ['slice verification failed'] });
  });

  it('halts a red gate when rounds are exhausted', () => {
    expect(
      routeSlice({
        verification: verification(false),
        perSliceReview: null,
        roundsUsed: 2,
        maxRounds: 2,
        hardBlocker: false,
      }),
    ).toEqual({ route: 'halt', reasons: ['slice verification failed'] });
  });

  it('halts on a hard blocker even when gates are green', () => {
    expect(
      routeSlice({
        verification: verification(true),
        perSliceReview: null,
        roundsUsed: 0,
        maxRounds: 2,
        hardBlocker: true,
      }),
    ).toEqual({ route: 'halt', reasons: ['unrecoverable blocker'] });
  });

  it('halts on missing verification when rounds are exhausted', () => {
    expect(
      routeSlice({
        verification: null,
        perSliceReview: null,
        roundsUsed: 2,
        maxRounds: 2,
        hardBlocker: false,
      }),
    ).toEqual({
      route: 'halt',
      reasons: ['verification report missing (fail closed)'],
    });
  });

  it('halts immediately when the review contradicts itself', () => {
    // Observed live: a slice whose review demanded conflicting outcomes at one
    // location burned all three attempts and then halted as an ordinary blocking
    // review, so nothing in the record said repair could never converge.
    const result = routeSlice({
      verification: verification(false),
      perSliceReview: {
        findings: [],
        contradictions: ['conflicting required outcomes at src/a.ts:394-395: F-005, F-006'],
      },
      roundsUsed: 0,
      maxRounds: 3,
      hardBlocker: false,
    });

    expect(result.route).toBe('halt');
    expect(result.reasons).toEqual([
      'slice verification failed',
      'review is self-contradictory, repair cannot converge: '
      + 'conflicting required outcomes at src/a.ts:394-395: F-005, F-006',
    ]);
  });

  it('still repairs when the review is blocking but consistent', () => {
    expect(
      routeSlice({
        verification: verification(false),
        perSliceReview: { findings: [], contradictions: [] },
        roundsUsed: 0,
        maxRounds: 3,
        hardBlocker: false,
      }),
    ).toEqual({ route: 'repair', reasons: ['slice verification failed'] });
  });

  it('advances despite a contradiction when no gate is red', () => {
    // A contradiction among findings that do not block must not invent a halt.
    expect(
      routeSlice({
        verification: verification(true),
        perSliceReview: {
          findings: [],
          contradictions: ['conflicting required outcomes at src/a.ts:1: F-001, F-002'],
        },
        roundsUsed: 0,
        maxRounds: 3,
        hardBlocker: false,
      }),
    ).toEqual({ route: 'advance', reasons: [] });
  });

  it('halts on missing verification while rounds remain', () => {
    expect(
      routeSlice({
        verification: null,
        perSliceReview: null,
        roundsUsed: 0,
        maxRounds: 2,
        hardBlocker: false,
      }),
    ).toEqual({
      route: 'halt',
      reasons: ['verification report missing (fail closed)'],
    });
  });
});
