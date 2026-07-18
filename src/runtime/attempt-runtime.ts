import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { freezeCandidate } from "../git/candidate-tree.js";
import { checkPreconditions } from "../git/repo-preconditions.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type {
  CheckoutLock,
  PlatformServices,
  SupervisedExit,
} from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import { wrapInvocationWithSeatbelt } from "../platform/sandbox/seatbelt.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  AttemptResult,
  CandidateArtifact,
  CommandOutcome,
  FailureClassification,
  FailureSignals,
} from "../protocol/attempt-result.js";
import { classifyFailure } from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeAll } from "../producers/capability-probe.js";
import {
  detectEnvironmentType,
  type CapabilityReport,
  type ProducerAdapter,
  type ProducerConfigurationProfile,
  type ProducerInvocation,
} from "../producers/producer-adapter.js";
import {
  ProducerRegistry,
  registry,
} from "../producers/producer-registry.js";
import { route } from "../producers/routing-policy.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { verifyBaseline } from "../verify/baseline-verifier.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  buildEnvironment,
  registerSensitiveEnvironment,
  type BuiltEnvironment,
  type EnvProvenance,
} from "./environment-policy.js";
import { redact, redactValues } from "./redaction.js";
import {
  collectReproducibilityInputs,
  type ReproducibilityInputs,
} from "./reproducibility.js";
import {
  buildRunManifest,
  type PackagedVerifierInput,
  type RepositoryInstructionInput,
} from "./run-manifest.js";
import {
  initializeRunStart,
  parentDeathWatchdogInvocation,
  type RunStartContext,
  type RunStartRecord,
  withRunStartPidRecording,
} from "./run-start.js";

const MAX_PRODUCER_OUTPUT_BYTES = 1_000_000;

export interface AcceptanceVerificationResult {
  ok: boolean;
  failures: string[];
  evidence: Record<string, unknown>;
  commandOutcomes: CommandOutcome[];
}

export interface AcceptanceVerificationArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  spec: DelegationSpec;
  ps: PlatformServices;
  artifactStore: ArtifactStore;
}

export interface AcceptanceVerifierLike {
  verify(args: AcceptanceVerificationArgs): Promise<AcceptanceVerificationResult>;
}

export interface AttemptRuntimeDependencies {
  verifier: AcceptanceVerifierLike;
  baselineVerifier?: typeof verifyBaseline;
  ps?: PlatformServices;
  producerRegistry?: ProducerRegistry;
  runId?: () => string;
  now?: () => number;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  repositoryInstructions?: RepositoryInstructionInput[];
  packagedVerifier?: PackagedVerifierInput;
  reproducibilityCollector?: (
    repoRoot: string,
    baseCommitOid: string,
  ) => Promise<ReproducibilityInputs>;
  onRunStart?: (context: RunStartContext) => void;
  /** Host progress reporting only; never awaited and never affects the attempt. */
  onPhase?: (phase: string) => void;
}

interface TerminalContext {
  store: ArtifactStore;
  spec: DelegationSpec;
  runId: string;
  startedAtMs: number;
  now: () => number;
  repoRoot: string;
  baseCommitOid: string;
  signals: FailureSignals;
  report: CapabilityReport | null;
  profile: ProducerConfigurationProfile | null;
  invocation: ProducerInvocation | null;
  environment: EnvProvenance;
  temporaryHomeApplied: boolean;
  producerSummary: string | null;
  candidate: CandidateArtifact | null;
  commandOutcomes: CommandOutcome[];
  unresolvedIssues: string[];
  evidence: Record<string, unknown>;
  producerLog: string;
  repositoryInstructions: RepositoryInstructionInput[];
  packagedVerifier: PackagedVerifierInput;
}

function reportPhase(deps: AttemptRuntimeDependencies, phase: string): void {
  try { deps.onPhase?.(phase); } catch { /* progress reporting must never affect the attempt */ }
}

function hasEnvironmentMarker(environment: Record<string, string | undefined>): boolean {
  return environment.CLAUDE_ARCHITECT_DELEGATED !== undefined;
}

function hasFailureSignal(signals: FailureSignals): boolean {
  return Object.values(signals).some(Boolean);
}

function statusForFailure(
  failure: FailureClassification | null,
): AttemptResult["status"] {
  if (failure === null) return "verified-candidate";
  if (failure === "unavailable" || failure === "authentication-required") return "unavailable";
  if (failure === "cancelled") return "cancelled";
  return "failed";
}

function summaryForFailure(failure: FailureClassification | null): string {
  switch (failure) {
    case null: return "candidate produced and independently verified";
    case "unavailable": return "no eligible producer is available";
    case "authentication-required": return "producer authentication is required";
    case "spawn-failure": return "producer process could not be started";
    case "cancelled": return "delegation attempt was cancelled";
    case "timeout": return "producer process exceeded the attempt timeout";
    case "sandbox-violation": return "producer changes violated the authorized write boundary";
    case "invalid-output": return "producer output did not match the adapter contract";
    case "producer-failure": return "producer process reported failure";
    case "verification-failure": return "candidate did not pass independent verification";
    case "invalid-specification": return "delegation specification is invalid";
    case "environment-defect": return "clean repository baseline did not pass verification";
  }
}

function producerLog(exit: SupervisedExit | null): string {
  if (exit === null) return "No producer process was started.\n";
  return [
    "[stdout]",
    exit.stdout,
    "[stderr]",
    exit.stderr,
    "",
  ].join("\n");
}

function preCancelledExit(): SupervisedExit {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: true,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}

function shouldUseTemporaryHome(profile: ProducerConfigurationProfile): boolean {
  return profile.isolationState === "controlled-config-supported"
    || profile.isolationState === "controlled-config-with-copied-credentials";
}

async function archiveTerminal(context: TerminalContext): Promise<AttemptResult> {
  const verificationSecretRegistrations: Array<{ dispose(): void }> = [];
  try {
    for (const command of context.spec.verification) {
      verificationSecretRegistrations.push(registerSensitiveEnvironment(command.environment ?? {}));
    }

    const failure = classifyFailure(context.signals);
    const logsRef = await context.store.writeLog("producer", context.producerLog);
    const result: AttemptResult = {
      resultVersion: "1",
      runId: context.runId,
      status: statusForFailure(failure),
      failure,
      summary: summaryForFailure(failure),
      producerSummary: context.producerSummary === null ? null : redact(context.producerSummary),
      candidate: context.candidate === null
        ? null
        : {
          ...context.candidate,
          changedPaths: context.candidate.changedPaths.map(change => ({ ...change })),
          patch: redact(context.candidate.patch),
        },
      requestedVerification: redactValues(context.spec.verification),
      executedVerification: redactValues(context.commandOutcomes),
      unresolvedIssues: context.unresolvedIssues.map(redact),
      evidence: redactValues(context.evidence),
      logsRef,
      producerId: context.report?.producerId ?? null,
      producerVersion: context.report?.version ?? null,
      producerModel: context.spec.producerOverrides?.model ?? null,
      durationMs: Math.max(0, context.now() - context.startedAtMs),
      sessionId: null,
    };
    const manifest = buildRunManifest({
      runId: context.runId,
      repoRoot: context.repoRoot,
      baseCommitOid: context.baseCommitOid,
      candidateManifestHash: context.candidate?.manifestHash ?? null,
      producer: {
        id: context.report?.producerId ?? null,
        version: context.report?.version ?? null,
        model: context.spec.producerOverrides?.model ?? null,
      },
      effectivePolicy: {
        ...(context.profile === null
          ? { routingFailure: failure }
          : {
            configurationProfile: context.profile,
            temporaryHomeApplied: context.temporaryHomeApplied,
          }),
        verificationPolicy: context.evidence.verificationPolicy ?? [],
      },
      repositoryInstructions: context.repositoryInstructions,
      prompt: context.invocation?.stdin ?? `${context.spec.objective}\n${context.spec.context}`,
      executionPolicy: {
        timeoutMs: context.spec.timeoutMs,
        network: context.invocation?.network ?? "not-started",
        writeAllowlist: context.spec.writeAllowlist,
        forbiddenScope: context.spec.forbiddenScope,
      },
      environment: context.environment,
      packagedVerifier: context.packagedVerifier,
    });
    await context.store.writeManifest(manifest);
    await context.store.writeResult(result);
    return result;
  } finally {
    for (const registration of verificationSecretRegistrations) registration.dispose();
  }
}

async function cleanupAttemptResources(args: {
  builtEnvironment: BuiltEnvironment | null;
  worktree: { cleanup(): Promise<void> } | null;
  tempHome: string | null;
  lock: CheckoutLock | null;
}): Promise<unknown | null> {
  const failures: unknown[] = [];
  try {
    args.builtEnvironment?.secretRegistration.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (args.worktree !== null) {
    try {
      await args.worktree.cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (args.tempHome !== null) {
    try {
      await rm(args.tempHome, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (args.lock !== null) {
    try {
      await args.lock.release();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures[0] ?? null;
}

export async function runAttempt(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: AttemptRuntimeDependencies,
): Promise<AttemptResult> {
  if (hasEnvironmentMarker(deps.env ?? process.env)) throw new NestedDelegationError();

  const ps = deps.ps ?? getPlatformServices();
  const producerRegistry = deps.producerRegistry ?? registry;
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  const runId = (deps.runId ?? randomUUID)();
  const store = new ArtifactStore(runId);
  const canonical = await ps.canonicalizePath(checkoutPath);
  let lock: CheckoutLock | null = null;
  let worktree: { path: string; cleanup(): Promise<void> } | null = null;
  let tempHome: string | null = null;
  let builtEnvironment: BuiltEnvironment | null = null;
  let primaryError: unknown;
  try {
    lock = await ps.acquireCheckoutLock(canonical.canonical);
    const preconditions = await checkPreconditions(canonical.canonical, {
      writeAllowlist: spec.writeAllowlist,
    });
    if (!preconditions.ok) {
      const detailSuffix = preconditions.detail === undefined
        ? ""
        : `: ${preconditions.detail.join(", ")}`;
      throw new RuntimeError(
        `repository precondition failed (${preconditions.reason})${detailSuffix}`,
        { reason: preconditions.reason, detail: preconditions.detail ?? [] },
      );
    }

    const collected = deps.repositoryInstructions !== undefined
      && deps.packagedVerifier !== undefined
      ? null
      : await (deps.reproducibilityCollector ?? collectReproducibilityInputs)(
        canonical.canonical,
        preconditions.baseCommitOid,
      );
    const repositoryInstructions = deps.repositoryInstructions
      ?? collected!.repositoryInstructions;
    const packagedVerifier = deps.packagedVerifier ?? collected!.packagedVerifier;

  const executionMode = (spec as { executionMode: string }).executionMode;
  let baselineEvidence: Record<string, unknown> = { baseline: "skipped — read-only spec" };
  if (executionMode === "edit") {
    reportPhase(deps, "verifying baseline");
    let baseline;
    try {
      baseline = await (deps.baselineVerifier ?? verifyBaseline)({
        repoRoot: canonical.canonical,
        headCommitOid: preconditions.baseCommitOid,
        commands: spec.verification,
        ps,
        runId,
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      });
    } catch (error) {
      if (!deps.abortSignal?.aborted) throw error;
      return archiveTerminal({
        store, spec, runId, startedAtMs, now,
        repoRoot: canonical.canonical, baseCommitOid: preconditions.baseCommitOid,
        signals: { cancelled: true }, report: null, profile: null, invocation: null,
        environment: [], temporaryHomeApplied: false, producerSummary: null,
        candidate: null, commandOutcomes: [], unresolvedIssues: ["cancelled"],
        evidence: { baseline: "cancelled" }, producerLog: producerLog(null),
        repositoryInstructions, packagedVerifier,
      });
    }
    baselineEvidence = { baseline };
    // Cancellation that fired while the baseline ran but let it return without
    // throwing is honored by the existing pre-producer-spawn abort check, which
    // archives run-start first; no separate early return is needed here.
    const baselineFailed = baseline.commands.some(command => !command.ok);
    if (baselineFailed) {
      return archiveTerminal({
        store, spec, runId, startedAtMs, now,
        repoRoot: canonical.canonical, baseCommitOid: preconditions.baseCommitOid,
        signals: { "environment-defect": true }, report: null, profile: null, invocation: null,
        environment: [], temporaryHomeApplied: false, producerSummary: null,
        candidate: null, commandOutcomes: [], unresolvedIssues: ["baseline-verification-failed"],
        evidence: baselineEvidence, producerLog: producerLog(null),
        repositoryInstructions, packagedVerifier,
      });
    }
  }

  reportPhase(deps, "probing producers");
  const reports = await probeAll({
    ps,
    os: ps.os,
    arch: process.arch,
    environmentType: detectEnvironmentType(),
  }, producerRegistry);
  const routing = route(spec.producerPreferences, reports);
  if (routing.producerId === null) {
    const signals: FailureSignals = routing.reason === "authentication-required"
      ? { "authentication-required": true }
      : { unavailable: true };
    return archiveTerminal({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals,
      report: null,
      profile: null,
      invocation: null,
      environment: [],
      temporaryHomeApplied: false,
      producerSummary: null,
      candidate: null,
      commandOutcomes: [],
      unresolvedIssues: [
        routing.reason,
        ...routing.considered.map(candidate =>
          `producer ${candidate.producerId}: ${candidate.outcome}${candidate.detail === null ? "" : ` (${candidate.detail})`}`),
      ],
      evidence: { ...baselineEvidence, routing: routing.reason, considered: routing.considered, reports },
      producerLog: producerLog(null),
      repositoryInstructions,
      packagedVerifier,
    });
  }

  const adapter: ProducerAdapter | undefined = producerRegistry.get(routing.producerId);
  const report = reports.find(candidate => candidate.producerId === routing.producerId) ?? null;
  if (adapter === undefined || report?.resolvedExecutable === null || report === null) {
    return archiveTerminal({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals: { unavailable: true },
      report,
      profile: null,
      invocation: null,
      environment: [],
      temporaryHomeApplied: false,
      producerSummary: null,
      candidate: null,
      commandOutcomes: [],
      unresolvedIssues: ["selected-producer-contract-invalid"],
      evidence: { ...baselineEvidence, routing: "selected-producer-contract-invalid" },
      producerLog: producerLog(null),
      repositoryInstructions,
      packagedVerifier,
    });
  }

    const runStart: RunStartRecord = {
      runId,
      lockKey: lock.key,
      canonicalCommonDir: preconditions.gitCommonDir,
      pid: null,
      processToken: null,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const runStartContext = await initializeRunStart(store, runStart);
    deps.onRunStart?.(runStartContext);
    worktree = await new WorktreeManager(canonical.canonical, runId, ps).create(
      preconditions.baseCommitOid,
    );
    const profile = adapter.configurationProfile();
    if (shouldUseTemporaryHome(profile)) tempHome = await ps.createSecureTempDirectory();
    let invocation = adapter.buildInvocation(spec, {
      worktreePath: worktree.path,
      runId,
      ...(tempHome === null ? {} : { tempHome }),
      capabilityReport: report,
      executable: report.resolvedExecutable,
    });
    let confinement: string | null = null;
    if (spec.executionMode === "edit") {
      const selection = selectSandboxBackend(report);
      if (selection.backend === null) {
        return await archiveTerminal({
          store,
          spec,
          runId,
          startedAtMs,
          now,
          repoRoot: canonical.canonical,
          baseCommitOid: preconditions.baseCommitOid,
          signals: { unavailable: true },
          report,
          profile,
          invocation,
          environment: [],
          temporaryHomeApplied: tempHome !== null,
          producerSummary: null,
          candidate: null,
          commandOutcomes: [],
          unresolvedIssues: [selection.reason],
          evidence: { routing: selection.reason },
          producerLog: producerLog(null),
          repositoryInstructions,
          packagedVerifier,
        });
      }
      confinement = selection.backend.id;
      if (selection.backend.kind === "os" && selection.backend.id === "macos-seatbelt") {
        invocation = wrapInvocationWithSeatbelt(invocation, {
          worktreePath: worktree.path,
          tempHome,
          allowNetwork: invocation.network === "allowed",
        });
      }
    }
    builtEnvironment = buildEnvironment({
      os: ps.os,
      adapterAllowlist: invocation.requiredEnv,
      ...(invocation.env === undefined ? {} : { adapterValues: invocation.env }),
      ...(tempHome === null ? {} : { tempHome }),
    });
    const recordingServices = withRunStartPidRecording(ps, runStartContext);
    const watchdog = await parentDeathWatchdogInvocation(
      invocation.executable,
      invocation.args,
    );
    reportPhase(deps, "producer running");
    const exit = deps.abortSignal?.aborted === true
      ? preCancelledExit()
      : await supervise(recordingServices, {
        executable: watchdog.executable,
        args: watchdog.args,
        cwd: worktree.path,
        env: builtEnvironment.env,
        timeoutMs: spec.timeoutMs,
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
        maxOutputBytes: MAX_PRODUCER_OUTPUT_BYTES,
      }, deps.abortSignal === undefined ? {} : { onCancel: deps.abortSignal });

    const signals: FailureSignals = {};
    let producerSummary: string | null = null;
    let candidate: CandidateArtifact | null = null;
    let commandOutcomes: CommandOutcome[] = [];
    let unresolvedIssues: string[] = [];
    let evidence: Record<string, unknown> = confinement === null
      ? baselineEvidence
      : { ...baselineEvidence, confinement };
    if (exit.spawnError !== undefined) signals["spawn-failure"] = true;
    if (exit.cancelled) signals.cancelled = true;
    if (exit.timedOut) signals.timeout = true;

    if (!hasFailureSignal(signals)) {
      const normalized = adapter.normalizeEvents({ stdout: exit.stdout, stderr: exit.stderr, exit });
      producerSummary = normalized.producerSummary;
      if (!normalized.ok) signals["invalid-output"] = true;
      if (exit.exitCode !== 0) signals["producer-failure"] = true;
    }

    if (!hasFailureSignal(signals)) {
      reportPhase(deps, "freezing candidate");
      const frozen = await freezeCandidate({
        repoRoot: canonical.canonical,
        worktreePath: worktree.path,
        baseCommitOid: preconditions.baseCommitOid,
        runId,
        writeAllowlist: spec.writeAllowlist,
        forbiddenScope: spec.forbiddenScope,
      });
      if (!frozen.ok) {
        if (frozen.reason === "empty-candidate") signals["verification-failure"] = true;
        else signals["sandbox-violation"] = true;
        unresolvedIssues = [frozen.reason];
        evidence = {
          ...evidence,
          freezeReject: frozen.reason,
          ...(frozen.paths === undefined ? {} : { freezeRejectPaths: frozen.paths }),
        };
      } else {
        candidate = frozen.artifact;
        evidence = { ...evidence, ...frozen.evidence };
        try {
          reportPhase(deps, "verifying candidate");
          const verification = await deps.verifier.verify({
            repoRoot: canonical.canonical,
            worktreePath: worktree.path,
            baseCommitOid: preconditions.baseCommitOid,
            artifact: frozen.artifact,
            spec,
            ps,
            artifactStore: store,
          });
          commandOutcomes = verification.commandOutcomes;
          unresolvedIssues = verification.failures;
          evidence = { ...evidence, ...verification.evidence };
          if (!verification.ok) signals["verification-failure"] = true;
        } catch {
          signals["verification-failure"] = true;
          unresolvedIssues = ["verifier-error"];
          evidence = { ...evidence, verifierError: true };
        }
      }
    }

    if (!hasFailureSignal(signals) && candidate === null) {
      signals["verification-failure"] = true;
      unresolvedIssues.push("missing-candidate");
    }

    reportPhase(deps, "archiving result");
    return await archiveTerminal({
      store,
      spec,
      runId,
      startedAtMs,
      now,
      repoRoot: canonical.canonical,
      baseCommitOid: preconditions.baseCommitOid,
      signals,
      report,
      profile,
      invocation,
      environment: builtEnvironment.provenance,
      temporaryHomeApplied: tempHome !== null,
      producerSummary,
      candidate,
      commandOutcomes,
      unresolvedIssues,
      evidence,
      producerLog: producerLog(exit),
      repositoryInstructions,
      packagedVerifier,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupError = await cleanupAttemptResources({
      builtEnvironment,
      worktree,
      tempHome,
      lock,
    });
    if (primaryError === undefined && cleanupError !== null) throw cleanupError;
  }
}
