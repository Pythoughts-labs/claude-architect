import { access, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { getPlatformServices } from "../platform/select-platform.js";
import { git, type GitResult } from "./git-exec.js";

export interface PreconditionOptions {
  writeAllowlist?: string[];
}

export type PreconditionResult =
  | { ok: true; baseCommitOid: string; gitCommonDir: string }
  | { ok: false; reason: string };

const IN_PROGRESS_PATHS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "BISECT_LOG",
] as const;
const MAX_NESTED_REPOSITORY_SCAN_ENTRIES = 10_000;

function succeeded(result: GitResult): boolean {
  return result.exitCode === 0;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function segmentMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*+/g, ".*");
  return new RegExp(`^${expression}$`).test(value);
}

function patternOverlapsRepository(pattern: string, repositoryRoot: string): boolean {
  const patternSegments = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  const rootSegments = repositoryRoot.split("/").filter(Boolean);
  const visited = new Set<string>();

  function overlaps(patternIndex: number, rootIndex: number): boolean {
    if (rootIndex === rootSegments.length) return true;
    if (patternIndex === patternSegments.length) return false;
    const key = `${patternIndex}:${rootIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);

    const patternSegment = patternSegments[patternIndex]!;
    if (patternSegment === "**") {
      return overlaps(patternIndex + 1, rootIndex) || overlaps(patternIndex, rootIndex + 1);
    }
    return segmentMatches(patternSegment, rootSegments[rootIndex]!)
      && overlaps(patternIndex + 1, rootIndex + 1);
  }

  return overlaps(0, 0);
}

function submodulePaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const separator = record.indexOf("\t");
    if (separator !== -1) paths.add(record.slice(separator + 1).replace(/\\/g, "/"));
  }
  return paths;
}

async function findNestedRepositories(
  repositoryRoot: string,
  registeredSubmodules: Set<string>,
  writeAllowlist: string[],
): Promise<string[]> {
  const nested: string[] = [];
  let scannedEntries = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    scannedEntries += entries.length;
    if (scannedEntries > MAX_NESTED_REPOSITORY_SCAN_ENTRIES) {
      throw new Error("nested repository scan entry budget exceeded");
    }
    for (const entry of entries) {
      if (entry.name === ".git" || !entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      const relativeChild = path.relative(repositoryRoot, child).split(path.sep).join("/");
      if (registeredSubmodules.has(relativeChild)) continue;
      if (!writeAllowlist.some(pattern => patternOverlapsRepository(pattern, relativeChild))) continue;
      try {
        await lstat(path.join(child, ".git"));
        nested.push(relativeChild);
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error)
          || !["ENOENT", "ENOTDIR"].includes(String(error.code))) throw error;
        await walk(child);
      }
    }
  }

  await walk(repositoryRoot);
  return nested;
}

export async function checkPreconditions(
  repoRoot: string,
  options: PreconditionOptions = {},
): Promise<PreconditionResult> {
  const { canonical } = await getPlatformServices().canonicalizePath(repoRoot);

  const bare = await git(canonical, ["rev-parse", "--is-bare-repository"]);
  if (!succeeded(bare)) return { ok: false, reason: "not-a-repository" };
  if (bare.stdout.trim() === "true") return { ok: false, reason: "bare-repository" };

  const head = await git(canonical, ["rev-parse", "--verify", "HEAD"]);
  if (!succeeded(head)) return { ok: false, reason: "unborn-repository" };
  const baseCommitOid = head.stdout.trim();

  const gitDirectoryResult = await git(canonical, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  if (!succeeded(gitDirectoryResult)) return { ok: false, reason: "git-command-failed" };
  const gitDirectory = gitDirectoryResult.stdout.trim();
  if ((await Promise.all(IN_PROGRESS_PATHS.map(relative => exists(path.join(gitDirectory, relative))))).some(Boolean)) {
    return { ok: false, reason: "in-progress-operation" };
  }

  const status = await git(canonical, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"]);
  if (!succeeded(status)) return { ok: false, reason: "git-command-failed" };
  if (status.stdout.length > 0) return { ok: false, reason: "dirty-checkout" };

  const sparseCheckout = await git(canonical, ["config", "--bool", "core.sparseCheckout"]);
  if (sparseCheckout.exitCode !== 0 && sparseCheckout.exitCode !== 1) {
    return { ok: false, reason: "git-command-failed" };
  }
  if (sparseCheckout.stdout.trim() === "true") return { ok: false, reason: "sparse-checkout" };

  const submodules = await git(canonical, ["submodule", "status"]);
  if (!succeeded(submodules)) return { ok: false, reason: "git-command-failed" };
  if (/^[+-]/m.test(submodules.stdout)) return { ok: false, reason: "changed-submodule" };

  const indexEntries = await git(canonical, ["ls-files", "-v"]);
  if (!succeeded(indexEntries)) return { ok: false, reason: "git-command-failed" };
  if (/^[Ssh] /m.test(indexEntries.stdout)) return { ok: false, reason: "skip-worktree-entries" };

  if (options.writeAllowlist !== undefined && options.writeAllowlist.length > 0) {
    const stagedEntries = await git(canonical, ["ls-files", "--stage", "-z"]);
    if (!succeeded(stagedEntries)) return { ok: false, reason: "git-command-failed" };
    let nestedRepositories: string[];
    try {
      nestedRepositories = await findNestedRepositories(
        canonical,
        submodulePaths(stagedEntries.stdout),
        options.writeAllowlist,
      );
    } catch {
      return { ok: false, reason: "nested-repository-scan-failed" };
    }
    if (nestedRepositories.some(nestedRoot =>
      options.writeAllowlist!.some(pattern => patternOverlapsRepository(pattern, nestedRoot)))) {
      return { ok: false, reason: "nested-repository" };
    }
  }

  const commonDirectoryResult = await git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!succeeded(commonDirectoryResult)) return { ok: false, reason: "git-command-failed" };
  const gitCommonDir = await realpath(commonDirectoryResult.stdout.trim());
  return { ok: true, baseCommitOid, gitCommonDir };
}
