import { loadSchemas } from "./schema-loader.js";
import {
  RUNTIME_MIN_EDIT_TIMEOUT_MS,
  type DelegationSpec,
} from "./delegation-spec.js";
const schemas = loadSchemas();
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: Array<{ path: string; message: string }> };
// Test-only escape hatch: lets e2e suites exercise real timeout classification
// without waiting out the production 10-minute edit floor.
function resolveMinEditTimeoutMs(): number {
  const raw = process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  }
  return RUNTIME_MIN_EDIT_TIMEOUT_MS;
}
export function validateSpec(input: unknown): ValidateResult {
  const minEditTimeoutMs = resolveMinEditTimeoutMs();
  if (
    typeof input === "object"
    && input !== null
    && "executionMode" in input
    && input.executionMode === "edit"
    && "timeoutMs" in input
    && typeof input.timeoutMs === "number"
    && input.timeoutMs < minEditTimeoutMs
  ) {
    return {
      ok: false,
      errors: [{
        path: "/timeoutMs",
        message: `must be at least ${minEditTimeoutMs}ms for edit-mode specs`,
      }],
    };
  }
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
