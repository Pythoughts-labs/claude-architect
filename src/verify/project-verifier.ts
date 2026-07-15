import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { PlatformServices, ResolvedExecutable, SupervisedExit } from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { canonicalizeForScope } from "../platform/windows-platform-services.js";
import type { CandidateArtifact, CommandOutcome } from "../protocol/attempt-result.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { registerSensitiveEnvironment } from "../runtime/environment-policy.js";
import { redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";

const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const POSIX_ESSENTIAL_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export interface ProjectVerifyArgs {
  repoRoot: string;
  artifact: CandidateArtifact;
  commands: VerificationCommand[];
  ps?: PlatformServices;
  arch?: string;
  now?: () => number;
  verificationId?: () => string;
}

export interface ProjectCommandEvidence {
  id: string;
  confinement: "none";
  networkPolicy: "unenforced";
  requestedNetwork: VerificationCommand["network"];
  skipped: boolean;
  skipReason?: "platform-os" | "platform-arch";
  resolvedFrom?: string | null;
  truncated?: { stdout: boolean; stderr: boolean };
  spawnError?: boolean;
}

export interface ProjectOutputLog {
  name: string;
  text: string;
}

export interface ProjectVerifyResult {
  commandOutcomes: CommandOutcome[];
  mutated: boolean;
  failures: string[];
  evidence: { commands: ProjectCommandEvidence[] };
  outputLogs: ProjectOutputLog[];
}

interface ExecutedCommand {
  outcome: CommandOutcome;
  evidence: ProjectCommandEvidence;
  outputLogs: ProjectOutputLog[];
  failed: boolean;
}

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = redact(result.stderr || result.stdout).trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

function defineEnvironmentValue(environment: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(environment, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function commandEnvironment(
  command: VerificationCommand,
  os: PlatformServices["os"],
): Record<string, string> {
  const environment = Object.create(null) as Record<string, string>;
  if (os !== "win32") {
    for (const name of POSIX_ESSENTIAL_ENV) {
      const value = process.env[name];
      if (value !== undefined) defineEnvironmentValue(environment, name, value);
    }
  }
  for (const [name, value] of Object.entries(command.environment ?? {})) {
    defineEnvironmentValue(environment, name, value);
  }
  defineEnvironmentValue(environment, "CLAUDE_ARCHITECT_DELEGATED", "1");
  return environment;
}

export function isWithinScope(
  root: string,
  candidate: string,
  os: PlatformServices["os"],
): boolean {
  if (os === "win32") return canonicalizeForScope(candidate, root);
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function resolveCommandCwd(
  worktreePath: string,
  commandCwd: string,
  os: PlatformServices["os"],
): Promise<string | null> {
  if (path.isAbsolute(commandCwd)) return null;
  const lexical = path.resolve(worktreePath, commandCwd);
  if (!isWithinScope(worktreePath, lexical, os)) return null;
  try {
    const [canonicalRoot, canonicalCwd] = await Promise.all([
      realpath(worktreePath),
      realpath(lexical),
    ]);
    return isWithinScope(canonicalRoot, canonicalCwd, os) ? canonicalCwd : null;
  } catch {
    return null;
  }
}

function appliesToPlatform(
  command: VerificationCommand,
  os: PlatformServices["os"],
  arch: string,
): { applies: true } | { applies: false; reason: "platform-os" | "platform-arch" } {
  if (command.platform?.os !== undefined && !command.platform.os.includes(os)) {
    return { applies: false, reason: "platform-os" };
  }
  if (command.platform?.arch !== undefined && !command.platform.arch.includes(arch)) {
    return { applies: false, reason: "platform-arch" };
  }
  return { applies: true };
}

function logName(index: number, stream: "stdout" | "stderr"): string {
  return `verification-${index}-${stream}`;
}

function logRef(name: string): string {
  return `logs/${name}.log`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_COMMAND_OUTPUT_BYTES) return { text, truncated: false };
  let end = MAX_COMMAND_OUTPUT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

async function executeCommand(args: {
  command: VerificationCommand;
  index: number;
  cwd: string;
  ps: PlatformServices;
  now: () => number;
}): Promise<ExecutedCommand> {
  const { command, index, cwd, ps, now } = args;
  const registration = registerSensitiveEnvironment(command.environment ?? {});
  const stdoutName = logName(index, "stdout");
  const stderrName = logName(index, "stderr");
  const startedAt = now();
  let executable: ResolvedExecutable | null = null;
  let exit: SupervisedExit | null = null;
  let failureText = "";
  try {
    const environment = commandEnvironment(command, ps.os);
    executable = await ps.resolveExecutable({
      name: command.executable,
      ...(path.isAbsolute(command.executable) ? { explicitPath: command.executable } : {}),
      searchPath: environment.PATH ?? "",
    });
    exit = await supervise(ps, {
      executable,
      args: command.args,
      cwd,
      env: environment,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
    }, {});
  } catch (error) {
    failureText = errorMessage(error);
  }

  try {
    const actualArgs = [...(executable?.prefixArgs ?? []), ...command.args].map(redact);
    const stdout = boundText(redact(exit?.stdout ?? ""));
    const stderr = boundText(redact(exit === null
      ? failureText
      : [exit.stderr, exit.spawnError === undefined ? "" : errorMessage(exit.spawnError)]
        .filter(Boolean)
        .join("\n")));
    const exitCode = exit?.exitCode ?? null;
    const failed = exitCode === null
      || exit?.timedOut === true
      || exit?.cancelled === true
      || exit?.spawnError !== undefined
      || !command.expectedExitCodes.includes(exitCode);
    return {
      outcome: {
        id: redact(command.id),
        executable: redact(executable?.command ?? command.executable),
        args: actualArgs,
        exitCode,
        timedOut: exit?.timedOut ?? false,
        durationMs: Math.max(0, now() - startedAt),
        stdoutRef: logRef(stdoutName),
        stderrRef: logRef(stderrName),
      },
      evidence: {
        id: redact(command.id),
        confinement: "none",
        networkPolicy: "unenforced",
        requestedNetwork: command.network,
        skipped: false,
        resolvedFrom: executable === null ? null : redact(executable.resolvedFrom),
        truncated: {
          stdout: (exit?.truncated.stdout ?? false) || stdout.truncated,
          stderr: (exit?.truncated.stderr ?? false) || stderr.truncated,
        },
        spawnError: exit?.spawnError !== undefined,
      },
      outputLogs: [
        { name: stdoutName, text: stdout.text },
        { name: stderrName, text: stderr.text },
      ],
      failed,
    };
  } finally {
    registration.dispose();
  }
}

function skippedEvidence(
  command: VerificationCommand,
  reason: "platform-os" | "platform-arch",
): ProjectCommandEvidence {
  const registration = registerSensitiveEnvironment(command.environment ?? {});
  try {
    return {
      id: redact(command.id),
      confinement: "none",
      networkPolicy: "unenforced",
      requestedNetwork: command.network,
      skipped: true,
      skipReason: reason,
    };
  } finally {
    registration.dispose();
  }
}

export async function projectVerify(args: ProjectVerifyArgs): Promise<ProjectVerifyResult> {
  const ps = args.ps ?? getPlatformServices();
  const arch = args.arch ?? process.arch;
  const now = args.now ?? Date.now;
  const verificationId = args.verificationId?.() ?? randomUUID();
  const manager = new WorktreeManager(args.repoRoot, `verify-${verificationId}`, ps);
  const materialized = await manager.create(args.artifact.candidateCommitOid);
  let primaryError: unknown;
  try {
    const materializedTree = (await checkedGit(
      materialized.path,
      ["rev-parse", "HEAD^{tree}"],
    )).trim();
    if (materializedTree !== args.artifact.candidateTreeOid) {
      return {
        commandOutcomes: [],
        mutated: false,
        failures: ["candidate-materialization-mismatch"],
        evidence: { commands: [] },
        outputLogs: [],
      };
    }

    const commandOutcomes: CommandOutcome[] = [];
    const failures: string[] = [];
    const commandEvidence: ProjectCommandEvidence[] = [];
    const outputLogs: ProjectOutputLog[] = [];
    let mutated = false;

    for (let index = 0; index < args.commands.length; index += 1) {
      const command = args.commands[index]!;
      const applicability = appliesToPlatform(command, ps.os, arch);
      if (!applicability.applies) {
        commandEvidence.push(skippedEvidence(command, applicability.reason));
        continue;
      }
      const cwd = await resolveCommandCwd(materialized.path, command.cwd, ps.os);
      if (cwd === null) {
        const registration = registerSensitiveEnvironment(command.environment ?? {});
        try {
          failures.push(`invalid-command-cwd:${redact(command.id)}`);
          commandEvidence.push({
            id: redact(command.id),
            confinement: "none",
            networkPolicy: "unenforced",
            requestedNetwork: command.network,
            skipped: false,
          });
        } finally {
          registration.dispose();
        }
        continue;
      }

      const executed = await executeCommand({ command, index, cwd, ps, now });
      commandOutcomes.push(executed.outcome);
      commandEvidence.push(executed.evidence);
      outputLogs.push(...executed.outputLogs);
      if (executed.failed) failures.push(`command-failed:${executed.outcome.id}`);

      const [status, currentHead] = await Promise.all([
        checkedGit(materialized.path, [
          "status",
          "--porcelain=v2",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ]),
        checkedGit(materialized.path, ["rev-parse", "--verify", "HEAD"]),
      ]);
      const disallowedRecords = command.allowedMutations === "ignored-paths"
        ? status.split("\0").filter(record => record.length > 0 && !record.startsWith("! "))
        : status.length > 0 ? [status] : [];
      if (disallowedRecords.length > 0 || currentHead.trim() !== args.artifact.candidateCommitOid) {
        mutated = true;
        failures.push("verification-mutated");
        break;
      }
    }

    return {
      commandOutcomes,
      mutated,
      failures,
      evidence: { commands: commandEvidence },
      outputLogs,
    };
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
        "project verification failed and its worktree could not be cleaned up",
      );
    }
  }
}
