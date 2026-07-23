import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError } from "../util/errors.js";
import { git, type GitResult } from "./git-exec.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;
// A Producer's test children can briefly hold the worktree open after the
// process tree is terminated, which is not a Windows-only condition — one such
// race cost a whole slice result and left an orphan directory behind.
const REMOVE_ATTEMPTS = 5;
const REMOVE_RETRY_DELAY_MS = 250;
const SAFE_MANAGED_ID = /^[a-z0-9][a-z0-9._-]*$/;

interface WorktreeManagerDependencies {
  git?: typeof git;
  delay?: (milliseconds: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function canonicalize(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function failure(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

export class WorktreeManager {
  constructor(
    private readonly repoRoot: string,
    private readonly runId: string,
    private readonly platformServices: Pick<PlatformServices, "os"> = getPlatformServices(),
    private readonly dependencies: WorktreeManagerDependencies = {},
  ) {}

  private managedWorktreePath(): { worktreesRoot: string; worktreePath: string } {
    if (!SAFE_MANAGED_ID.test(this.runId)) {
      throw new RuntimeError("invalid worktree run id");
    }
    const worktreesRoot = path.resolve(resolveStateDir(), "worktrees");
    const worktreePath = path.resolve(worktreesRoot, this.runId);
    if (worktreePath === worktreesRoot || !worktreePath.startsWith(`${worktreesRoot}${path.sep}`)) {
      throw new RuntimeError("invalid worktree run id");
    }
    return { worktreesRoot, worktreePath };
  }

  async create(baseCommitOid: string): Promise<{ path: string; cleanup(): Promise<void> }> {
    const { worktreesRoot, worktreePath } = this.managedWorktreePath();
    await mkdir(worktreesRoot, { recursive: true });
    const result = await (this.dependencies.git ?? git)(
      this.repoRoot,
      ["worktree", "add", "--detach", worktreePath, baseCommitOid],
    );
    if (result.exitCode !== 0) {
      throw failure("git worktree add", result);
    }
    return {
      path: worktreePath,
      cleanup: () => this.remove(worktreePath),
    };
  }

  async remove(worktreePath: string): Promise<void> {
    if (worktreePath !== this.managedWorktreePath().worktreePath) {
      throw new RuntimeError("refusing to remove unmanaged worktree path");
    }
    const runGit = this.dependencies.git ?? git;
    const wait = this.dependencies.delay ?? delay;
    let lastResult: GitResult | null = null;
    for (let attempt = 1; attempt <= REMOVE_ATTEMPTS; attempt += 1) {
      lastResult = await runGit(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      if (lastResult.exitCode === 0) return;
      if (attempt < REMOVE_ATTEMPTS) await wait(REMOVE_RETRY_DELAY_MS);
    }
    // Last resort, and only for a path Git still lists as a worktree of this
    // repository: remove the checkout directly, then prune the registration it
    // leaves behind. Doing only the first would trade an orphan directory for a
    // dangling `.git/worktrees` entry — the same leak, mirrored.
    //
    // A path Git no longer tracks is not ours to delete: an unregistered
    // directory that reappeared there may hold anything, and removing it would
    // be an unbounded recursive delete outside the runtime's ownership.
    if (await this.isRegisteredWorktree(worktreePath)) {
      try {
        await rm(worktreePath, { recursive: true, force: true });
        const pruned = await runGit(this.repoRoot, ["worktree", "prune"]);
        if (pruned.exitCode === 0) return;
      } catch {
        // Fall through to the original diagnostic.
      }
    }
    throw failure("git worktree remove", lastResult!);
  }

  private async isRegisteredWorktree(worktreePath: string): Promise<boolean> {
    const runGit = this.dependencies.git ?? git;
    const listed = await runGit(this.repoRoot, ["worktree", "list", "--porcelain"]);
    if (listed.exitCode !== 0) return false;
    // git reports the canonical path, so on macOS `/var/...` and
    // `/private/var/...` name the same worktree and must compare equal.
    const canonical = await canonicalize(worktreePath);
    const registered = await Promise.all(listed.stdout.split(/\r?\n/u)
      .filter(line => line.startsWith("worktree "))
      .map(line => canonicalize(line.slice("worktree ".length).trim())));
    return registered.includes(canonical);
  }
}
