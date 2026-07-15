import { loadSchemas } from "./schema-loader.js";
import type { DelegationSpec } from "./delegation-spec.js";
const schemas = loadSchemas();
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: Array<{ path: string; message: string }> };
export function validateSpec(input: unknown): ValidateResult {
  const ok = schemas.delegationSpec(input);
  if (ok) return { ok: true, spec: input as DelegationSpec };
  const errors = (schemas.delegationSpec.errors ?? []).map(e => ({
    path: e.instancePath || e.schemaPath, message: e.message ?? "invalid",
  }));
  return { ok: false, errors };
}
