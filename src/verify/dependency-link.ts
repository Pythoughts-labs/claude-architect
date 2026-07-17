import { access, readFile, symlink } from "node:fs/promises";
import path from "node:path";

export type DependencyLink = "inherited" | "skipped-lockfile-mismatch" | "none";

const LOCKFILES = ["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"] as const;

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

  await symlink(primaryModules, path.join(worktreePath, "node_modules"), "junction");
  return "inherited";
}
