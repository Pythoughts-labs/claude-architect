import { randomUUID } from "node:crypto";
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
      commands.push({
        id: executed.outcome.id,
        exitCode: executed.outcome.exitCode,
        ...outputRefs,
        ok: (!executed.failed || command.expectBaselineFailure === true) && !mutation.mutated,
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
