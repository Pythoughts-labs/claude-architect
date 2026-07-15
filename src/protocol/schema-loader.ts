import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import specSchema from "../../runtime/schemas/delegation-spec.v1.json" with { type: "json" };
import resultSchema from "../../runtime/schemas/attempt-result.v1.json" with { type: "json" };

import { PROTOCOL_VERSION } from "./versions.js";

export interface CompiledSchemas {
  delegationSpec: ValidateFunction;
  attemptResult: ValidateFunction;
}

export function loadSchemas(): CompiledSchemas {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return {
    delegationSpec: ajv.compile(specSchema as object),
    attemptResult: ajv.compile(resultSchema as object),
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
