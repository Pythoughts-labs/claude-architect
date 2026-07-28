import { git, type GitResult } from "../git/git-exec.js";
import {
  foldPathForCollision,
  inspectChangedPathManifest,
  parseRawDiff,
  splitNul,
  type RawDiffEntry,
} from "../git/changed-path-manifest.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";
import { globMatches } from "../util/glob.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export type StructuralFailure =
  | "manifest-divergence"
  | "artifact-divergence"
  | "out-of-scope-write"
  | "modified-symlink"
  | "case-collision"
  | "empty-candidate"
  /**
   * The frozen artifact does not match the base it claims to be built from.
   * Intrinsic to the candidate, so it is a verification failure.
   *
   * Renamed from `base-changed`, which also covered two properties of the
   * *shared checkout* — that its HEAD had moved and that it was dirty. Those are
   * mutable, extrinsic to a frozen artifact, re-checked authoritatively under
   * the repository lock at integration, and can change again in between, so
   * failing verification on them discarded valid candidates and proved nothing.
   * They are reported as `checkoutDrift` evidence instead.
   */
  | "artifact-base-mismatch";

/** Observed state of the shared checkout. Never a verification failure. */
export interface CheckoutDrift {
  headMoved: boolean;
  dirty: boolean;
}

export interface StructuralVerifyArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  writeAllowlist: string[];
  forbiddenScope: string[];
}

export interface StructuralVerifyResult {
  ok: boolean;
  failures: StructuralFailure[];
  /**
   * The INDEPENDENTLY recomputed manifest hash, never the candidate's own
   * claim. `null` when colliding paths make the manifest uncomputable — a
   * missing proof must read as missing, not as the Producer's assertion.
   */
  manifestHash: string | null;
  /** Recorded so a human sees the checkout moved; does not affect `ok`. */
  checkoutDrift?: CheckoutDrift;
}

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = redact(result.stderr || result.stdout).trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  // Truncated output is a partial answer, and every caller here treats what it
  // gets as the complete path set — a clipped `ls-tree` would silently hide a
  // real case collision. Proof cannot rest on a truncated read.
  if (result.truncated?.stdout === true || result.truncated?.stderr === true) {
    throw gitFailure(`git ${args[0] ?? "command"}`, { ...result, stderr: "output truncated" });
  }
  return result.stdout;
}



function isAllowed(
  pathname: string,
  writeAllowlist: string[],
  forbiddenScope: string[],
  opaqueDirectory = false,
): boolean {
  const scopePaths = opaqueDirectory ? [pathname, `${pathname}/`] : [pathname];
  return writeAllowlist.some(pattern => scopePaths.some(candidate => globMatches(pattern, candidate)))
    && !forbiddenScope.some(pattern =>
      scopePaths.some(candidate => globMatches(pattern, candidate, true)));
}

export function pathsCaseCollide(changedPaths: string[], treePaths: string[]): boolean {
  const changedByFold = new Map<string, string>();
  for (const changedPath of changedPaths) {
    const { exact, folded } = foldPathForCollision(changedPath);
    const existing = changedByFold.get(folded);
    if (existing !== undefined && existing !== exact) return true;
    changedByFold.set(folded, exact);
  }
  for (const treePath of treePaths) {
    const { exact, folded } = foldPathForCollision(treePath);
    const changed = changedByFold.get(folded);
    if (changed !== undefined && changed !== exact) return true;
  }
  return false;
}

async function candidateHasCaseCollision(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<boolean> {
  const [changedOutput, treeOutput] = await Promise.all([
    checkedGit(args.worktreePath, [
      "diff-tree", "-r", "--no-commit-id", "--no-renames", "--name-only", "-z",
      args.baseCommitOid, args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, [
      "ls-tree", "-r", "--name-only", "-z", args.artifact.candidateTreeOid,
    ]),
  ]);
  return pathsCaseCollide(splitNul(changedOutput), splitNul(treeOutput));
}

export async function recomputeManifest(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<{
  changedPaths: ChangedPath[];
  manifestHash: string | null;
  rawDiff: RawDiffEntry[];
}> {
  const [rawOutput, nameStatusOutput, treeOutput] = await Promise.all([
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--raw",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--name-status",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, ["ls-tree", "-r", "-z", args.artifact.candidateTreeOid]),
  ]);
  const rawDiff = parseRawDiff(rawOutput);
  const { changedPaths, manifestHash } = inspectChangedPathManifest({
    rawDiff,
    nameStatusOutput,
    treeOutput,
  });
  return { changedPaths, manifestHash, rawDiff };
}

async function artifactIdentityMatches(args: StructuralVerifyArgs): Promise<boolean> {
  const [anchorResult, treeResult, parentResult] = await Promise.all([
    git(args.repoRoot, ["rev-parse", "--verify", `${args.artifact.anchorRef}^{commit}`]),
    git(args.repoRoot, [
      "rev-parse",
      "--verify",
      `${args.artifact.candidateCommitOid}^{tree}`,
    ]),
    git(args.repoRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      args.artifact.candidateCommitOid,
    ]),
  ]);
  if (anchorResult.exitCode !== 0 || treeResult.exitCode !== 0 || parentResult.exitCode !== 0) {
    return false;
  }
  const commitAndParents = parentResult.stdout.trim().split(/\s+/);
  return anchorResult.stdout.trim() === args.artifact.candidateCommitOid
    && treeResult.stdout.trim() === args.artifact.candidateTreeOid
    && commitAndParents.length === 2
    && commitAndParents[0] === args.artifact.candidateCommitOid
    && commitAndParents[1] === args.baseCommitOid;
}

export async function structuralVerify(args: StructuralVerifyArgs): Promise<StructuralVerifyResult> {
  const failures = new Set<StructuralFailure>();
  const [
    manifest,
    baseTreeOid,
    currentHead,
    mainStatus,
    artifactIdentityValid,
    caseCollision,
  ] = await Promise.all([
    recomputeManifest(args),
    checkedGit(args.repoRoot, ["rev-parse", `${args.baseCommitOid}^{tree}`]),
    checkedGit(args.repoRoot, ["rev-parse", "--verify", "HEAD"]),
    checkedGit(args.repoRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
    artifactIdentityMatches(args),
    candidateHasCaseCollision(args),
  ]);

  if (caseCollision) failures.add("case-collision");
  if (args.artifact.baseCommitOid !== args.baseCommitOid) {
    failures.add("artifact-base-mismatch");
  }
  const checkoutDrift: CheckoutDrift = {
    headMoved: currentHead.trim() !== args.baseCommitOid,
    dirty: mainStatus.length > 0,
  };
  if (manifest.manifestHash === null
    || JSON.stringify(args.artifact.changedPaths) !== JSON.stringify(manifest.changedPaths)
    || args.artifact.manifestHash !== manifest.manifestHash) {
    failures.add("manifest-divergence");
  }
  if (!artifactIdentityValid) {
    failures.add("artifact-divergence");
  }
  if (manifest.changedPaths.some(change =>
    !isAllowed(
      change.path,
      args.writeAllowlist,
      args.forbiddenScope,
      change.mode === "160000",
    ))) {
    failures.add("out-of-scope-write");
  }
  if (manifest.rawDiff.some(entry =>
    [entry.oldMode, entry.newMode].some(mode => mode === "120000" || mode === "160000"))) {
    failures.add("modified-symlink");
  }
  if (manifest.changedPaths.length === 0
    || args.artifact.candidateTreeOid === baseTreeOid.trim()) {
    failures.add("empty-candidate");
  }

  return {
    ok: failures.size === 0,
    failures: [...failures],
    manifestHash: manifest.manifestHash,
    checkoutDrift,
  };
}
