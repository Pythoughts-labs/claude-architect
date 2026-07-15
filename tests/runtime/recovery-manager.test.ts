import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { WorktreeManager } from "../../src/git/worktree-manager.js";
import { start } from "../../src/mcp/server.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import { recoverStaleRuns } from "../../src/runtime/recovery-manager.js";

const serverEvents = vi.hoisted(() => [] as string[]);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    registerTool() {}
    async connect() { serverEvents.push("connect"); }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousDelegated: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<{ directory: string; commonDir: string; head: string }> {
  const directory = await realpath(await temporaryDirectory("ca-recovery-repo-"));
  await runGit(directory, ["init", "-q"]);
  await writeFile(path.join(directory, "tracked.txt"), "base\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "base"]);
  return {
    directory,
    commonDir: await realpath(path.join(directory, ".git")),
    head: await runGit(directory, ["rev-parse", "HEAD"]),
  };
}

async function expectMissing(filename: string): Promise<void> {
  await expect(access(filename)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-recovery-state-");
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  serverEvents.length = 0;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("recoverStaleRuns", () => {
  it("terminates and archives a stale run before removing its worktree, anchor, and lock", async () => {
    const repo = await initRepo();
    const runId = "run-stale";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "99123");
    const terminated: number[] = [];

    const result = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ recovered: [runId] });
    expect(terminated).toEqual([4242]);
    await expectMissing(worktree.path);
    await expectMissing(lockPath);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", anchorRef])).exitCode)
      .not.toBe(0);
    expect(await readFile(path.join(store.runDirectory, "logs", "recovery.log"), "utf8"))
      .toBe("startup recovery reclaimed unfinished run\n");
    await expect(store.readResult(runId)).resolves.toMatchObject({
      runId,
      status: "cancelled",
      failure: "cancelled",
      evidence: { recovery: "startup-stale-run" },
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });
    expect(terminated).toEqual([4242]);
  });

  it("preserves a checkout lock whose recorded owner pid is still alive", async () => {
    const lockKey = "a".repeat(64);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(process.pid));

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [] });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(String(process.pid));
  });

  it("does not recover an unfinished run owned by a live locked session", async () => {
    const repo = await initRepo();
    const runId = "run-live-session";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "7777");
    const terminated: number[] = [];

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: pid => pid === 7777,
    })).resolves.toEqual({ recovered: [] });

    expect(terminated).toEqual([]);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("7777");
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("rejects a coercible non-string status instead of treating it as terminal", async () => {
    const runId = "run-malformed-terminal";
    const commonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: null,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    await writeFile(path.join(runDirectory, "result.json"), `${JSON.stringify({
      resultVersion: "1",
      runId,
      status: ["failed"],
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid() {},
      },
    })).rejects.toThrow(/attempt result.*invalid|terminal attempt result is malformed/);
  });

  it("terminates the recorded producer before validating a missing repository", async () => {
    const runId = "run-missing-repository";
    const commonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: 5252,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const terminated: number[] = [];

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminated).toEqual([5252]);
  });

  it("finishes an interrupted prune after the archive was quarantined", async () => {
    const repo = await initRepo();
    const runId = "run-prune-finish";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000001`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const runDirectory = path.join(runsRoot, runId);
    const quarantinePath = path.join(runsRoot, quarantineName);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "result.json"), "{}\n");
    await runGit(repo.directory, ["update-ref", backupRef, repo.head]);
    await rename(runDirectory, quarantinePath);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-age",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n{"event":"prune-cleanup-com`);

    await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    });

    await expectMissing(quarantinePath);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", backupRef])).exitCode)
      .not.toBe(0);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual([
      "prune-cleanup-intent",
      "prune-cleanup-complete",
    ]);
  });

  it("rolls back an interrupted prune while the archive is still retained", async () => {
    const repo = await initRepo();
    const runId = "run-prune-rollback";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    const quarantineName = `.prune-${runId}-00000000-0000-4000-8000-000000000002`;
    const runsRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    await mkdir(path.join(runsRoot, runId), { recursive: true });
    await runGit(repo.directory, ["update-ref", backupRef, repo.head]);
    await writeFile(path.join(runsRoot, "cleanup.ndjson"), `${JSON.stringify({
      event: "prune-cleanup-intent",
      runId,
      reason: "max-bytes",
      anchorCleanup: "pending",
      archiveBytes: 3,
      quarantineName,
      repoRoot: repo.directory,
      anchorRef,
      backupRef,
      candidateCommitOid: repo.head,
      recordedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    });

    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", backupRef])).exitCode)
      .not.toBe(0);
    const records = (await readFile(path.join(runsRoot, "cleanup.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.at(-1)?.event).toBe("prune-cleanup-rollback");
  });
});

describe("MCP startup recovery", () => {
  it("recovers stale state before connecting the transport", async () => {
    await start({
      async recoverStaleRuns() {
        serverEvents.push("recover");
        return { recovered: [] };
      },
    });

    expect(serverEvents).toEqual(["recover", "connect"]);
  });
});
