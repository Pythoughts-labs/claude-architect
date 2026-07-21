import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { resolveStateDir } from "../runtime/state-dir.js";
import { RuntimeError } from "../util/errors.js";
import { git, type GitResult } from "./git-exec.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;
const WINDOWS_REMOVE_ATTEMPTS = 5;
const WINDOWS_REMOVE_RETRY_DELAY_MS = 250;
const SAFE_MANAGED_ID = /^[a-z0-9][a-z0-9._-]*$/;

interface WorktreeManagerDependencies {
  git?: typeof git;
  delay?: (milliseconds: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
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

  async createAttached(
    branch: string,
    expectedCommitOid: string,
  ): Promise<{ path: string; cleanup(): Promise<void> }> {
    const { worktreesRoot, worktreePath } = this.managedWorktreePath();
    await mkdir(worktreesRoot, { recursive: true });
    const runGit = this.dependencies.git ?? git;
    const result = await runGit(
      this.repoRoot,
      ["worktree", "add", "--no-guess-remote", worktreePath, branch],
    );
    if (result.exitCode !== 0) {
      throw failure("git worktree add", result);
    }

    const symbolicBranch = await runGit(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const head = await runGit(worktreePath, ["rev-parse", "--verify", "HEAD"]);
    if (symbolicBranch.exitCode !== 0
      || symbolicBranch.stdout.trim() !== branch
      || head.exitCode !== 0
      || head.stdout.trim() !== expectedCommitOid) {
      try {
        await this.remove(worktreePath);
      } catch (cleanupError) {
        throw new AggregateError(
          [new RuntimeError("created worktree identity did not match"), cleanupError],
          "created worktree identity did not match and cleanup failed",
        );
      }
      throw new RuntimeError("created worktree identity did not match");
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
    const attempts = this.platformServices.os === "win32" ? WINDOWS_REMOVE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await runGit(this.repoRoot, ["worktree", "remove", "--force", worktreePath]);
      if (result.exitCode === 0) return;
      if (attempt === attempts) throw failure("git worktree remove", result);
      await wait(WINDOWS_REMOVE_RETRY_DELAY_MS);
    }
  }
}
