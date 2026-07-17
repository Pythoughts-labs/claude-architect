import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "../util/errors.js";

function invalidWritableRoots(message: string, cause?: unknown): RuntimeError {
  return new RuntimeError(message, {
    classification: "sandbox-violation",
    ...(cause === undefined ? {} : { cause }),
  });
}

async function requirePlainFile(filename: string, label: string): Promise<Stats> {
  const stats = await lstat(filename);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw invalidWritableRoots(`${label} must be a plain regular file`);
  }
  return stats;
}

async function requirePlainDirectory(directory: string, label: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw invalidWritableRoots(`${label} must be a plain directory`);
  }
}

function isContainedBy(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameFileIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function readStablePlainFile(filename: string, label: string): Promise<string> {
  const before = await requirePlainFile(filename, label);
  const value = await readFile(filename, "utf8");
  const after = await requirePlainFile(filename, label);
  if (!sameFileIdentity(before, after)) {
    throw invalidWritableRoots(`${label} changed while being read`);
  }
  return value;
}

export interface LinkedWorktreeGitAccess {
  gitDir: string;
  privateObjectsDir: string;
  sharedObjectsDir: string;
  writableRoots: string[];
}

export async function resolveLinkedWorktreeWritableRoots(
  worktreePath: string,
): Promise<LinkedWorktreeGitAccess> {
  const dotGit = path.join(worktreePath, ".git");
  try {
    const pointer = await readStablePlainFile(dotGit, "linked worktree .git entry");
    const match = /^gitdir: (.+)\r?\n?$/.exec(pointer);
    if (match === null) {
      throw invalidWritableRoots("linked worktree .git pointer is malformed");
    }

    const gitDir = await realpath(path.resolve(worktreePath, match[1]!));
    await requirePlainDirectory(gitDir, "linked worktree private git directory");

    const commonDirPointer = path.join(gitDir, "commondir");
    const commonDirValue = (await readStablePlainFile(
      commonDirPointer,
      "linked worktree commondir entry",
    )).trim();
    if (commonDirValue === "" || commonDirValue.includes("\0")) {
      throw invalidWritableRoots("linked worktree commondir pointer is malformed");
    }

    const commonDir = await realpath(path.resolve(gitDir, commonDirValue));
    await requirePlainDirectory(commonDir, "common git directory");
    const worktreesDir = await realpath(path.join(commonDir, "worktrees"));
    await requirePlainDirectory(worktreesDir, "common git worktrees directory");
    if (!isContainedBy(worktreesDir, gitDir)) {
      throw invalidWritableRoots("linked worktree private git directory escapes common git worktrees");
    }

    const sharedObjectsDir = await realpath(path.join(commonDir, "objects"));
    await requirePlainDirectory(sharedObjectsDir, "common git objects directory");

    const privateObjectsPath = path.join(gitDir, "private-objects");
    await mkdir(privateObjectsPath, { recursive: true, mode: 0o700 });
    await requirePlainDirectory(privateObjectsPath, "private git objects directory");
    const privateObjectsDir = await realpath(privateObjectsPath);
    if (!isContainedBy(gitDir, privateObjectsDir)) {
      throw invalidWritableRoots("private git objects directory escapes linked worktree git directory");
    }

    return {
      gitDir,
      privateObjectsDir,
      sharedObjectsDir,
      writableRoots: [gitDir, privateObjectsDir],
    };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw invalidWritableRoots("linked worktree writable roots are invalid", error);
  }
}
