import type { PlatformServices } from "../platform/platform-services.js";
import type { CandidateArtifact, CommandOutcome } from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { ArtifactStore } from "../runtime/artifact-store.js";
import { RuntimeError } from "../util/errors.js";
import {
  projectVerify,
  type ProjectVerifyArgs,
  type ProjectCommandEvidence,
  type ProjectVerifyResult,
} from "./project-verifier.js";
import {
  structuralVerify,
  type StructuralVerifyArgs,
  type StructuralVerifyResult,
} from "./structural-verifier.js";

export interface AcceptanceVerifyArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  spec: DelegationSpec;
  ps: PlatformServices;
  artifactStore: Pick<ArtifactStore, "writeLog">;
}

export interface AcceptanceVerifyResult {
  ok: boolean;
  failures: string[];
  evidence: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
}

export interface AcceptanceVerifierDependencies {
  structural?: (args: StructuralVerifyArgs) => Promise<StructuralVerifyResult>;
  project?: (args: ProjectVerifyArgs) => Promise<ProjectVerifyResult>;
}

function expectedLogRefs(project: ProjectVerifyResult): Set<string> {
  const refs = project.commandOutcomes.flatMap(outcome => [outcome.stdoutRef, outcome.stderrRef]);
  const unique = new Set(refs);
  if (unique.size !== refs.length) {
    throw new RuntimeError("project verification returned duplicate command log references");
  }
  return unique;
}

async function archiveProjectLogs(
  project: ProjectVerifyResult,
  store: Pick<ArtifactStore, "writeLog">,
): Promise<void> {
  const expected = expectedLogRefs(project);
  const predicted = project.outputLogs.map(log => `logs/${log.name}.log`);
  if (new Set(predicted).size !== predicted.length
    || predicted.length !== expected.size
    || predicted.some(ref => !expected.has(ref))) {
    throw new RuntimeError("project verification log references do not match command outcomes");
  }

  for (let index = 0; index < project.outputLogs.length; index += 1) {
    const log = project.outputLogs[index]!;
    const archivedRef = await store.writeLog(log.name, log.text);
    if (archivedRef !== predicted[index]) {
      throw new RuntimeError("artifact store returned an unexpected verification log reference");
    }
  }
}

function cloneCommandEvidence(command: ProjectCommandEvidence): ProjectCommandEvidence {
  return {
    ...command,
    ...(command.truncated === undefined ? {} : { truncated: { ...command.truncated } }),
  };
}

function outcomesMatchHostCommands(
  commands: DelegationSpec["verification"],
  outcomes: CommandOutcome[],
  evidence: ProjectVerifyResult["evidence"]["commands"],
  os: PlatformServices["os"],
  arch: string,
): boolean {
  const byId = new Map(commands.map(command => [command.id, command]));
  if (byId.size !== commands.length) return false;
  const byOutcomeId = new Map(outcomes.map(outcome => [outcome.id, outcome]));
  const byEvidenceId = new Map(evidence.map(command => [command.id, command]));
  if (byOutcomeId.size !== outcomes.length
    || byEvidenceId.size !== evidence.length
    || evidence.length !== commands.length
    || outcomes.some(outcome => !byId.has(outcome.id))
    || evidence.some(command => !byId.has(command.id))) return false;

  return commands.every(command => {
    const commandEvidence = byEvidenceId.get(command.id);
    if (commandEvidence === undefined) return false;
    const skipReason = command.platform?.os !== undefined && !command.platform.os.includes(os)
      ? "platform-os"
      : command.platform?.arch !== undefined && !command.platform.arch.includes(arch)
        ? "platform-arch"
        : null;
    const outcome = byOutcomeId.get(command.id);
    if (skipReason !== null) {
      return commandEvidence.skipped
        && commandEvidence.skipReason === skipReason
        && outcome === undefined;
    }
    return !commandEvidence.skipped
      && outcome !== undefined
      && outcome.exitCode !== null
      && !outcome.timedOut
      && command.expectedExitCodes.includes(outcome.exitCode);
  });
}

export class AcceptanceVerifier {
  private readonly structural: (args: StructuralVerifyArgs) => Promise<StructuralVerifyResult>;
  private readonly project: (args: ProjectVerifyArgs) => Promise<ProjectVerifyResult>;

  constructor(dependencies: AcceptanceVerifierDependencies = {}) {
    this.structural = dependencies.structural ?? structuralVerify;
    this.project = dependencies.project ?? projectVerify;
  }

  async verify(args: AcceptanceVerifyArgs): Promise<AcceptanceVerifyResult> {
    const structural = await this.structural({
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      baseCommitOid: args.baseCommitOid,
      artifact: args.artifact,
      writeAllowlist: args.spec.writeAllowlist,
      forbiddenScope: args.spec.forbiddenScope,
    });
    const structuralEvidence = {
      manifestHash: structural.manifestHash,
      failures: [...structural.failures],
    };
    if (!structural.ok) {
      return {
        ok: false,
        failures: [...structural.failures],
        evidence: { structural: structuralEvidence },
        commandOutcomes: [],
      };
    }

    const project = await this.project({
      repoRoot: args.repoRoot,
      artifact: args.artifact,
      commands: args.spec.verification,
      ps: args.ps,
    });
    await archiveProjectLogs(project, args.artifactStore);

    const failures = [...project.failures];
    if (project.mutated && !failures.includes("verification-mutated")) {
      failures.push("verification-mutated");
    }
    if (project.commandOutcomes.length === 0 && failures.length === 0) {
      failures.push("empty-verification");
    }
    if (!outcomesMatchHostCommands(
      args.spec.verification,
      project.commandOutcomes,
      project.evidence.commands,
      args.ps.os,
      process.arch,
    )
      && !failures.includes("command-outcome-mismatch")) {
      failures.push("command-outcome-mismatch");
    }
    const verificationPolicy = project.evidence.commands.map(cloneCommandEvidence);

    return {
      ok: failures.length === 0,
      failures,
      evidence: {
        structural: structuralEvidence,
        project: {
          mutated: project.mutated,
          failures: [...project.failures],
          commands: verificationPolicy.map(cloneCommandEvidence),
        },
        verificationPolicy,
      },
      commandOutcomes: project.commandOutcomes.map(outcome => ({
        ...outcome,
        args: [...outcome.args],
      })),
    };
  }
}
