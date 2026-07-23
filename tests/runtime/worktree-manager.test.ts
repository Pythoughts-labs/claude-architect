import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";

const failedGitResult = { exitCode: 1, stdout: "", stderr: "locked" };
const successfulGitResult = { exitCode: 0, stdout: "", stderr: "" };

let temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;
let previousNodeEnvironment: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<{ directory: string; base: string }> {
  const directory = await temporaryDirectory("ca-worktree-repo-");
  await runGit(directory, ["init", "-q"]);
  await writeFile(join(directory, "a.txt"), "hello\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "init"]);
  return { directory, base: await runGit(directory, ["rev-parse", "HEAD"]) };
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  previousNodeEnvironment = process.env.NODE_ENV;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-plugin-data-");
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })));
  temporaryPaths = [];
});

describe("WorktreeManager", () => {
  it("removes a worktree git itself refuses to remove, leaving no registration", async () => {
    const { directory, base } = await initRepo();
    // Finding 16: a Producer's surviving test children held the worktree open,
    // `git worktree remove` failed, and the orphan directory was left behind
    // with its registration already pruned. Force the failure git-side and
    // require both halves to end up clean.
    let removeAttempts = 0;
    const manager = new WorktreeManager(directory, "stuck", undefined, {
      git: async (cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") {
          removeAttempts += 1;
          return { exitCode: 128, stdout: "", stderr: "fatal: worktree is dirty" };
        }
        return git(cwd, args);
      },
      delay: async () => {},
    });
    const worktree = await manager.create(base);
    await writeFile(join(worktree.path, "held-open.txt"), "child still writing\n");

    await worktree.cleanup();

    expect(removeAttempts).toBeGreaterThan(1);
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    // The mirror leak: a directory removed but its registration left dangling.
    expect(await runGit(directory, ["worktree", "list"])).not.toContain("stuck");
  });

  it("creates a detached attempt worktree under persistent plugin data and cleans it up", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-123");

    const attempt = await manager.create(base);

    expect(attempt.path).toBe(join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", "run-123"));
    await expect(stat(attempt.path)).resolves.toBeDefined();
    expect(await runGit(attempt.path, ["rev-parse", "HEAD"])).toBe(base);
    expect((await git(attempt.path, ["symbolic-ref", "-q", "HEAD"])).exitCode).not.toBe(0);

    await attempt.cleanup();

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runGit(directory, ["worktree", "list", "--porcelain"])).not.toContain(attempt.path);
  });

  it("removes a worktree through the downstream remove method", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-remove");
    const attempt = await manager.create(base);

    await manager.remove(attempt.path);

    await expect(stat(attempt.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runGit(directory, ["worktree", "list", "--porcelain"])).not.toContain(attempt.path);
  });

  it("retries Windows worktree removal until a later attempt succeeds", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    const manager = new WorktreeManager("repo", "run-retry", { os: "win32" }, {
      git: async (_cwd, args) => {
        calls.push(args);
        return calls.length < 3 ? failedGitResult : successfulGitResult;
      },
      delay: async milliseconds => { delays.push(milliseconds); },
    });
    const managedPath = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", "run-retry");

    await manager.remove(managedPath);

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 250]);
  });

  it("throws after exhausting worktree removal retries", async () => {
    let removals = 0;
    const delays: number[] = [];
    const manager = new WorktreeManager("repo", "run-exhausted", { os: "win32" }, {
      git: async (_cwd, args) => {
        if (args[0] === "worktree" && args[1] === "remove") removals += 1;
        return failedGitResult;
      },
      delay: async milliseconds => { delays.push(milliseconds); },
    });
    const managedPath = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", "run-exhausted");

    await expect(manager.remove(managedPath)).rejects.toThrow("git worktree remove failed: locked");
    expect(removals).toBe(5);
    expect(delays).toEqual([250, 250, 250, 250]);
  });

  it("refuses to remove a path outside its managed worktree", async () => {
    const { directory } = await initRepo();
    const outside = await temporaryDirectory("ca-outside-worktree-");
    const sentinel = join(outside, "sentinel.txt");
    await writeFile(sentinel, "keep\n");
    const manager = new WorktreeManager(directory, "run-confined");

    await expect(manager.remove(outside)).rejects.toThrow("refusing to remove unmanaged worktree path");

    await expect(stat(outside)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("preserves a colliding managed directory when worktree creation fails", async () => {
    const { directory, base } = await initRepo();
    const collidingPath = join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", "run-collision");
    const sentinel = join(collidingPath, "sentinel.txt");
    await mkdir(collidingPath, { recursive: true });
    await writeFile(sentinel, "keep\n");
    const manager = new WorktreeManager(directory, "run-collision");

    await expect(manager.create(base)).rejects.toThrow("git worktree add failed");

    await expect(stat(collidingPath)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("preserves an unregistered managed directory when worktree removal fails", async () => {
    const { directory, base } = await initRepo();
    const manager = new WorktreeManager(directory, "run-remove-failure");
    const attempt = await manager.create(base);
    await runGit(directory, ["worktree", "remove", "--force", attempt.path]);
    const sentinel = join(attempt.path, "sentinel.txt");
    await mkdir(attempt.path, { recursive: true });
    await writeFile(sentinel, "keep\n");

    await expect(manager.remove(attempt.path)).rejects.toThrow("git worktree remove failed");

    await expect(stat(attempt.path)).resolves.toBeDefined();
    await expect(stat(sentinel)).resolves.toBeDefined();
  });

  it("does not silently fall back to a temporary directory outside tests", async () => {
    const { directory, base } = await initRepo();
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
    process.env.NODE_ENV = "production";

    await expect(new WorktreeManager(directory, "run-no-state").create(base)).rejects.toThrow(
      "CLAUDE_PLUGIN_DATA is required outside test environments",
    );
  });

});
