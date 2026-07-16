import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { freezeCandidate } from "../git/candidate-tree.js";
import { checkPreconditions } from "../git/repo-preconditions.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type {
  CheckoutLock,
  PlatformServices,
  SpawnRequest,
  SupervisedExit,
  SupervisedProcess,
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
import { ArtifactStore } from "./artifact-store.js";
import {
  buildEnvironment,
  registerSensitiveEnvironment,
  type BuiltEnvironment,
  type EnvProvenance,
} from "./environment-policy.js";
import { redact, redactValues } from "./redaction.js";
import {
  buildRunManifest,
  type PackagedVerifierInput,
  type RepositoryInstructionInput,
} from "./run-manifest.js";

const MAX_PRODUCER_OUTPUT_BYTES = 1_000_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

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
  ps?: PlatformServices;
  producerRegistry?: ProducerRegistry;
  runId?: () => string;
  now?: () => number;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  repositoryInstructions?: RepositoryInstructionInput[];
  packagedVerifier?: PackagedVerifierInput;
  /** Host progress reporting only; never awaited and never affects the attempt. */
  onPhase?: (phase: string) => void;
}

interface RunStartRecord {
  runId: string;
  lockKey: string;
  canonicalCommonDir: string;
  pid: number | null;
  processToken: string | null;
  startedAt: string;
}

interface RunStartTarget {
  publicDirectory: string;
  canonicalDirectory: string;
  identity: { dev: number; ino: number };
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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertDirectoryIdentity(target: RunStartTarget): Promise<void> {
  return Promise.all([
    lstat(target.publicDirectory),
    realpath(target.publicDirectory),
  ]).then(([metadata, canonical]) => {
    if (!metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.dev !== target.identity.dev
      || metadata.ino !== target.identity.ino
      || canonical !== target.canonicalDirectory) {
      throw new RuntimeError("run archive directory identity changed");
    }
  });
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "");
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeRunStart(
  target: RunStartTarget,
  record: RunStartRecord,
  create: boolean,
): Promise<void> {
  await assertDirectoryIdentity(target);
  const destination = path.join(target.canonicalDirectory, "run-start.json");
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (create) {
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(target.canonicalDirectory);
    await assertDirectoryIdentity(target);
    return;
  }

  const temporaryPath = path.join(
    target.canonicalDirectory,
    `.run-start.${randomUUID()}.tmp`,
  );
  let created = false;
  let handle;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryIdentity(target);
    await rename(temporaryPath, destination);
    created = false;
    await syncDirectory(target.canonicalDirectory);
    await assertDirectoryIdentity(target);
  } finally {
    await handle?.close();
    if (created) await rm(temporaryPath, { force: true });
  }
}

async function initializeRunStart(
  store: ArtifactStore,
  record: RunStartRecord,
): Promise<RunStartTarget> {
  await store.writeLog("lifecycle", "attempt lock acquired\n");
  const canonicalDirectory = await realpath(store.runDirectory);
  const metadata = await lstat(store.runDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RuntimeError("run archive directory is not a plain directory");
  }
  const target: RunStartTarget = {
    publicDirectory: store.runDirectory,
    canonicalDirectory,
    identity: { dev: metadata.dev, ino: metadata.ino },
  };
  await writeRunStart(target, record, true);
  return target;
}

function withRunStartPidRecording(
  ps: PlatformServices,
  target: RunStartTarget,
  record: RunStartRecord,
): PlatformServices {
  return {
    os: ps.os,
    resolveExecutable: request => ps.resolveExecutable(request),
    async spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess> {
      const process = await ps.spawnSupervised(request);
      if (process.pid > 1) {
        try {
          const processToken = await ps.getProcessStartToken(process.pid).catch(() => null);
          await writeRunStart(target, { ...record, pid: process.pid, processToken }, false);
        } catch (error) {
          await ps.terminateProcessTree(process).catch(() => {});
          throw error;
        }
      }
      return process;
    },
    requestCooperativeCancellation: process => ps.requestCooperativeCancellation(process),
    terminateProcessTree: process => ps.terminateProcessTree(process),
    getProcessStartToken: pid => ps.getProcessStartToken(pid),
    terminateProcessTreeByPid: (pid, expectedToken) =>
      ps.terminateProcessTreeByPid(pid, expectedToken),
    acquireCheckoutLock: checkout => ps.acquireCheckoutLock(checkout),
    createSecureTempDirectory: () => ps.createSecureTempDirectory(),
    canonicalizePath: input => ps.canonicalizePath(input),
  };
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
  const repositoryInstructions = deps.repositoryInstructions ?? [];
  const packagedVerifier = deps.packagedVerifier ?? { version: "pending", content: "" };
  const canonical = await ps.canonicalizePath(checkoutPath);
  const preconditions = await checkPreconditions(canonical.canonical, {
    writeAllowlist: spec.writeAllowlist,
  });
  if (!preconditions.ok) {
    throw new RuntimeError("repository precondition failed", {
      reason: preconditions.reason,
    });
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
      unresolvedIssues: [routing.reason],
      evidence: { routing: routing.reason, reports },
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
      evidence: { routing: "selected-producer-contract-invalid" },
      producerLog: producerLog(null),
      repositoryInstructions,
      packagedVerifier,
    });
  }

  let lock: CheckoutLock | null = null;
  let worktree: { path: string; cleanup(): Promise<void> } | null = null;
  let tempHome: string | null = null;
  let builtEnvironment: BuiltEnvironment | null = null;
  let primaryError: unknown;
  try {
    lock = await ps.acquireCheckoutLock(canonical.canonical);
    const runStart: RunStartRecord = {
      runId,
      lockKey: lock.key,
      canonicalCommonDir: preconditions.gitCommonDir,
      pid: null,
      processToken: null,
      startedAt: new Date(startedAtMs).toISOString(),
    };
    const runStartTarget = await initializeRunStart(store, runStart);
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
    const recordingServices = withRunStartPidRecording(ps, runStartTarget, runStart);
    reportPhase(deps, "producer running");
    const exit = deps.abortSignal?.aborted === true
      ? preCancelledExit()
      : await supervise(recordingServices, {
        executable: invocation.executable,
        args: invocation.args,
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
    let evidence: Record<string, unknown> = confinement === null ? {} : { confinement };
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
