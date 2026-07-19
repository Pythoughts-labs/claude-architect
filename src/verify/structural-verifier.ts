import { git, type GitResult } from "../git/git-exec.js";
import { computeChangedPathManifest, parseRawDiff, type RawDiffEntry } from "../git/changed-path-manifest.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export type StructuralFailure =
  | "manifest-divergence"
  | "artifact-divergence"
  | "out-of-scope-write"
  | "modified-symlink"
  | "empty-candidate"
  | "base-changed";

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
  manifestHash: string;
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

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globMatches(pattern: string, candidate: string, caseInsensitive = false): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== "*") {
      expression += escapeRegex(character);
      continue;
    }
    if (pattern[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }
    index += 1;
    if (pattern[index + 1] === "/") {
      expression += "(?:.*/)?";
      index += 1;
    } else {
      expression += ".*";
    }
  }
  return new RegExp(`${expression}$`, caseInsensitive ? "i" : undefined).test(candidate);
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

export async function recomputeManifest(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<{
  changedPaths: ChangedPath[];
  manifestHash: string;
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
  const { changedPaths, manifestHash } = computeChangedPathManifest({
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
  const [manifest, baseTreeOid, currentHead, mainStatus, artifactIdentityValid] = await Promise.all([
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
  ]);

  if (args.artifact.baseCommitOid !== args.baseCommitOid
    || currentHead.trim() !== args.baseCommitOid
    || mainStatus.length > 0) {
    failures.add("base-changed");
  }
  if (JSON.stringify(args.artifact.changedPaths) !== JSON.stringify(manifest.changedPaths)
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
  };
}
