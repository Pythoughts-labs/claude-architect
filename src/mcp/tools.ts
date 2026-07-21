import { createHash } from "node:crypto";
import {
  AutopilotController,
  AutopilotControllerError,
  type AutopilotControllerEvent,
  type AutopilotStatusResult,
} from "../autopilot/autopilot-controller.js";
import { WorkflowBranchManager } from "../autopilot/branch-manager.js";
import { CandidatePromoter } from "../autopilot/candidate-promoter.js";
import { FinalBranchReviewer } from "../autopilot/final-branch-reviewer.js";
import { WorkflowStore } from "../autopilot/workflow-store.js";
import { git as runGit } from "../git/git-exec.js";
import { applyCandidateTree as applyTree } from "../integrate/controlled-integrator.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import {
  runPipeline as executePipeline,
  type PipelineDependencies,
  type PipelineResult,
} from "../pipeline/pipeline-runtime.js";
import { registry } from "../producers/producer-registry.js";
import type { AttemptResult, CandidateArtifact } from "../protocol/attempt-result.js";
import type {
  CandidateDecision,
  HumanCandidateDecisionV2,
} from "../protocol/candidate-decision.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { checkVersionCompat } from "../protocol/schema-loader.js";
import { validateAutopilotSpec, validateSpec } from "../protocol/spec-validator.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
} from "../protocol/versions.js";
import {
  ArtifactStore,
  type PipelineActiveMarker,
  type RunDecisionValue,
} from "../runtime/artifact-store.js";
import {
  runAttempt as executeAttempt,
  type AttemptRuntimeDependencies,
} from "../runtime/attempt-runtime.js";
import {
  createReviewSnapshot,
  reviewSnapshotHash,
  type ReviewSnapshot,
} from "../runtime/review-snapshot.js";
import type { RunManifest } from "../runtime/run-manifest.js";
import { redact } from "../runtime/redaction.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import { runAdvisorStage } from "../pipeline/advisor-stage.js";
import { GitHubCliAdapter } from "../ship/github-cli-adapter.js";
import { boundIgnoredPathEvidence, withRepoLock } from "./serialize.js";

export type RunDecision = CandidateDecision;

export type HumanDecisionRecord = Omit<
  HumanCandidateDecisionV2,
  "decisionVersion" | "authority"
>;

export interface ToolArtifactStore {
  readResult(runId: string): Promise<AttemptResult | null>;
  readManifest(runId: string): Promise<RunManifest | null>;
  writeReviewSnapshot?(snapshot: ReviewSnapshot): Promise<void>;
  readReviewSnapshot?(runId: string): Promise<ReviewSnapshot | null>;
  writeHumanDecision(record: HumanDecisionRecord): Promise<void>;
  readCandidateDecision(runId: string): Promise<RunDecision | null>;
  readPipelineActiveMarker(runId: string): Promise<PipelineActiveMarker | null>;
}

export interface ToolDependencies {
  ps?: PlatformServices;
  storeFactory?: (runId: string) => ToolArtifactStore;
  git?: typeof runGit;
  runAttempt?: typeof executeAttempt;
  runPipeline?: typeof executePipeline;
  applyCandidateTree?: typeof applyTree;
  attemptDependencies?: AttemptRuntimeDependencies;
  skillProtocolVersion?: string;
  now?: () => Date;
  /** Host progress reporting for long-running delegate calls. */
  onProgress?: (message: string) => void;
  /** Host cancellation for long-running calls. */
  abortSignal?: AbortSignal;
  /** Injectable controller seam for hermetic MCP protocol tests. */
  autopilotControllerFactory?: (context: {
    onProgress?: (message: string) => void;
    abortSignal?: AbortSignal;
  }) => Pick<AutopilotController, "start" | "status" | "resume">;
}

export interface ToolErrorResult {
  ok: false;
  error: string;
  diagnostic: string;
}

interface ArchivedRun {
  store: ToolArtifactStore;
  result: AttemptResult;
  manifest: RunManifest;
  repoRoot: string;
  lockKey: string;
}

function services(deps: ToolDependencies): PlatformServices {
  return deps.ps ?? getPlatformServices();
}

function storeFor(runId: string, deps: ToolDependencies): ToolArtifactStore {
  return (deps.storeFactory ?? (id => new ArtifactStore(id)))(runId);
}

function runtimeError(message: string, error: string): RuntimeError {
  return new RuntimeError(message, { toolError: error });
}

class LifecycleLockReleaseError extends AggregateError {
  constructor(readonly primaryError: unknown, releaseError: unknown) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    super(
      [primaryError, releaseError],
      `${primaryMessage}; checkout lock release failed`,
    );
    this.name = "LifecycleLockReleaseError";
  }
}

function errorResult(error: unknown): ToolErrorResult {
  const classified = error instanceof LifecycleLockReleaseError ? error.primaryError : error;
  const code = classified instanceof RuntimeError && typeof classified.detail?.toolError === "string"
    ? classified.detail.toolError
    : "runtime-error";
  const diagnostic = error instanceof Error ? error.message : String(error);
  return { ok: false, error: code, diagnostic: redact(diagnostic) };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw runtimeError("autopilot request was cancelled", "cancelled");
}

function createAutopilotController(deps: ToolDependencies): Pick<
  AutopilotController,
  "start" | "status" | "resume"
> {
  const context = {
    ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
  };
  if (deps.autopilotControllerFactory !== undefined) {
    return deps.autopilotControllerFactory(context);
  }

  const ps = services(deps);
  const branchManager = new WorkflowBranchManager({ platformServices: ps });
  const workflowStore = (workflowId: string) => new WorkflowStore(workflowId);
  const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
  const attemptDependencies: AttemptRuntimeDependencies = {
    ...configured,
    ps,
    verifier: configured.verifier ?? new AcceptanceVerifier(),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
  };
  const pipelineDependencies: PipelineDependencies = {
    ...attemptDependencies,
    registry,
    ...(deps.runAttempt === undefined ? {} : { runAttempt: deps.runAttempt }),
  };

  return new AutopilotController({
    workflowLock: {
      runExclusive: (workflowId, operation) => withRepoLock(`autopilot:${workflowId}`, operation),
    },
    workflowStore,
    repositoryIdentity: async checkoutPath => {
      const canonical = await ps.canonicalizePath(checkoutPath);
      return canonical.gitCommonDir ?? canonical.canonical;
    },
    branchManager,
    pipelineRunner: {
      run: (checkoutPath, spec) => (deps.runPipeline ?? executePipeline)(
        checkoutPath,
        spec,
        pipelineDependencies,
      ),
    },
    reviewSnapshotter: {
      async create({ branch, pipelineResult }) {
        const store = new ArtifactStore(pipelineResult.runId);
        const snapshot = await createReviewSnapshot({
          runId: pipelineResult.runId,
          repoRoot: branch.worktreePath,
          repositoryIdentity: branch.repositoryIdentity,
          store,
          platformServices: ps,
          git: deps.git ?? runGit,
        });
        await store.writeReviewSnapshot(snapshot);
        return snapshot;
      },
    },
    eligibilityEvaluator: {
      async evaluate({ branch, task, pipelineResult, reviewSnapshot }) {
        const result = await runAdvisorStage({
          runId: pipelineResult.runId,
          spec: task.delegation,
          worktreePath: branch.worktreePath,
          deps: pipelineDependencies,
          evaluatedAt: (deps.now ?? (() => new Date()))().toISOString(),
          pipelineResult,
          reviewSnapshot,
        });
        return result.eligibility;
      },
    },
    promoter: new CandidatePromoter({
      platformServices: ps,
      branchManager,
      workflowStore,
    }),
    finalBranchReviewer: new FinalBranchReviewer({
      platformServices: ps,
      branchManager,
      workflowStore,
    }),
    hostingAdapter: new GitHubCliAdapter(),
    ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
    emit: (event: AutopilotControllerEvent) => deps.onProgress?.(event),
  });
}

function autopilotErrorResult(error: unknown): ToolErrorResult {
  const classification = error instanceof AutopilotControllerError
    ? error.classification
    : error instanceof RuntimeError && typeof error.detail?.classification === "string"
      ? error.detail.classification
      : undefined;
  if (classification === undefined) return errorResult(error);
  const diagnostic = error instanceof Error ? error.message : String(error);
  return { ok: false, error: classification, diagnostic: redact(diagnostic) };
}

export async function handleAutopilotStart(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
): Promise<
  | { ok: true; result: AutopilotStatusResult }
  | { ok: false; error: "invalid-spec"; validationErrors: Array<{ path: string; message: string }> }
  | ToolErrorResult
> {
  const validation = validateAutopilotSpec(input);
  if (!validation.ok) {
    return { ok: false, error: "invalid-spec", validationErrors: validation.errors };
  }
  try {
    throwIfAborted(deps.abortSignal);
    const controller = createAutopilotController(deps);
    const started = await controller.start(checkoutPath, validation.spec);
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await controller.status(checkoutPath, started.workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

export async function handleAutopilotStatus(
  checkoutPath: string,
  workflowId: string,
  deps: ToolDependencies = {},
): Promise<{ ok: true; result: AutopilotStatusResult } | ToolErrorResult> {
  try {
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await createAutopilotController(deps).status(checkoutPath, workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

export async function handleAutopilotResume(
  checkoutPath: string,
  workflowId: string,
  deps: ToolDependencies = {},
): Promise<{ ok: true; result: AutopilotStatusResult } | ToolErrorResult> {
  try {
    throwIfAborted(deps.abortSignal);
    const controller = createAutopilotController(deps);
    await controller.resume(checkoutPath, workflowId);
    throwIfAborted(deps.abortSignal);
    return {
      ok: true,
      result: await controller.status(checkoutPath, workflowId),
    };
  } catch (error) {
    return autopilotErrorResult(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadArchivedRun(runId: string, deps: ToolDependencies): Promise<ArchivedRun> {
  const store = storeFor(runId, deps);
  const [result, manifest] = await Promise.all([
    store.readResult(runId),
    store.readManifest(runId),
  ]);
  if (result === null || manifest === null) {
    throw runtimeError("archived run was not found", "run-not-found");
  }
  if (result.runId !== runId || manifest.runId !== runId) {
    throw runtimeError("archived run identity does not match", "archive-inconsistent");
  }
  if (result.candidate !== null
    && (manifest.baseCommitOid !== result.candidate.baseCommitOid
      || manifest.candidateManifestHash !== result.candidate.manifestHash
      || result.candidate.manifestHash !== createHash("sha256")
        .update(JSON.stringify(result.candidate.changedPaths))
        .digest("hex"))) {
    throw runtimeError("archived candidate does not match its run manifest", "archive-inconsistent");
  }
  const canonical = await services(deps).canonicalizePath(manifest.repoRoot);
  if (canonical.canonical !== manifest.repoRoot) {
    throw runtimeError("archived repository root changed identity", "archive-inconsistent");
  }
  return {
    store,
    result,
    manifest,
    repoRoot: canonical.canonical,
    lockKey: canonical.gitCommonDir ?? canonical.canonical,
  };
}

function requireCandidate(run: ArchivedRun): CandidateArtifact {
  if (run.result.candidate === null) {
    throw runtimeError("archived run has no candidate", "candidate-not-found");
  }
  return run.result.candidate;
}

function requireVerifiedCandidate(run: ArchivedRun): CandidateArtifact {
  if (run.result.status !== "verified-candidate" || run.result.failure !== null) {
    throw runtimeError(
      "candidate did not complete independent verification",
      "candidate-not-verified",
    );
  }
  return requireCandidate(run);
}

function requireMatchingRepository(
  run: ArchivedRun,
  callerKey: string,
): void {
  if (callerKey !== run.lockKey) {
    throw runtimeError(
      "candidate run belongs to a different repository than the supplied checkoutPath",
      "run-checkout-mismatch",
    );
  }
}

async function withCurrentArchivedRun<T>(
  checkoutPath: string,
  runId: string,
  deps: ToolDependencies,
  fn: (run: ArchivedRun, lock: CheckoutLock, ps: PlatformServices) => Promise<T>,
  preserveResultOnReleaseFailure?: (result: T) => T,
): Promise<T> {
  const ps = services(deps);
  const canonical = await ps.canonicalizePath(checkoutPath);
  const callerKey = canonical.gitCommonDir ?? canonical.canonical;
  return withRepoLock(callerKey, async () => {
    const lock = await ps.acquireCheckoutLock(canonical.canonical);
    let action: { ok: true; result: T } | { ok: false; error: unknown };
    try {
      if (lock.repositoryIdentity !== callerKey) {
        throw runtimeError(
          "supplied checkout repository identity changed before checkout lease acquisition",
          "run-checkout-mismatch",
        );
      }
      const run = await loadArchivedRun(runId, deps);
      requireMatchingRepository(run, lock.repositoryIdentity);
      action = { ok: true, result: await fn(run, lock, ps) };
    } catch (error) {
      action = { ok: false, error };
    }
    try {
      await lock.release();
    } catch (releaseError) {
      if (!action.ok) throw new LifecycleLockReleaseError(action.error, releaseError);
      if (preserveResultOnReleaseFailure !== undefined) {
        return preserveResultOnReleaseFailure(action.result);
      }
      throw releaseError;
    }
    if (!action.ok) throw action.error;
    return action.result;
  });
}

async function requireInactivePipeline(run: ArchivedRun, runId: string): Promise<void> {
  if (await run.store.readPipelineActiveMarker(runId) !== null) {
    throw runtimeError(
      "the delegation pipeline for this run is still active",
      "pipeline-active",
    );
  }
}

function schemaCompatibility(input: unknown): { ok: true } | { ok: false; diagnostic: string } {
  if (isRecord(input)
    && input.specVersion !== undefined
    && input.specVersion !== DELEGATION_SPEC_VERSION) {
    return {
      ok: false,
      diagnostic: "delegation spec version mismatch: request declares "
        + `${String(input.specVersion)}, runtime expects ${DELEGATION_SPEC_VERSION}`,
    };
  }
  return { ok: true };
}

export async function handleDelegate(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
): Promise<
  | { ok: true; result: AttemptResult }
  | {
    ok: false;
    error: "invalid-specification";
    validationErrors: Array<{ path: string; message: string }>;
  }
  | { ok: false; diagnostic: string }
  | { ok: false; error: "nested-delegation-denied" }
  | ToolErrorResult
> {
  const protocol = checkVersionCompat(deps.skillProtocolVersion ?? PROTOCOL_VERSION);
  if (!protocol.ok) return { ok: false, diagnostic: protocol.diagnostic! };
  // Schemaless MCP clients (spec is z.unknown → empty JSON schema) may serialize the
  // nested spec object as a JSON string; accept that encoding before validation.
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return {
        ok: false,
        error: "invalid-specification",
        validationErrors: [{ path: "#", message: "string spec is not valid JSON" }],
      };
    }
  }
  const schema = schemaCompatibility(input);
  if (!schema.ok) return schema;
  const validation = validateSpec(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: "invalid-specification",
      validationErrors: validation.errors,
    };
  }

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
      };
      const result = await (deps.runAttempt ?? executeAttempt)(
        canonical.canonical,
        validation.spec,
        attemptDependencies,
      );
      return { ok: true, result: boundIgnoredPathEvidence(result) };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

export async function handleDelegatePipeline(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
): Promise<
  | { ok: true; result: PipelineResult }
  | {
    ok: false;
    error: "invalid-specification";
    validationErrors: Array<{ path: string; message: string }>;
  }
  | { ok: false; diagnostic: string }
  | { ok: false; error: "nested-delegation-denied" }
  | ToolErrorResult
> {
  const protocol = checkVersionCompat(deps.skillProtocolVersion ?? PROTOCOL_VERSION);
  if (!protocol.ok) return { ok: false, diagnostic: protocol.diagnostic! };
  // Schemaless MCP clients (spec is z.unknown → empty JSON schema) may serialize the
  // nested spec object as a JSON string; accept that encoding before validation.
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return {
        ok: false,
        error: "invalid-specification",
        validationErrors: [{ path: "#", message: "string spec is not valid JSON" }],
      };
    }
  }
  const schema = schemaCompatibility(input);
  if (!schema.ok) return schema;
  const validation = validateSpec(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: "invalid-specification",
      validationErrors: validation.errors,
    };
  }

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
      };
      const pipelineDependencies: PipelineDependencies = {
        ...attemptDependencies,
        registry,
        ...(deps.runAttempt === undefined ? {} : { runAttempt: deps.runAttempt }),
      };
      const pipelineResult = await (deps.runPipeline ?? executePipeline)(
        canonical.canonical,
        validation.spec,
        pipelineDependencies,
      );
      return { ok: true, result: pipelineResult };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

function requireMatchingSnapshotBytes(
  regenerated: ReviewSnapshot,
  persisted: ReviewSnapshot,
): void {
  reviewSnapshotHash(persisted);
  if (JSON.stringify(persisted) !== JSON.stringify(regenerated)) {
    throw runtimeError(
      "persisted review snapshot does not match the regenerated snapshot",
      "archive-inconsistent",
    );
  }
}

async function sharedReviewSnapshot(
  run: ArchivedRun,
  deps: ToolDependencies,
  allowMissingAnchor = false,
): Promise<ReviewSnapshot> {
  const regenerated = await createReviewSnapshot({
    runId: run.result.runId,
    repoRoot: run.repoRoot,
    repositoryIdentity: run.lockKey,
    store: run.store,
    platformServices: services(deps),
    git: deps.git ?? runGit,
    allowMissingAnchor,
  });
  const persisted = await run.store.readReviewSnapshot?.(run.result.runId) ?? null;
  if (persisted !== null) {
    requireMatchingSnapshotBytes(regenerated, persisted);
    return persisted;
  }

  await run.store.writeReviewSnapshot?.(regenerated);
  const newlyPersisted = await run.store.readReviewSnapshot?.(run.result.runId) ?? null;
  if (newlyPersisted !== null) {
    requireMatchingSnapshotBytes(regenerated, newlyPersisted);
    return newlyPersisted;
  }
  return regenerated;
}

function isIdenticalHumanDecision(
  existing: CandidateDecision,
  attempted: HumanDecisionRecord,
): boolean {
  return existing.decisionVersion === "2"
    && existing.authority === "human"
    && existing.decision === attempted.decision
    && existing.candidateManifestHash === attempted.candidateManifestHash
    && existing.evidenceHash === attempted.evidenceHash
    && existing.policyVersion === attempted.policyVersion;
}

async function deleteRejectedCandidateAnchor(
  run: ArchivedRun,
  candidate: CandidateArtifact,
  deps: ToolDependencies,
  allowAlreadyAbsent = false,
): Promise<void> {
  const git = deps.git ?? runGit;
  if (allowAlreadyAbsent) {
    const current = await git(run.repoRoot, [
      "show-ref",
      "--verify",
      "--hash",
      candidate.anchorRef,
    ]);
    if (current.exitCode === 1 && current.stdout.trim().length === 0) return;
    if (current.exitCode !== 0 || current.stdout.trim() !== candidate.candidateCommitOid) {
      throw runtimeError("rejected candidate anchor changed identity", "anchor-delete-failed");
    }
  }
  const deleted = await git(run.repoRoot, [
    "update-ref",
    "--no-deref",
    "-d",
    candidate.anchorRef,
    candidate.candidateCommitOid,
  ]);
  if (deleted.exitCode !== 0) {
    throw runtimeError("failed to delete rejected candidate anchor", "anchor-delete-failed");
  }
}

export async function handleReviewCandidate(
  checkoutPath: string,
  runId: string,
  deps: ToolDependencies = {},
): Promise<ReviewSnapshot | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      return sharedReviewSnapshot(run, deps);
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDecideCandidate(
  checkoutPath: string,
  runId: string,
  decision: RunDecisionValue,
  expectedArtifactHash: string,
  deps: ToolDependencies = {},
): Promise<{ recorded: true } | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      const candidate = decision === "accepted"
        ? requireVerifiedCandidate(run)
        : requireCandidate(run);
      if (expectedArtifactHash !== run.manifest.candidateManifestHash) {
        throw runtimeError(
          "expected artifact hash does not match archived candidate manifest hash",
          "artifact-hash-mismatch",
        );
      }
      const existing = await run.store.readCandidateDecision(runId);
      if (existing !== null) {
        if (existing.decisionVersion !== "2"
          || existing.authority !== "human"
          || existing.decision !== decision
          || existing.candidateManifestHash !== candidate.manifestHash
          || existing.policyVersion !== "1") {
          throw runtimeError(
            `candidate decision conflict: recorded ${existing.decision}, attempted ${decision}`,
            "decision-conflict",
          );
        }
      }
      const reviewSnapshot = await sharedReviewSnapshot(
        run,
        deps,
        existing !== null && decision === "rejected",
      );
      const record: HumanDecisionRecord = {
        decision,
        candidateManifestHash: candidate.manifestHash,
        evidenceHash: reviewSnapshotHash(reviewSnapshot),
        policyVersion: "1",
        recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
      };
      if (existing !== null) {
        if (!isIdenticalHumanDecision(existing, record)) {
          throw runtimeError(
            `candidate decision conflict: recorded ${existing.decision}, attempted ${decision}`,
            "decision-conflict",
          );
        }
        if (decision === "rejected") {
          await deleteRejectedCandidateAnchor(run, candidate, deps, true);
        }
        return { recorded: true };
      }
      await run.store.writeHumanDecision(record);
      if (decision === "rejected") {
        await deleteRejectedCandidateAnchor(run, candidate, deps);
      }
      return { recorded: true };
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleIntegrateCandidate(
  checkoutPath: string,
  runId: string,
  expectedArtifactHash: string,
  deps: ToolDependencies = {},
): Promise<{ integration: "applied" | "conflicted" | "aborted"; detail: string } | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async (run, lock, ps) => {
      await requireInactivePipeline(run, runId);
      const decision = await run.store.readCandidateDecision(runId);
      if (decision?.decision !== "accepted") {
        return { integration: "aborted", detail: "no-accepted-decision" };
      }
      return (deps.applyCandidateTree ?? applyTree)({
        repoRoot: run.repoRoot,
        artifact: requireVerifiedCandidate(run),
        expectedArtifactHash,
        borrowedCheckoutLock: lock,
        platformServices: ps,
      });
    }, result => ({
      ...result,
      detail: `${result.detail}; checkout lock release failed`,
    }));
  } catch (error) {
    return errorResult(error);
  }
}
