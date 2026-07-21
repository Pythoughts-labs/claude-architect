import path from "node:path";
import { loadSchemas } from "./schema-loader.js";
import {
  RUNTIME_MIN_EDIT_TIMEOUT_MS,
  type DelegationSpec,
} from "./delegation-spec.js";
import type { AutopilotSpec } from "./autopilot-spec.js";
const schemas = loadSchemas();
type ValidationError = { path: string; message: string };
export type ValidateResult =
  | { ok: true; spec: DelegationSpec }
  | { ok: false; errors: ValidationError[] };
export type ValidateAutopilotResult =
  | { ok: true; spec: AutopilotSpec }
  | { ok: false; errors: ValidationError[] };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function prefixDelegationError(taskId: string, error: ValidationError): ValidationError {
  const suffix = error.path.startsWith("#") ? error.path.slice(1) : error.path;
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return {
    path: `#/tasks/${escapeJsonPointerSegment(taskId)}/delegation${normalizedSuffix}`,
    message: error.message,
  };
}

function isSafeCommitMessage(message: string): boolean {
  const byteLength = Buffer.byteLength(message, "utf8");
  if (message.trim().length === 0 || byteLength > 200) return false;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(message)) return false;
  if (/\bco-authored-by\s*:/iu.test(message)) return false;
  if (/\bgenerated(?:-|\s+)(?:by|with)\b/iu.test(message)) return false;
  if (/\b(?:ai|claude|codex|chatgpt|copilot|gemini|llm)[ -]generated\b/iu.test(message)) {
    return false;
  }
  return true;
}

function taskIdForDelegationPath(
  input: unknown,
  instancePath: string,
): string | undefined {
  const match = /^\/tasks\/(\d+)\/delegation(?:\/|$)/u.exec(instancePath);
  if (match === null || !isRecord(input) || !Array.isArray(input.tasks)) return undefined;
  const task = input.tasks[Number(match[1])];
  if (!isRecord(task) || typeof task.id !== "string") return undefined;
  const idLength = [...task.id].length;
  return idLength >= 1 && idLength <= 128 ? task.id : undefined;
}

export function validateAutopilotSpec(input: unknown): ValidateAutopilotResult {
  const schemaValid = schemas.autopilotSpec(input);
  const errors: ValidationError[] = (schemas.autopilotSpec.errors ?? [])
    .filter(error => taskIdForDelegationPath(input, error.instancePath) === undefined)
    .map(error => ({
      path: error.instancePath || error.schemaPath,
      message: error.message ?? "invalid",
    }));

  const ids = new Set<string>();
  const tasks = isRecord(input) && Array.isArray(input.tasks) ? input.tasks : [];
  for (const task of tasks) {
    if (!isRecord(task) || typeof task.id !== "string") continue;
    const taskId = task.id;

    if (ids.has(taskId)) {
      errors.push({ path: "#/tasks", message: `duplicate task id: ${taskId}` });
    }
    ids.add(taskId);

    if (typeof task.commitMessage === "string" && !isSafeCommitMessage(task.commitMessage)) {
      errors.push({
        path: `#/tasks/${escapeJsonPointerSegment(taskId)}/commitMessage`,
        message: "unsafe commit message",
      });
    }

    if ("delegation" in task) {
      const delegated = validateSpec(task.delegation);
      if (!delegated.ok) {
        errors.push(...delegated.errors.map(error => prefixDelegationError(taskId, error)));
      }
    }
  }

  if (!schemaValid || errors.length > 0) return { ok: false, errors };
  return { ok: true, spec: input as AutopilotSpec };
}
