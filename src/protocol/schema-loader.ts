import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import specSchema from "../../runtime/schemas/delegation-spec.v1.json" with { type: "json" };
import autopilotSpecSchema from "../../runtime/schemas/autopilot-spec.v1.json" with { type: "json" };
import resultSchema from "../../runtime/schemas/attempt-result.v1.json" with { type: "json" };
import reviewSchema from "../../runtime/schemas/review-report.v1.json" with { type: "json" };
import fixSchema from "../../runtime/schemas/fix-report.v1.json" with { type: "json" };
import incrementSchema from "../../runtime/schemas/increment-report.v1.json" with { type: "json" };
import verificationSchema from "../../runtime/schemas/verification-report.v1.json" with { type: "json" };

import { PROTOCOL_VERSION } from "./versions.js";

export const DELEGATION_SPEC_SCHEMA_KEY = "delegation-spec.v1.json";

export interface CompiledSchemas {
  delegationSpec: ValidateFunction;
  autopilotSpec: ValidateFunction;
  attemptResult: ValidateFunction;
  reviewReport: ValidateFunction;
  fixReport: ValidateFunction;
  incrementReport: ValidateFunction;
  verificationReport: ValidateFunction;
}

export function loadSchemas(): CompiledSchemas {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(specSchema as object, DELEGATION_SPEC_SCHEMA_KEY);
  const delegationSpec = ajv.getSchema(DELEGATION_SPEC_SCHEMA_KEY);
  if (delegationSpec === undefined) {
    throw new Error("failed to register the canonical Delegation Spec schema");
  }
  return {
    delegationSpec,
    autopilotSpec: ajv.compile(autopilotSpecSchema as object),
    attemptResult: ajv.compile(resultSchema as object),
    reviewReport: ajv.compile(reviewSchema as object),
    fixReport: ajv.compile(fixSchema as object),
    incrementReport: ajv.compile(incrementSchema as object),
    verificationReport: ajv.compile(verificationSchema as object),
  };
}

export function checkVersionCompat(
  skillProtocolVersion: string,
): { ok: boolean; diagnostic?: string } {
  if (skillProtocolVersion === PROTOCOL_VERSION) {
    return { ok: true };
  }

  return {
    ok: false,
    diagnostic:
      "protocol version mismatch: skill declares " +
      skillProtocolVersion +
      ", runtime expects " +
      PROTOCOL_VERSION,
  };
}
