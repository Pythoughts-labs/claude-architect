import { createHash } from "node:crypto";
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
import { validateSpec } from "../protocol/spec-validator.js";
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
import type { RunManifest } from "../runtime/run-manifest.js";
import { redact } from "../runtime/redaction.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import { boundIgnoredPathEvidence, withRepoLock } from "./serialize.js";

export type RunDecision = CandidateDecision;

export type HumanDecisionRecord = Omit<
  HumanCandidateDecisionV2,
  "decisionVersion" | "authority"
>;

export interface ToolArtifactStore {
  readResult(runId: string): Promise<AttemptResult | null>;
  readManifest(runId: string): Promise<RunManifest | null>;
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

interface ReviewCandidateSnapshot {
  manifestHash: string;
  patch: string;
  changedPaths: CandidateArtifact["changedPaths"];
  evidence: AttemptResult["evidence"];
  executedVerification: AttemptResult["executedVerification"];
}

async function regenerateReviewSnapshot(
  run: ArchivedRun,
  deps: ToolDependencies,
  allowMissingAnchor = false,
): Promise<ReviewCandidateSnapshot> {
  const candidate = requireCandidate(run);
  const git = deps.git ?? runGit;
  const anchor = await git(run.repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${candidate.anchorRef}^{commit}`,
  ]);
  const tree = await git(run.repoRoot, [
    "rev-parse",
    "--verify",
    `${candidate.candidateCommitOid}^{tree}`,
  ]);
  const anchorMissing = allowMissingAnchor
    && anchor.exitCode === 1
    && anchor.stdout.trim().length === 0;
  if ((!anchorMissing && (anchor.exitCode !== 0
    || anchor.stdout.trim() !== candidate.candidateCommitOid))
    || tree.exitCode !== 0
    || tree.stdout.trim() !== candidate.candidateTreeOid) {
    throw runtimeError("candidate anchor no longer matches the archive", "candidate-anchor-mismatch");
  }
  const patch = await git(run.repoRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    candidate.baseCommitOid,
    candidate.candidateTreeOid,
    "--",
  ]);
  if (patch.exitCode !== 0 || patch.truncated?.stdout === true) {
    throw runtimeError("failed to regenerate candidate patch", "candidate-review-failed");
  }
  return boundIgnoredPathEvidence({
    manifestHash: candidate.manifestHash,
    patch: patch.stdout,
    changedPaths: candidate.changedPaths.map(change => ({ ...change })),
    evidence: structuredClone(run.result.evidence),
    executedVerification: run.result.executedVerification.map(outcome => ({
      ...outcome,
      args: [...outcome.args],
    })),
  });
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
): Promise<ReviewCandidateSnapshot | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      return regenerateReviewSnapshot(run, deps);
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
      const reviewSnapshot = await regenerateReviewSnapshot(
        run,
        deps,
        existing !== null && decision === "rejected",
      );
      const record: HumanDecisionRecord = {
        decision,
        candidateManifestHash: candidate.manifestHash,
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(reviewSnapshot))
          .digest("hex"),
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
