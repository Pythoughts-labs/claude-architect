export type CandidateDecisionValue = "accepted" | "rejected" | "revision-requested";

interface CandidateDecisionV2Base {
  decisionVersion: "2";
  candidateManifestHash: string;
  evidenceHash: string;
  policyVersion: "1";
  recordedAt: string;
}

export interface HumanCandidateDecisionV2 extends CandidateDecisionV2Base {
  decision: CandidateDecisionValue;
  authority: "human";
}

export interface AutopilotCandidateDecisionV2 extends CandidateDecisionV2Base {
  decision: "accepted";
  authority: "autopilot-policy";
}

/**
 * The autonomous decision authority shipped in 0.39.0/0.40.0: a candidate that
 * is independently verified, carries no advisory warnings, and has a readable
 * archive is accepted without prompting.
 *
 * It is a distinct authority rather than a flavour of `human`, because the
 * difference is exactly what an audit asks about — "which candidates went in
 * without a person" must be answerable by reading the record, never inferred.
 * Like `autopilot-policy` it may only ever accept; a policy that could reject
 * or request revision on its own could bury work no one reviewed.
 */
export interface PolicyAutonomousCandidateDecisionV2 extends CandidateDecisionV2Base {
  decision: "accepted";
  authority: "policy-autonomous";
}

export type CandidateDecisionV2 =
  | HumanCandidateDecisionV2
  | AutopilotCandidateDecisionV2
  | PolicyAutonomousCandidateDecisionV2;

/**
 * Authorities whose acceptance may reach a checkout.
 *
 * `caller-asserted` and provenance-less legacy records are absent on purpose:
 * they mean the runtime does not know how the decision was reached, which is a
 * different thing from knowing it was policy. Integration reads this list — if
 * a new authority is added above without being added here, its acceptance
 * becomes unspendable and the prompt it removed returns by another route.
 */
export const INTEGRABLE_DECISION_AUTHORITIES = [
  "human",
  "policy-autonomous",
  "autopilot-policy",
] as const;

export type IntegrableDecisionAuthority = typeof INTEGRABLE_DECISION_AUTHORITIES[number];

export interface AutopilotDecisionEligibilityV1 {
  eligibilityVersion: "1";
  eligible: true;
  candidateManifestHash: string;
  evidenceHash: string;
  policyVersion: "1";
}

export interface LegacyCandidateDecisionV1 {
  decisionVersion: "1";
  decision: CandidateDecisionValue;
  authority: "human";
  recordedAt: string;
}

export type CandidateDecision = CandidateDecisionV2 | LegacyCandidateDecisionV1;
