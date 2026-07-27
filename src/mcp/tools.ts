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
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { checkVersionCompat } from "../protocol/schema-loader.js";
import { validateSpec } from "../protocol/spec-validator.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
} from "../protocol/versions.js";
import {
  ArtifactStore,
  type DecisionProvenance,
  type PipelineActiveMarker,
  type RunDecisionRecord,
  type RunDecisionValue,
} from "../runtime/artifact-store.js";
import {
  runAttempt as executeAttempt,
  type AttemptRuntimeDependencies,
} from "../runtime/attempt-runtime.js";
import type { RunManifest } from "../runtime/run-manifest.js";
import { redact } from "../runtime/redaction.js";
import { NestedDelegationError, RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import {
  allowlistSufficiencyDiagnostic,
  checkAllowlistSufficiency,
} from "./allowlist-sufficiency.js";
import { checkLiveBundle, liveBundleDiagnostic } from "./live-bundle.js";
import { boundIgnoredPathEvidence, withRepoLock } from "./serialize.js";

export type RunDecision = RunDecisionRecord;

export interface ToolArtifactStore {
  readResult(runId: string): Promise<AttemptResult | null>;
  readManifest(runId: string): Promise<RunManifest | null>;
  writeDecision(record: RunDecision): Promise<void>;
  readDecision(runId: string): Promise<RunDecision | null>;
  readPipelineActiveMarker(runId: string): Promise<PipelineActiveMarker | null>;
  /**
   * The spec hash recorded when the run started. Required, not optional: a store
   * that cannot answer must say so explicitly, because a caller asking to verify
   * a run id against a spec must never be told "verified" by omission.
   */
  readRunStartSpecSha256(runId: string): Promise<string | null>;
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
  /**
   * Cancellation from the caller. Every layer below already honors an
   * AbortSignal; without this the MCP boundary supplied none, so a cancelled
   * request left the Producer tree running and the pipeline advancing.
   */
  abortSignal?: AbortSignal;
  checkLiveBundle?: typeof checkLiveBundle;
  checkAllowlistSufficiency?: typeof checkAllowlistSufficiency;
  /**
   * How a decision reaching `decideCandidate` was obtained. The MCP server sets
   * this to `human-elicitation` only when it prompted a person itself; anything
   * else is recorded as caller-asserted so the trust gap stays visible.
   */
  decisionProvenance?: DecisionProvenance;
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

/**
 * Delegating against this repository runs the published server bundle, not the
 * checkout under edit, so a committed fix can look like it did nothing. Advisory
 * only — a staleness probe must never fail a delegation.
 */
async function warnOnStaleLiveBundle(
  checkoutPath: string,
  deps: ToolDependencies,
): Promise<void> {
  try {
    const diagnostic = liveBundleDiagnostic(
      await (deps.checkLiveBundle ?? checkLiveBundle)(checkoutPath),
    );
    if (diagnostic === null) return;
    logger.warn(diagnostic);
    deps.onProgress?.(diagnostic);
  } catch {
    // An unreadable manifest or bundle is not a delegation failure.
  }
}

/**
 * Spec-authoring feedback, not a gate: name the tracked files that consume the
 * write allowlist but sit outside it, so a contract change does not surface as
 * hand-fixing at integration time.
 */
async function warnOnAllowlistConsumers(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: ToolDependencies,
): Promise<void> {
  try {
    const diagnostic = allowlistSufficiencyDiagnostic(
      await (deps.checkAllowlistSufficiency ?? checkAllowlistSufficiency)(checkoutPath, spec),
    );
    if (diagnostic === null) return;
    logger.warn(diagnostic);
    deps.onProgress?.(diagnostic);
  } catch {
    // Advisory analysis must never fail a delegation.
  }
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
    const lock = await ps.acquireCheckoutLock(canonical.canonical, { runId });
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

/**
 * Reject producer ids that name no shipped adapter.
 *
 * The schema types `producerPreferences` as plain strings, so an agent name such
 * as `codex-implementer` used to validate cleanly and only fail at routing time
 * as `unavailable / no-eligible-producer` — a diagnostic that reads as "Codex is
 * not installed" rather than "that is not a producer id". It also bypassed the
 * documented spec-repair loop, which exists precisely so a malformed spec is
 * corrected without ever touching a Producer. The registry is the single source
 * of truth for the id set; do not restate it as a literal here.
 */
function unknownProducerErrors(
  preferences: readonly string[],
): Array<{ path: string; message: string }> {
  const known = registry.all().map(adapter => adapter.producerId);
  return preferences.flatMap((producerId, index) =>
    known.includes(producerId)
      ? []
      : [{
        path: `#/producerPreferences/${index}`,
        message: `unknown producer id ${JSON.stringify(producerId)}; expected one of ${
          known.map(id => JSON.stringify(id)).join(", ")}`,
      }]);
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


/**
 * The bounded envelope a delegation lane actually reports.
 *
 * A lane is a courier: its contract is correlation fields, and it is granted no
 * filesystem tools by design. A full result can exceed the host's inline-response
 * limit, at which point the host offloads it to a file the lane cannot open — so
 * the lane produced no report and its controller re-dispatched, duplicating the
 * entire attempt. Returning only what the lane reports removes the offload
 * without widening the lane's trust surface. Full evidence stays archived and
 * reaches the architect through `reviewCandidate`.
 */
export interface LaneEnvelope {
  runId: string;
  status: AttemptResult["status"];
  producerId: string | null;
  manifestHash: string | null;
  failure: AttemptResult["failure"];
  durationMs: number;
}

function laneEnvelope(result: AttemptResult): LaneEnvelope {
  return {
    runId: result.runId,
    status: result.status,
    producerId: result.producerId,
    manifestHash: result.candidate?.manifestHash ?? null,
    failure: result.failure,
    durationMs: result.durationMs,
  };
}

export async function handleDelegate(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
  responseMode: "full" | "lane" = "full",
): Promise<
  | { ok: true; result: AttemptResult | LaneEnvelope }
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
  const producerErrors = unknownProducerErrors(validation.spec.producerPreferences);
  if (producerErrors.length > 0) {
    return { ok: false, error: "invalid-specification", validationErrors: producerErrors };
  }

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    await warnOnStaleLiveBundle(canonical.canonical, deps);
    await warnOnAllowlistConsumers(canonical.canonical, validation.spec, deps);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
      };
      const result = await (deps.runAttempt ?? executeAttempt)(
        canonical.canonical,
        validation.spec,
        attemptDependencies,
      );
      return {
        ok: true,
        result: responseMode === "lane" ? laneEnvelope(result) : boundIgnoredPathEvidence(result),
      };
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
  responseMode: "full" | "lane" = "full",
): Promise<
  | { ok: true; result: PipelineResult | LaneEnvelope }
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
  const producerErrors = unknownProducerErrors(validation.spec.producerPreferences);
  if (producerErrors.length > 0) {
    return { ok: false, error: "invalid-specification", validationErrors: producerErrors };
  }

  try {
    const ps = services(deps);
    const canonical = await ps.canonicalizePath(checkoutPath);
    await warnOnStaleLiveBundle(canonical.canonical, deps);
    await warnOnAllowlistConsumers(canonical.canonical, validation.spec, deps);
    const key = canonical.gitCommonDir ?? canonical.canonical;
    return await withRepoLock(key, async () => {
      const configured = deps.attemptDependencies ?? { verifier: new AcceptanceVerifier() };
      const attemptDependencies: AttemptRuntimeDependencies = {
        ...configured,
        ps,
        verifier: configured.verifier ?? new AcceptanceVerifier(),
        ...(deps.onProgress === undefined ? {} : { onPhase: deps.onProgress }),
        ...(deps.abortSignal === undefined ? {} : { abortSignal: deps.abortSignal }),
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
      // The bound reads `value.evidence`; a pipeline's lives one level deeper,
      // so this path returned a repository-sized ignored-path list untouched.
      if (responseMode === "lane") {
        return { ok: true, result: laneEnvelope(pipelineResult.attempt) };
      }
      return {
        ok: true,
        result: { ...pipelineResult, attempt: boundIgnoredPathEvidence(pipelineResult.attempt) },
      };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

/**
 * Prove a reported run id belongs to the spec the caller dispatched.
 *
 * A delegation lane reports its own `runId` and echoes back the `specSha256` it
 * was handed, so both are claims by the party whose work is under review. A lane
 * naming a nonexistent run already fails here; the dangerous case is one naming
 * a *different real* run — an earlier green attempt — which returns a clean
 * candidate for work nobody asked for. `specSha256` was persisted at run start
 * for exactly this comparison, and until now nothing performed it.
 *
 * Fails closed: a caller that asked for verification and cannot get it is told
 * so, never told "verified" by omission.
 */
async function requireSpecCorrespondence(
  run: ArchivedRun,
  runId: string,
  expectedSpecSha256: string | undefined,
): Promise<void> {
  if (expectedSpecSha256 === undefined) return;
  if (!/^[0-9a-f]{64}$/u.test(expectedSpecSha256)) {
    throw runtimeError("expectedSpecSha256 is not a sha-256 digest", "run-spec-unverifiable");
  }
  const recorded = await run.store.readRunStartSpecSha256(runId);
  if (recorded === null) {
    throw runtimeError(
      "this run recorded no spec hash, so it cannot be matched to the dispatched spec",
      "run-spec-unverifiable",
    );
  }
  if (recorded !== expectedSpecSha256) {
    throw runtimeError(
      "this run was started from a different spec than the one supplied",
      "run-spec-mismatch",
    );
  }
}

export async function handleReviewCandidate(
  checkoutPath: string,
  runId: string,
  deps: ToolDependencies = {},
  expectedSpecSha256?: string,
): Promise<
  | {
    patch: string;
    changedPaths: CandidateArtifact["changedPaths"];
    /** Exact hash `integrateCandidate` requires as `expectedArtifactHash`. */
    manifestHash: string;
    evidence: AttemptResult["evidence"];
    executedVerification: AttemptResult["executedVerification"];
  }
  | ToolErrorResult
> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      await requireSpecCorrespondence(run, runId, expectedSpecSha256);
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
      if (anchor.exitCode !== 0
        || anchor.stdout.trim() !== candidate.candidateCommitOid
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
        patch: patch.stdout,
        changedPaths: candidate.changedPaths.map(change => ({ ...change })),
        // `integrateCandidate` requires this exact value as `expectedArtifactHash`.
        // Omitting it forced the architect to source the hash from a different
        // tool's output than the one it reviewed.
        manifestHash: candidate.manifestHash,
        evidence: structuredClone(run.result.evidence),
        executedVerification: run.result.executedVerification.map(outcome => ({
          ...outcome,
          args: [...outcome.args],
        })),
      });
    });
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Reads the pipeline gate's verdict for a run so the human confirming a
 * decision sees it. Advisory and read-only; the authoritative checks run under
 * the repository lock in `handleDecideCandidate`.
 *
 * A read failure is reported, never swallowed. Returning "no warnings" because
 * the archive could not be read would present an unknown candidate as a clean
 * one at exactly the moment that matters.
 */
export interface DecisionAdvisory {
  /** Human-readable cautions to show whoever confirms the decision. */
  warnings: string[];
  /**
   * The run is an independently verified candidate carrying no failure. This is
   * a positive condition, deliberately not "warnings.length === 0": a plain
   * `delegate` run has neither pipeline-gate evidence nor review evidence, so it
   * produces zero warnings whether or not it verified. Autonomy must turn on
   * what the run proved, never on the absence of a pipeline's paperwork.
   */
  verifiedClean: boolean;
  /**
   * The archive could not be read, so nothing about this candidate is known.
   * Distinct from "verified false" — the difference decides whether autonomous
   * acceptance may proceed or must refuse.
   */
  unreadable: boolean;
}

export async function readDecisionAdvisory(
  runId: string,
  deps: ToolDependencies = {},
): Promise<DecisionAdvisory> {
  let run: ArchivedRun;
  try { run = await loadArchivedRun(runId, deps); }
  catch (error) {
    return {
      warnings: [`the pipeline gate outcome for this run could not be read: ${
        redact(error instanceof Error ? error.message : String(error))}`],
      verifiedClean: false,
      unreadable: true,
    };
  }
  const refused = run.result.evidence.pipelineGateRefused;
  const incomplete = run.result.evidence.pipelineReviewIncomplete;
  const warnings: string[] = [];
  if (isRecord(refused) && Array.isArray(refused.reasons)) {
    warnings.push(
      `the pipeline gate did NOT clear this candidate: ${
        refused.reasons.filter(r => typeof r === "string").join("; ")}`,
    );
  }
  if (isRecord(incomplete) && typeof incomplete.reason === "string") {
    warnings.push(`the pipeline could not complete its own review: ${incomplete.reason}`);
  }
  return {
    warnings,
    verifiedClean: run.result.status === "verified-candidate" && run.result.failure === null,
    unreadable: false,
  };
}

export async function handleDecideCandidate(
  checkoutPath: string,
  runId: string,
  decision: RunDecisionValue,
  deps: ToolDependencies = {},
): Promise<{ recorded: true } | ToolErrorResult> {
  try {
    return await withCurrentArchivedRun(checkoutPath, runId, deps, async run => {
      await requireInactivePipeline(run, runId);
      if (decision === "accepted") requireVerifiedCandidate(run);
      // Bind the decision to the exact candidate it was made about, so an
      // acceptance cannot later be spent on a different artifact, and record how
      // the decision was obtained so an agent-supplied one is visible as such.
      const candidateHash = run.result.candidate?.manifestHash ?? null;
      const record: RunDecision = {
        decision,
        recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
        decidedBy: deps.decisionProvenance ?? "caller-asserted",
        candidateManifestHash: candidateHash,
      };
      await run.store.writeDecision(record);
      if (decision === "rejected" && run.result.candidate !== null) {
        const candidate = run.result.candidate;
        const deleted = await (deps.git ?? runGit)(run.repoRoot, [
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
      const decision = await run.store.readDecision(runId);
      if (decision?.decision !== "accepted") {
        return { integration: "aborted", detail: "no-accepted-decision" };
      }
      // An acceptance is a judgement about one specific candidate. When the
      // record names the artifact it was made about, refuse to spend it on a
      // different one. Records written before provenance existed carry no hash;
      // those fall through to the hash check inside applyCandidateTree.
      if (decision.candidateManifestHash != null
        && decision.candidateManifestHash !== expectedArtifactHash) {
        return { integration: "aborted", detail: "decision-artifact-mismatch" };
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
