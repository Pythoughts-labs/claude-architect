import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { UnsupportedPlatformError } from "../../src/platform/select-platform.js";

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

  it("does not silently fall back to a temporary directory outside tests", async () => {
    const { directory, base } = await initRepo();
    delete process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
    process.env.NODE_ENV = "production";

    await expect(new WorktreeManager(directory, "run-no-state").create(base)).rejects.toThrow(
      "CLAUDE_PLUGIN_DATA is required outside test environments",
    );
  });

  it("rejects win32 before resolving or creating the state directory", async () => {
    const { directory, base } = await initRepo();
    const stateParent = await temporaryDirectory("ca-win32-state-parent-");
    const stateRoot = join(stateParent, "not-created");
    process.env.CLAUDE_PLUGIN_DATA = stateRoot;
    const manager = new WorktreeManager(directory, "run-win32", { os: "win32" });

    await expect(manager.create(base)).rejects.toBeInstanceOf(UnsupportedPlatformError);

    await expect(stat(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
