import { git as runGit } from "../git/git-exec.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { redact } from "../runtime/redaction.js";

export interface GitReadDependencies {
  ps?: PlatformServices;
  git?: typeof runGit;
}

export type GitReadResult =
  | { ok: true; output: string }
  | { ok: false; error: "git-read-failed"; diagnostic: string };

const READ_ONLY_GLOBAL_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "--no-pager",
] as const;
const STATUS_ARGS = [
  ...READ_ONLY_GLOBAL_ARGS,
  "status",
  "--porcelain=v1",
  "--branch",
  "--untracked-files=all",
] as const;
const DIFF_ARGS = [
  ...READ_ONLY_GLOBAL_ARGS,
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--full-index",
  "HEAD",
  "--",
] as const;
const LOG_ARGS = [
  ...READ_ONLY_GLOBAL_ARGS,
  "log",
  "-n",
  "20",
  "--no-color",
  "--format=%H%x09%aI%x09%s",
  "--",
] as const;
const CHANGED_FILES_ARGS = [
  ...READ_ONLY_GLOBAL_ARGS,
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--name-status",
  "HEAD",
  "--",
] as const;
const MAX_DIAGNOSTIC_LENGTH = 8_192;

function boundedDiagnostic(value: string): string {
  const redacted = redact(value.trim());
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}\n[truncated]`;
}

async function execute(
  checkoutPath: string,
  args: readonly string[],
  deps: GitReadDependencies,
): Promise<GitReadResult> {
  try {
    const canonical = await (deps.ps ?? getPlatformServices()).canonicalizePath(checkoutPath);
    const result = await (deps.git ?? runGit)(canonical.canonical, [...args]);
    if (result.truncated?.stdout === true || result.truncated?.stderr === true) {
      return {
        ok: false,
        error: "git-read-failed",
        diagnostic: "Git output exceeded the capture limit",
      };
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: "git-read-failed",
        diagnostic: boundedDiagnostic(result.stderr || `Git exited with code ${String(result.exitCode)}`),
      };
    }
    return { ok: true, output: redact(result.stdout) };
  } catch (error) {
    return {
      ok: false,
      error: "git-read-failed",
      diagnostic: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

export function gitStatus(
  checkoutPath: string,
  deps: GitReadDependencies = {},
): Promise<GitReadResult> {
  return execute(checkoutPath, STATUS_ARGS, deps);
}

export function gitDiff(
  checkoutPath: string,
  deps: GitReadDependencies = {},
): Promise<GitReadResult> {
  return execute(checkoutPath, DIFF_ARGS, deps);
}

export function gitLog(
  checkoutPath: string,
  deps: GitReadDependencies = {},
): Promise<GitReadResult> {
  return execute(checkoutPath, LOG_ARGS, deps);
}

export function gitChangedFiles(
  checkoutPath: string,
  deps: GitReadDependencies = {},
): Promise<GitReadResult> {
  return execute(checkoutPath, CHANGED_FILES_ARGS, deps);
}
