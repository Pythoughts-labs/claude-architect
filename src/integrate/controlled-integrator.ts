import { git, type GitResult } from "../git/git-exec.js";
import { checkPreconditions } from "../git/repo-preconditions.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { RuntimeError } from "../util/errors.js";
import { structuralVerify } from "../verify/structural-verifier.js";

export interface ApplyCandidateTreeArgs {
  repoRoot: string;
  artifact: CandidateArtifact;
  expectedArtifactHash: string;
  /** Trusted runtime handoff; never derived from candidate or MCP input. */
  borrowedCheckoutLock?: CheckoutLock;
  platformServices?: PlatformServices;
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
  const ps = args.platformServices ?? getPlatformServices();
  const canonicalPath = await ps.canonicalizePath(args.repoRoot);
  const { canonical } = canonicalPath;
  const repositoryIdentity = canonicalPath.gitCommonDir ?? canonicalPath.canonical;
  let ownedLock: CheckoutLock | null = null;
  const lock = args.borrowedCheckoutLock ?? await ps.acquireCheckoutLock(canonical);
  if (args.borrowedCheckoutLock === undefined) ownedLock = lock;
  const terminal: { result: IntegrationResult | null } = { result: null };
  const finish = (result: IntegrationResult): IntegrationResult => {
    terminal.result = result;
    return result;
  };
  try {
    if (lock.repositoryIdentity !== repositoryIdentity) {
      const ownership = ownedLock === null ? "borrowed" : "owned";
      throw new RuntimeError(`${ownership} checkout lease repository identity mismatch`);
    }
    const preconditions = await checkPreconditions(canonical);
    if (!preconditions.ok) return finish(aborted(`precondition-failed:${preconditions.reason}`));
    if (preconditions.baseCommitOid !== args.artifact.baseCommitOid) {
      return finish(aborted("base-changed"));
    }
    if (args.artifact.manifestHash !== args.expectedArtifactHash) {
      return finish(aborted("artifact-hash-mismatch"));
    }
    if (!CANDIDATE_REF.test(args.artifact.anchorRef)
      || !OBJECT_ID.test(args.artifact.candidateCommitOid)
      || !OBJECT_ID.test(args.artifact.candidateTreeOid)) {
      return finish(aborted("invalid-candidate-identity"));
    }
    const anchor = await git(canonical, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${args.artifact.anchorRef}^{commit}`,
    ]);
    if (!succeeded(anchor) || anchor.stdout.trim() !== args.artifact.candidateCommitOid) {
      return finish(aborted("candidate-anchor-mismatch"));
    }
    const candidateTree = await git(canonical, [
      "rev-parse",
      "--verify",
      `${args.artifact.candidateCommitOid}^{tree}`,
    ]);
    if (!succeeded(candidateTree) || candidateTree.stdout.trim() !== args.artifact.candidateTreeOid) {
      return finish(aborted("candidate-tree-mismatch"));
    }
    const identity = await structuralVerify({
      repoRoot: canonical,
      worktreePath: canonical,
      baseCommitOid: args.artifact.baseCommitOid,
      artifact: args.artifact,
      writeAllowlist: ["**"],
      forbiddenScope: [],
    });
    if (!identity.ok) {
      return finish(aborted("artifact-identity-mismatch"));
    }

    const refreshed = await git(canonical, ["update-index", "-q", "--refresh"]);
    if (!succeeded(refreshed)) {
      return finish({ integration: "conflicted", detail: "index-refresh-failed" });
    }
    const applied = await git(canonical, [
      "read-tree",
      "-m",
      "-u",
      args.artifact.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]);
    if (!succeeded(applied)) {
      return finish({ integration: "conflicted", detail: "candidate-apply-conflict" });
    }

    const stagedTree = await git(canonical, ["write-tree"]);
    const worktreeDiff = await git(canonical, ["diff", "--quiet", "--no-ext-diff"]);
    const head = await git(canonical, ["rev-parse", "--verify", "HEAD"]);
    const status = await git(canonical, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--no-renames",
    ]);
    if (!succeeded(stagedTree)
      || stagedTree.stdout.trim() !== args.artifact.candidateTreeOid
      || !succeeded(worktreeDiff)
      || !succeeded(head)
      || head.stdout.trim() !== args.artifact.baseCommitOid
      || !succeeded(status)
      || !statusMatchesArtifact(status.stdout, args.artifact.changedPaths)) {
      return finish({ integration: "conflicted", detail: "post-apply-divergence" });
    }

    const deleted = await git(canonical, [
      "update-ref",
      "--no-deref",
      "-d",
      args.artifact.anchorRef,
      args.artifact.candidateCommitOid,
    ]);
    if (!succeeded(deleted)) {
      return finish({
        integration: "applied",
        detail: "candidate tree applied; candidate anchor delete failed",
      });
    }
    return finish({ integration: "applied", detail: "candidate tree applied" });
  } finally {
    if (ownedLock !== null) {
      try {
        await ownedLock.release();
      } catch (error) {
        if (terminal.result === null) throw error;
        terminal.result.detail = `${terminal.result.detail}; checkout lock release failed`;
      }
    }
  }
}
