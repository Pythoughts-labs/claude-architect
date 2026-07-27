import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import path from "node:path";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { appliesToPlatform, executeCommand, resolveCommandCwd, scanCommandMutations } from "./project-verifier.js";
import { linkPrimaryDependencies, type DependencyLink } from "./dependency-link.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";

export interface BaselineCommandResult {
  id: string;
  exitCode: number | null;
  ok: boolean;
  /** Archived output, so a baseline failure can be diagnosed without a rerun. */
  stdoutRef?: string;
  stderrRef?: string;
  classification?: "no-tests-collected";
  mutation?: { records: string[]; headChanged: boolean };
}

export interface BaselineReport {
  baselineCommitOid: string;
  commands: BaselineCommandResult[];
  dependencyLink: DependencyLink;
}

export interface BaselineVerifyArgs {
  repoRoot: string;
  headCommitOid: string;
  commands: VerificationCommand[];
  ps?: PlatformServices;
  arch?: string;
  now?: () => number;
  runId?: string;
  verificationId?: () => string;
  abortSignal?: AbortSignal;
  /** When present, each command's output is archived for post-hoc diagnosis. */
  store?: Pick<ArtifactStore, "writeLog">;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("Baseline verification was cancelled", "AbortError");
}

function executableName(value: string): string {
  return basename(value).toLowerCase().replace(/\.(?:cmd|exe|mjs|cjs|js)$/u, "");
}

function firstPositionalArgument(args: string[]): string | undefined {
  const optionsWithValues = new Set([
    "--call", "--conditions", "--eval", "--import", "--loader", "--package", "--registry",
    "--require", "-c", "-e", "-p", "-r",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--") return args[index + 1];
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) return argument;
  }
  return undefined;
}

function nodeEntrypointInvokesVitest(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.replace(/\\/gu, "/");
  return /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?vitest\/vitest\.(?:cjs|js|mjs)$/iu
    .test(normalized);
}

function packageManagerScriptName(tokens: string[], executableIndex: number): string | undefined {
  const args = tokens.slice(executableIndex + 1);
  const invocation = firstPositionalArgument(args);
  if (invocation === undefined || ["exec", "dlx"].includes(invocation)) return undefined;
  return ["run", "run-script"].includes(invocation)
    ? firstPositionalArgument(args.slice(args.indexOf(invocation) + 1))
    : invocation;
}

function shellCommandInvokesVitest(
  command: string,
  scripts: Record<string, unknown>,
  visitedScripts: Set<string>,
): boolean {
  return command.split(/(?:&&|\|\||[;|])/u).some(segment => {
    const tokens = segment.trim().split(/\s+/u).map(token => token.replace(/^["']|["']$/gu, ""));
    let index = 0;
    if (tokens[index] === "env" || tokens[index] === "cross-env") index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
    const executable = executableName(tokens[index] ?? "");
    if (executable === "vitest") return true;
    if (executable === "node" || executable === "bun") {
      return nodeEntrypointInvokesVitest(firstPositionalArgument(tokens.slice(index + 1)));
    }
    if (executable === "npx" || executable === "bunx") {
      return executableName(firstPositionalArgument(tokens.slice(index + 1)) ?? "") === "vitest";
    }
    if (["npm", "pnpm", "yarn"].includes(executable)) {
      const args = tokens.slice(index + 1);
      const invocation = firstPositionalArgument(args);
      if (["exec", "dlx"].includes(invocation ?? "")) {
        const invocationIndex = args.indexOf(invocation!);
        return executableName(firstPositionalArgument(args.slice(invocationIndex + 1)) ?? "")
          === "vitest";
      }
      const scriptName = packageManagerScriptName(tokens, index);
      if (scriptName === undefined || visitedScripts.has(scriptName)) return false;
      const script = scripts[scriptName];
      if (typeof script !== "string") return executable === "yarn" && scriptName === "vitest";
      const nextVisited = new Set(visitedScripts).add(scriptName);
      return shellCommandInvokesVitest(script, scripts, nextVisited);
    }
    return false;
  });
}

async function packageScriptInvokesVitest(cwd: string, scriptName: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || !("scripts" in parsed)) return false;
    const scripts = parsed.scripts;
    if (scripts === null || typeof scripts !== "object") return false;
    const script = (scripts as Record<string, unknown>)[scriptName];
    return typeof script === "string"
      && shellCommandInvokesVitest(
        script,
        scripts as Record<string, unknown>,
        new Set([scriptName]),
      );
  } catch {
    return false;
  }
}

async function isVitestCommand(command: VerificationCommand, cwd: string): Promise<boolean> {
  if (executableName(command.executable) === "vitest") return true;

  const launcher = executableName(command.executable);
  if (launcher === "node" || launcher === "bun") {
    return nodeEntrypointInvokesVitest(firstPositionalArgument(command.args));
  }
  if (launcher === "npx" || launcher === "bunx") {
    return executableName(firstPositionalArgument(command.args) ?? "") === "vitest";
  }
  if (launcher === "npm" || launcher === "pnpm" || launcher === "yarn") {
    const invocation = firstPositionalArgument(command.args);
    if (invocation === undefined) return false;
    if (["exec", "dlx"].includes(invocation)) {
      const invocationIndex = command.args.indexOf(invocation);
      return executableName(firstPositionalArgument(command.args.slice(invocationIndex + 1)) ?? "") === "vitest";
    }
    const scriptName = ["run", "run-script"].includes(invocation)
      ? firstPositionalArgument(command.args.slice(command.args.indexOf(invocation) + 1))
      : invocation;
    return scriptName !== undefined && packageScriptInvokesVitest(cwd, scriptName);
  }
  return false;
}

async function reportsNoTestFiles(
  command: VerificationCommand,
  cwd: string,
  executed: Awaited<ReturnType<typeof executeCommand>>,
): Promise<boolean> {
  if (!await isVitestCommand(command, cwd)) return false;
  const outputs = executed.outputLogs.map(log =>
    log.text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""));
  const candidates = [...outputs, outputs.join("")];
  const suiteCounts = candidates.flatMap(output => {
    try {
      const report: unknown = JSON.parse(output);
      return report !== null
        && typeof report === "object"
        && "numTotalTestSuites" in report
        && typeof report.numTotalTestSuites === "number"
        ? [report.numTotalTestSuites]
        : [];
    } catch {
      return [];
    }
  });
  if (suiteCounts.some(count => count > 0)) return false;
  if (suiteCounts.some(count => count === 0)) return true;

  const aggregate = outputs.join("");
  if (/\bTest Files\s+\d+\s+(?:passed|failed|skipped|todo)\b/iu.test(aggregate)) {
    return false;
  }
  return /\bNo test files found\b/iu.test(aggregate)
    || /\bTest Files\s+no tests\b/iu.test(aggregate);
}

export async function verifyBaseline(args: BaselineVerifyArgs): Promise<BaselineReport> {
  throwIfAborted(args.abortSignal);
  const ps = args.ps ?? getPlatformServices();
  const arch = args.arch ?? process.arch;
  const now = args.now ?? Date.now;
  const manager = new WorktreeManager(
    args.repoRoot,
    // A runId gives recovery a deterministic, reclaimable name; without one
    // (only unit callers), fall back to a unique id so repeated same-commit
    // fixtures cannot collide on a shared worktrees root.
    `baseline-${args.runId ?? args.verificationId?.() ?? randomUUID()}`,
    ps,
  );
  const materialized = await manager.create(args.headCommitOid);
  let primaryError: unknown;
  try {
    const dependencyLink = await linkPrimaryDependencies(args.repoRoot, materialized.path);
    const commands: BaselineCommandResult[] = [];
    for (let index = 0; index < args.commands.length; index += 1) {
      throwIfAborted(args.abortSignal);
      const command = args.commands[index]!;
      if (!appliesToPlatform(command, ps.os, arch).applies) {
        commands.push({ id: command.id, exitCode: null, ok: true });
        continue;
      }
      const cwd = await resolveCommandCwd(materialized.path, command.cwd, ps.os);
      if (cwd === null) {
        commands.push({ id: command.id, exitCode: null, ok: false });
        continue;
      }
      const executed = await executeCommand({
        command,
        index,
        cwd,
        ps,
        now,
        logNamePrefix: "baseline-verification",
        ...(args.abortSignal === undefined ? {} : { abortSignal: args.abortSignal }),
      });
      // A baseline failure with no retained output is undiagnosable without
      // rerunning the whole attempt, which is how a mistyped guard command cost
      // a full run. Archive first, then judge.
      const outputRefs: { stdoutRef?: string; stderrRef?: string } = {};
      if (args.store !== undefined) {
        for (const log of executed.outputLogs) {
          const ref = await args.store.writeLog(log.name, log.text);
          if (log.name.endsWith("stdout")) outputRefs.stdoutRef = ref;
          if (log.name.endsWith("stderr")) outputRefs.stderrRef = ref;
        }
      }
      throwIfAborted(args.abortSignal);
      const mutation = await scanCommandMutations({
        worktreePath: materialized.path,
        expectedHeadCommitOid: args.headCommitOid,
        dependencyLink,
        ...(command.allowedMutations === undefined
          ? {}
          : { allowedMutations: command.allowedMutations }),
      });
      const noTestsCollected = await reportsNoTestFiles(command, cwd, executed);
      commands.push({
        id: executed.outcome.id,
        exitCode: executed.outcome.exitCode,
        ...outputRefs,
        // `expectBaselineFailure` declares that this command runs at clean HEAD
        // and reports failure. Both halves are load-bearing. A command that
        // never delivered a verdict — unresolvable executable, timeout,
        // cancellation, death by signal — proves nothing about the baseline,
        // and excusing those voided the environment-defect gate for every
        // command carrying the flag. A command that *passes* contradicts the
        // declaration outright: the spec claims it cannot pass by design, so a
        // green run means the command does not prove what the spec says it
        // proves, and the fail-before/pass-after evidence is void either way.
        // When the spec names the codes that constitute the intended failure,
        // demand one of them. Otherwise any completed non-zero exit satisfies the
        // flag, so a missing test file proves the same thing as a test that ran
        // and asserted false — which is not a RED proof at all.
        ok: (command.expectBaselineFailure === true
          ? executed.failed
            && executed.terminal === "exited"
            && (command.baselineFailureExitCodes === undefined
              || (executed.outcome.exitCode !== null
                && command.baselineFailureExitCodes.includes(executed.outcome.exitCode)))
          : !executed.failed)
          && !mutation.mutated
          // A run that collected no tests is the case the comment above names:
          // it cannot distinguish "the assertion failed" from "nothing ran", so
          // it is not a RED proof, and it is not a GREEN one either.
          && !noTestsCollected,
        ...(noTestsCollected ? { classification: "no-tests-collected" as const } : {}),
        ...(mutation.mutated
          ? { mutation: { records: mutation.records, headChanged: mutation.headChanged } }
          : {}),
      });
      throwIfAborted(args.abortSignal);
    }
    return { baselineCommitOid: args.headCommitOid, commands, dependencyLink };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await materialized.cleanup();
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "baseline verification failed and its worktree could not be cleaned up",
      );
    }
  }
}
