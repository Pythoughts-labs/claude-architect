import { git, type GitResult } from "../git/git-exec.js";
import { checkPreconditions } from "../git/repo-preconditions.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { RuntimeError } from "../util/errors.js";

export interface ApplyCandidateTreeArgs {
  repoRoot: string;
  artifact: CandidateArtifact;
  expectedArtifactHash: string;
}

export interface IntegrationResult {
  integration: "applied" | "conflicted" | "aborted";
  detail: string;
}

const CANDIDATE_REF = /^refs\/claude-architect\/candidates\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function succeeded(result: GitResult): boolean {
  return result.exitCode === 0;
}

function aborted(detail: string): IntegrationResult {
  return { integration: "aborted", detail };
}

async function rollback(repoRoot: string, baseCommitOid: string): Promise<void> {
  const result = await git(repoRoot, ["reset", "--hard", baseCommitOid]);
  if (!succeeded(result)) throw new RuntimeError("failed to roll back candidate integration");
}

function statusMatchesArtifact(output: string, changedPaths: ChangedPath[]): boolean {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length !== changedPaths.length) return false;
  const actual = new Map<string, string>();
  for (const record of records) {
    if (record.length < 4 || record[1] !== " " || record[2] !== " ") return false;
    const pathname = record.slice(3);
    if (actual.has(pathname)) return false;
    actual.set(pathname, record[0]!);
  }
  return changedPaths.every(change => actual.get(change.path) === (
    change.changeType === "added" ? "A" : change.changeType === "deleted" ? "D" : "M"
  ));
}

export async function applyCandidateTree(args: ApplyCandidateTreeArgs): Promise<IntegrationResult> {
  const ps = getPlatformServices();
  const { canonical } = await ps.canonicalizePath(args.repoRoot);
  const lock = await ps.acquireCheckoutLock(canonical);
  try {
    const preconditions = await checkPreconditions(canonical);
    if (!preconditions.ok) return aborted(`precondition-failed:${preconditions.reason}`);
    if (preconditions.baseCommitOid !== args.artifact.baseCommitOid) {
      return aborted("base-changed");
    }
    if (args.artifact.manifestHash !== args.expectedArtifactHash) {
      return aborted("artifact-hash-mismatch");
    }
    if (!CANDIDATE_REF.test(args.artifact.anchorRef)
      || !OBJECT_ID.test(args.artifact.candidateCommitOid)
      || !OBJECT_ID.test(args.artifact.candidateTreeOid)) {
      return aborted("invalid-candidate-identity");
    }

    const anchor = await git(canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${args.artifact.anchorRef}^{commit}`,
    ]);
    if (!succeeded(anchor) || anchor.stdout.trim() !== args.artifact.candidateCommitOid) {
      return aborted("candidate-anchor-mismatch");
    }
    const candidateTree = await git(canonical, [
      "rev-parse",
      "--verify",
      `${args.artifact.candidateCommitOid}^{tree}`,
    ]);
    if (!succeeded(candidateTree) || candidateTree.stdout.trim() !== args.artifact.candidateTreeOid) {
      return aborted("candidate-tree-mismatch");
    }

    const refreshed = await git(canonical, ["update-index", "-q", "--refresh"]);
    if (!succeeded(refreshed)) return { integration: "conflicted", detail: "index-refresh-failed" };
    const applied = await git(canonical, [
      "read-tree",
      "-m",
      "-u",
      args.artifact.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]);
    if (!succeeded(applied)) return { integration: "conflicted", detail: "candidate-apply-conflict" };

    const status = await git(canonical, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
    ]);
    const stagedTree = await git(canonical, ["write-tree"]);
    const worktreeDiff = await git(canonical, ["diff", "--quiet", "--no-ext-diff"]);
    const head = await git(canonical, ["rev-parse", "--verify", "HEAD"]);
    if (!succeeded(stagedTree)
      || stagedTree.stdout.trim() !== args.artifact.candidateTreeOid
      || !succeeded(worktreeDiff)
      || !succeeded(head)
      || head.stdout.trim() !== args.artifact.baseCommitOid
      || !succeeded(status)
      || !statusMatchesArtifact(status.stdout, args.artifact.changedPaths)) {
      await rollback(canonical, args.artifact.baseCommitOid);
      return aborted("post-apply-sanity-failed");
    }

    const deleted = await git(canonical, [
      "update-ref",
      "--no-deref",
      "-d",
      args.artifact.anchorRef,
      args.artifact.candidateCommitOid,
    ]);
    if (!succeeded(deleted)) {
      await rollback(canonical, args.artifact.baseCommitOid);
      return aborted("candidate-anchor-delete-failed");
    }
    return { integration: "applied", detail: "candidate tree applied" };
  } finally {
    await lock.release();
  }
}
