// src/pipeline/consolidator.ts
import type { Finding, FindingSeverity, RawFinding, ReviewReport } from "./report-types.js";

const SEVERITY_ORDER: Record<FindingSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export interface ConsolidationResult {
  findings: Finding[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dedupe key: same location + same normalized claim = the same finding. */
function dedupeKey(f: RawFinding): string {
  return `${f.location} ${normalize(f.claim)}`;
}

export function consolidate(reports: { reviewer: string; report: ReviewReport }[]): ConsolidationResult {
  const byKey = new Map<string, { finding: RawFinding; reviewers: Set<string> }>();

  // Deterministic: process in sorted reviewer order, findings in given order.
  const sorted = [...reports].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
  for (const { reviewer, report } of sorted) {
    for (const raw of report.findings) {
      const key = dedupeKey(raw);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { finding: { ...raw }, reviewers: new Set([reviewer]) });
        continue;
      }
      existing.reviewers.add(reviewer);
      // Preserve highest severity; never downgrade.
      if (SEVERITY_ORDER[raw.severity] < SEVERITY_ORDER[existing.finding.severity]) {
        existing.finding.severity = raw.severity;
      }
      existing.finding.confidence = Math.max(existing.finding.confidence, raw.confidence);
    }
  }

  const merged = [...byKey.values()].sort((a, b) =>
    SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
    || a.finding.location.localeCompare(b.finding.location)
    || normalize(a.finding.claim).localeCompare(normalize(b.finding.claim)));

  const findings: Finding[] = merged.map((entry, index) => ({
    ...entry.finding,
    id: `F-${String(index + 1).padStart(3, "0")}`,
    reviewers: [...entry.reviewers].sort(),
  }));

  // Deliberately no contradiction inference here. Two findings at one location
  // whose `requiredOutcome` prose differs are usually complementary ("add the
  // null check" plus "rename the variable"), not mutually exclusive — and a nit
  // sitting beside a major differs textually by construction. Treating prose
  // inequality as conflict halted independently green, reviewer-approved
  // candidates. Whether a review is actually irreconcilable is only observable
  // across rounds, which `detectNonConvergence` measures.
  return { findings };
}

const BLOCKING = new Set<FindingSeverity>(["blocker", "major"]);

export interface RoundSummary {
  round: number;
  findings: Finding[];
  /** Whether a fix was actually attempted for this round. */
  fixAttempted: boolean;
}

/**
 * Objective non-convergence: a location that still carries a blocking finding
 * after a fix round targeted it is not converging, however the reviewers phrased
 * themselves. That is a real reason to route to a human, and unlike prose
 * comparison it cannot fire on a single round or on advisory findings.
 */
export function detectNonConvergence(rounds: RoundSummary[]): string[] {
  const survived = new Map<string, { rounds: number[]; ids: Set<string> }>();
  for (const round of rounds) {
    for (const finding of round.findings) {
      if (!BLOCKING.has(finding.severity)) continue;
      const entry = survived.get(finding.location) ?? { rounds: [], ids: new Set<string>() };
      if (!entry.rounds.includes(round.round)) entry.rounds.push(round.round);
      entry.ids.add(finding.id);
      survived.set(finding.location, entry);
    }
  }

  // A location only counts as non-converging if a fix round ran between the
  // first and last time it was reported blocking; otherwise the loop simply has
  // not had its chance yet.
  const fixedRounds = new Set(rounds.filter(round => round.fixAttempted).map(round => round.round));
  const reasons: string[] = [];
  for (const [location, entry] of survived) {
    if (entry.rounds.length < 2) continue;
    const first = Math.min(...entry.rounds);
    const last = Math.max(...entry.rounds);
    const interveningFix = [...fixedRounds].some(round => round >= first && round < last);
    if (!interveningFix) continue;
    reasons.push(
      `blocking findings at ${location} survived ${entry.rounds.length} review rounds despite a fix attempt: ${
        [...entry.ids].sort().join(", ")}`);
  }
  return reasons.sort();
}
