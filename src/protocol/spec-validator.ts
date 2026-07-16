import { loadSchemas } from "./schema-loader.js";
import type { DelegationSpec } from "./delegation-spec.js";
const schemas = loadSchemas();
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: Array<{ path: string; message: string }> };
export function validateSpec(input: unknown): ValidateResult {
  const ok = schemas.delegationSpec(input);
  if (ok) return { ok: true, spec: input as DelegationSpec };
  const errors = (schemas.delegationSpec.errors ?? []).map(e => {
    let message = e.message ?? "invalid";
    const allowed = (e.params as Record<string, unknown> | undefined)?.allowedValues;
    if (Array.isArray(allowed)) {
      message = `${message} (allowed values: ${allowed.map(String).join(", ")})`;
    }
    return { path: e.instancePath || e.schemaPath, message };
  });
  return { ok: false, errors };
}
