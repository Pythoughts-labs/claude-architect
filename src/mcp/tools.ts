import { createHash } from "node:crypto";
import { git as runGit } from "../git/git-exec.js";
import { applyCandidateTree as applyTree } from "../integrate/controlled-integrator.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
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
import { AcceptanceVerifier } from "../verify/acceptance-verifier.js";
import { withRepoLock } from "./serialize.js";

export type RunDecision = RunDecisionRecord;

export interface ToolArtifactStore {
  readResult(runId: string): Promise<AttemptResult | null>;
  readManifest(runId: string): Promise<RunManifest | null>;
  writeDecision(record: RunDecision): Promise<void>;
  readDecision(runId: string): Promise<RunDecision | null>;
}

export interface ToolDependencies {
  ps?: PlatformServices;
  storeFactory?: (runId: string) => ToolArtifactStore;
  git?: typeof runGit;
  runAttempt?: typeof executeAttempt;
  applyCandidateTree?: typeof applyTree;
  attemptDependencies?: AttemptRuntimeDependencies;
  skillProtocolVersion?: string;
  now?: () => Date;
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

function errorResult(error: unknown): ToolErrorResult {
  const code = error instanceof RuntimeError && typeof error.detail?.toolError === "string"
    ? error.detail.toolError
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
      };
      const result = await (deps.runAttempt ?? executeAttempt)(
        canonical.canonical,
        validation.spec,
        attemptDependencies,
      );
      return { ok: true, result };
    });
  } catch (error) {
    if (error instanceof NestedDelegationError) {
      return { ok: false, error: "nested-delegation-denied" };
    }
    return errorResult(error);
  }
}

export async function handleReviewCandidate(
  runId: string,
  deps: ToolDependencies = {},
): Promise<
  | {
    patch: string;
    changedPaths: CandidateArtifact["changedPaths"];
    evidence: AttemptResult["evidence"];
    executedVerification: AttemptResult["executedVerification"];
  }
  | ToolErrorResult
> {
  try {
    const run = await loadArchivedRun(runId, deps);
    return await withRepoLock(run.lockKey, async () => {
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
      return {
        patch: patch.stdout,
        changedPaths: candidate.changedPaths.map(change => ({ ...change })),
        evidence: structuredClone(run.result.evidence),
        executedVerification: run.result.executedVerification.map(outcome => ({
          ...outcome,
          args: [...outcome.args],
        })),
      };
    });
  } catch (error) {
    return errorResult(error);
  }
}

export async function handleDecideCandidate(
  runId: string,
  decision: RunDecisionValue,
  deps: ToolDependencies = {},
): Promise<{ recorded: true } | ToolErrorResult> {
  try {
    const run = await loadArchivedRun(runId, deps);
    return await withRepoLock(run.lockKey, async () => {
      const record: RunDecision = {
        decision,
        recordedAt: (deps.now ?? (() => new Date()))().toISOString(),
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
  runId: string,
  expectedArtifactHash: string,
  deps: ToolDependencies = {},
): Promise<{ integration: "applied" | "conflicted" | "aborted"; detail: string } | ToolErrorResult> {
  try {
    const run = await loadArchivedRun(runId, deps);
    return await withRepoLock(run.lockKey, async () => {
      const decision = await run.store.readDecision(runId);
      if (decision?.decision !== "accepted") {
        return { integration: "aborted", detail: "no-accepted-decision" };
      }
      return (deps.applyCandidateTree ?? applyTree)({
        repoRoot: run.repoRoot,
        artifact: requireCandidate(run),
        expectedArtifactHash,
      });
    });
  } catch (error) {
    return errorResult(error);
  }
}
