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

export type CandidateDecisionV2 = HumanCandidateDecisionV2 | AutopilotCandidateDecisionV2;

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
