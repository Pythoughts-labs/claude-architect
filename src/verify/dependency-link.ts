import { execFile } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type DependencyLink =
  | "inherited"
  | "skipped-lockfile-mismatch"
  | "skipped-cow-unsupported"
  | "none";

const execFileAsync = promisify(execFile);

export interface DependencyLinkDependencies {
  execFile?: typeof execFileAsync;
  platform?: NodeJS.Platform;
}

const LOCKFILES = ["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"] as const;
const COPY_TIMEOUT_MS = 120_000;

async function exists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function linkPrimaryDependencies(
  primaryRepo: string,
  worktreePath: string,
  dependencies: DependencyLinkDependencies = {},
): Promise<DependencyLink> {
  const primaryModules = path.join(primaryRepo, "node_modules");
  if (!await exists(primaryModules)) return "none";

  const [primaryLockfiles, worktreeLockfiles] = await Promise.all([
    Promise.all(LOCKFILES.map(lockfile => exists(path.join(primaryRepo, lockfile)))),
    Promise.all(LOCKFILES.map(lockfile => exists(path.join(worktreePath, lockfile)))),
  ]);
  if (!primaryLockfiles.some(Boolean)) return "none";
  if (primaryLockfiles.some((present, index) => present !== worktreeLockfiles[index])) {
    return "skipped-lockfile-mismatch";
  }

  try {
    const comparisons = await Promise.all(LOCKFILES.map(async (lockfile, index) => {
      if (!primaryLockfiles[index]) return true;
      const [primaryLock, worktreeLock] = await Promise.all([
        readFile(path.join(primaryRepo, lockfile)),
        readFile(path.join(worktreePath, lockfile)),
      ]);
      return primaryLock.equals(worktreeLock);
    }));
    if (comparisons.some(matches => !matches)) return "skipped-lockfile-mismatch";
  } catch {
    return "skipped-lockfile-mismatch";
  }

  const targetModules = path.join(worktreePath, "node_modules");
  const platform = dependencies.platform ?? process.platform;
  const copyArgs = platform === "darwin"
    ? ["-Rc", primaryModules, targetModules]
    : platform === "linux"
      ? ["-a", "--reflink=always", primaryModules, targetModules]
      : null;
  if (copyArgs === null) return "skipped-cow-unsupported";

  try {
    await (dependencies.execFile ?? execFileAsync)("cp", copyArgs, { timeout: COPY_TIMEOUT_MS });
    return "inherited";
  } catch {
    await rm(targetModules, { recursive: true, force: true });
    return "skipped-cow-unsupported";
  }
}
