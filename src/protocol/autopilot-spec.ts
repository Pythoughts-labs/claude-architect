import type { DelegationSpec } from "./delegation-spec.js";

export interface AutopilotTaskSpec {
  id: string;
  commitMessage: string;
  delegation: DelegationSpec;
}

export interface AutopilotShippingSpec {
  provider: "github";
  draft: true;
  markReadyWhenRequiredChecksPass: true;
  requiredChecksTimeoutMs: number;
  pullRequestTitle: string;
  pullRequestBody: string;
}

export interface AutopilotSpec {
  specVersion: "1";
  topic: string;
  base: { remote: "origin"; branch: "main" };
  tasks: AutopilotTaskSpec[];
  finalSuccessCriteria: string[];
  finalVerification: DelegationSpec["verification"];
  shipping: AutopilotShippingSpec;
}
