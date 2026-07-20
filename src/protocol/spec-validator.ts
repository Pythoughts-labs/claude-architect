import path from "node:path";
import { loadSchemas } from "./schema-loader.js";
import {
  RUNTIME_MIN_EDIT_TIMEOUT_MS,
  type DelegationSpec,
} from "./delegation-spec.js";
const schemas = loadSchemas();
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: Array<{ path: string; message: string }> };

function allowlistCovers(top: string[], glob: string): boolean {
  return top.some(pattern => {
    if (pattern === "**" || pattern === glob) return true;
    if (!pattern.endsWith("/**")) return false;

    const prefix = pattern.slice(0, -3);
    return prefix === glob || glob.startsWith(`${prefix}/`);
  });
}

function isSafeRepositoryGlob(glob: string): boolean {
  return glob.length > 0
    && !path.posix.isAbsolute(glob)
    && !path.win32.isAbsolute(glob)
    && !glob.split(/[\\/]/).includes("..");
}

function validateAllowedTestDeletions(
  globs: string[] | undefined,
  basePath: string,
): ValidateResult | null {
  for (const [index, glob] of (globs ?? []).entries()) {
    if (!isSafeRepositoryGlob(glob)) {
      return {
        ok: false,
        errors: [{
          path: `${basePath}/${index}`,
          message: "must be a non-empty repository-relative glob without traversal",
        }],
      };
    }
  }
  return null;
}

// Test-only escape hatch: lets e2e suites exercise real timeout classification
// without waiting out the production 10-minute edit floor.
function resolveMinEditTimeoutMs(): number {
  const raw = process.env.CLAUDE_ARCHITECT_MIN_EDIT_TIMEOUT_MS;
  if (process.env.NODE_ENV === "test" && raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
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
  const allowsTestFloor = minEditTimeoutMs < RUNTIME_MIN_EDIT_TIMEOUT_MS
    && typeof input === "object"
    && input !== null
    && "executionMode" in input
    && input.executionMode === "edit"
    && "timeoutMs" in input
    && typeof input.timeoutMs === "number"
    && Number.isInteger(input.timeoutMs)
    && input.timeoutMs >= minEditTimeoutMs
    && input.timeoutMs < RUNTIME_MIN_EDIT_TIMEOUT_MS;
  const schemaInput = allowsTestFloor
    ? { ...input, timeoutMs: RUNTIME_MIN_EDIT_TIMEOUT_MS }
    : input;
  const schemaValid = schemas.delegationSpec(schemaInput);
  if (schemaValid) {
    const spec = input as DelegationSpec;
    const topLevelDeletionError = validateAllowedTestDeletions(
      spec.allowedTestDeletions,
      "/allowedTestDeletions",
    );
    if (topLevelDeletionError !== null) return topLevelDeletionError;
    for (const [index, command] of spec.verification.entries()) {
      const normalizedCwd = path.posix.normalize(command.cwd);
      if (
        path.isAbsolute(command.cwd)
        || normalizedCwd === ".."
        || normalizedCwd.startsWith("../")
      ) {
        return {
          ok: false,
          errors: [{
            path: `/verification/${index}/cwd`,
            message: "must be a repository-relative path that does not escape the checkout",
          }],
        };
      }
    }
    for (const [sliceIndex, slice] of (spec.slices ?? []).entries()) {
      const sliceDeletionError = validateAllowedTestDeletions(
        slice.allowedTestDeletions,
        `/slices/${sliceIndex}/allowedTestDeletions`,
      );
      if (sliceDeletionError !== null) return sliceDeletionError;
      for (const [globIndex, glob] of slice.writeAllowlist.entries()) {
        if (!allowlistCovers(spec.writeAllowlist, glob)) {
          return {
            ok: false,
            errors: [{
              path: `/slices/${sliceIndex}/writeAllowlist/${globIndex}`,
              message: "slice writeAllowlist glob must be within the spec writeAllowlist",
            }],
          };
        }
      }
      for (const [commandIndex, command] of slice.verification.entries()) {
        const normalizedCwd = path.posix.normalize(command.cwd);
        if (
          path.isAbsolute(command.cwd)
          || normalizedCwd === ".."
          || normalizedCwd.startsWith("../")
        ) {
          return {
            ok: false,
            errors: [{
              path: `/slices/${sliceIndex}/verification/${commandIndex}/cwd`,
              message: "must be a repository-relative path that does not escape the checkout",
            }],
          };
        }
      }
    }
    return { ok: true, spec };
  }
  const validationErrors = (schemas.delegationSpec.errors ?? []).map(e => {
    let message = e.message ?? "invalid";
    const allowed = (e.params as Record<string, unknown> | undefined)?.allowedValues;
    if (Array.isArray(allowed)) {
      message = `${message} (allowed values: ${allowed.map(String).join(", ")})`;
    }
    return { path: e.instancePath || e.schemaPath, message };
  });
  return { ok: false, errors: validationErrors };
}
