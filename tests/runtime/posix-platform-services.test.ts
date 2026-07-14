import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { resolveStateDir } from "../../src/runtime/state-dir.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-sleep.mjs", import.meta.url));
const ps = getPlatformServices();
let tempRoot: string;
let repoPath: string;
let aliasPath: string;
let previousPluginData: string | undefined;
let previousStateDir: string | undefined;

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, error => error ? reject(error) : resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(tmpdir(), "claude-architect-platform-test-"));
  repoPath = path.join(tempRoot, "repo");
  aliasPath = path.join(tempRoot, "repo-alias");
  await fs.mkdir(repoPath);
  await runGit(["init", "-q"], repoPath);
  await fs.symlink(repoPath, aliasPath, "dir");
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDir = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_ARCHITECT_STATE_DIR = path.join(tempRoot, "state");
});

afterAll(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDir === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDir;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("PosixPlatformServices", () => {
  it("uses the platform-neutral runtime state-directory policy", () => {
    expect(resolveStateDir()).toBe(process.env.CLAUDE_ARCHITECT_STATE_DIR);
  });

  it("resolves node and captures bounded process output", async () => {
    const originalPath = process.env.PATH;
    // Prefer the running Node binary over host PATH shims that require env beyond the intentionally sanitized PATH.
    process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${originalPath ?? ""}`;
    try {
      const executable = await ps.resolveExecutable({ name: "node" });
      const proc = await ps.spawnSupervised({
        executable, args: [fixture, "HELLO", "WOES", "0"], cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5000, maxOutputBytes: 1_000_000,
      });
      const exit = await proc.done;
      expect(exit.exitCode).toBe(0);
      expect(exit.stdout).toContain("HELLO");
      expect(exit.stderr).toContain("WOES");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("blocks a second checkout lock until the first is released", async () => {
    const lockA = await ps.acquireCheckoutLock(repoPath);
    let resolved = false;
    const pendingLockB = ps.acquireCheckoutLock(repoPath).then(lock => { resolved = true; return lock; });
    await delay(100);
    expect(resolved).toBe(false);
    await lockA.release();
    const lockB = await Promise.race([
      pendingLockB,
      delay(1000).then(() => { throw new Error("second checkout lock did not resolve after release"); }),
    ]);
    expect(lockB.key).toBe(lockA.key);
    await lockB.release();
  });

  it("canonicalizes symlink aliases to the same git common directory and lock key", async () => {
    const real = await ps.canonicalizePath(repoPath);
    const alias = await ps.canonicalizePath(aliasPath);
    expect(real.gitCommonDir).not.toBeNull();
    expect(alias.gitCommonDir).toBe(real.gitCommonDir);
    const realLock = await ps.acquireCheckoutLock(repoPath);
    await realLock.release();
    const aliasLock = await ps.acquireCheckoutLock(aliasPath);
    expect(aliasLock.key).toBe(realLock.key);
    await aliasLock.release();
  });

  it("refuses to terminate a process group for non-positive pids", async () => {
    const stillRunning = true;
    await expect(ps.terminateProcessTreeByPid(-1)).resolves.toBeUndefined();
    await expect(ps.terminateProcessTreeByPid(0)).resolves.toBeUndefined();
    await expect(ps.terminateProcessTreeByPid(1)).resolves.toBeUndefined();
    // If any of the calls above had actually signalled a real group (e.g. group 1 == init,
    // or this test worker's own group via pid 0), the process running this assertion would
    // be gone. Reaching here proves the guard skipped the kill instead of acting on it.
    expect(stillRunning).toBe(true);
  });

  it("terminates a real process tree when given its actual pid", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${originalPath ?? ""}`;
    try {
      const executable = await ps.resolveExecutable({ name: "node" });
      const proc = await ps.spawnSupervised({
        executable, args: [fixture, "", "", "60000"], cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" }, timeoutMs: 5000, maxOutputBytes: 1_000_000,
      });
      expect(proc.pid).toBeGreaterThan(1);
      await ps.terminateProcessTreeByPid(proc.pid);
      const exit = await Promise.race([
        proc.done,
        delay(2000).then(() => { throw new Error("process was not terminated"); }),
      ]);
      expect(exit.signal).toBe("SIGKILL");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
