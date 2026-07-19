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
let previousPluginRoot: string | undefined;

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

async function createUnfinishedRun(
  runId: string,
  commonDir: string,
  pid: number | null,
  processToken: string | null = null,
): Promise<ArtifactStore> {
  const store = new ArtifactStore(runId);
  await mkdir(store.runDirectory, { recursive: true });
  const lockKey = createHash("sha256").update(commonDir).digest("hex");
  await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
    runId,
    lockKey,
    canonicalCommonDir: commonDir,
    pid,
    processToken,
    startedAt: "2026-07-14T12:00:00.000Z",
  })}\n`);
  return store;
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousDelegated = process.env.CLAUDE_ARCHITECT_DELEGATED;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-recovery-state-");
  delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  serverEvents.length = 0;
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousDelegated === undefined) delete process.env.CLAUDE_ARCHITECT_DELEGATED;
  else process.env.CLAUDE_ARCHITECT_DELEGATED = previousDelegated;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("recoverStaleRuns", () => {
  it("skips recovery while a live recovery mutex is held", async () => {
    const repo = await initRepo();
    const runId = "run-live-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    const owner = { pid: 9101, processToken: "darwin:live-recovery" };
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, JSON.stringify(owner));

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken(pid) {
          return pid === owner.pid ? owner.processToken : "darwin:self";
        },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: pid => pid === owner.pid,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(recoveryLockPath, "utf8"))
      .resolves.toBe(JSON.stringify(owner));
  }, { timeout: 120_000 });

  it("preserves a primary recovery error when lock releases also fail", async () => {
    const repo = await initRepo();
    const runId = "run-primary-and-release-failure";
    await createUnfinishedRun(runId, repo.commonDir, 4242, "darwin:live");
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const primaryError = new Error("primary recovery failure");

    let thrown: unknown;
    try {
      await recoverStaleRuns({
        platformServices: {
          os: "darwin",
          async getProcessStartToken(pid) {
            return pid === 4242 ? "darwin:live" : "darwin:self";
          },
          async terminateProcessTreeByPid() {},
        },
        isProcessAlive: () => true,
        async requestCooperativeTermination() {
          await rm(locksRoot, { recursive: true });
          await writeFile(locksRoot, "blocks lock release");
          throw primaryError;
        },
        graceMs: 0,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const containedErrors = (error: unknown): unknown[] => error instanceof AggregateError
      ? error.errors.flatMap(containedErrors)
      : [error];
    expect(containedErrors(thrown)).toContain(primaryError);
  }, { timeout: 120_000 });

  it("reclaims a dead recovery mutex before recovering stale runs", async () => {
    const repo = await initRepo();
    const runId = "run-dead-recovery-mutex";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const recoveryLockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      "recovery.lock",
    );
    await mkdir(path.dirname(recoveryLockPath), { recursive: true });
    await writeFile(recoveryLockPath, JSON.stringify({
      pid: 9102,
      processToken: "darwin:dead-recovery",
    }));

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    await expect(store.readResult(runId))
      .resolves.toMatchObject({ status: "cancelled" });
    await expectMissing(recoveryLockPath);
  }, { timeout: 120_000 });

  it("defers recovery when checkout ownership becomes live before mutation", async () => {
    const repo = await initRepo();
    const runId = "run-checkout-owner-revived";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "9103");
    let ownerChecks = 0;

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive(pid) {
        if (pid !== 9103) return false;
        ownerChecks += 1;
        return ownerChecks > 1;
      },
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(ownerChecks).toBeGreaterThanOrEqual(2);
    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(readFile(lockPath, "utf8")).resolves.toBe("9103");
  }, { timeout: 120_000 });

  it("preserves a replacement lock swapped during owner token probing", async () => {
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const lockPath = path.join(locksRoot, `${"f".repeat(64)}.lock`);
    const replacementPath = path.join(locksRoot, "replacement.lock");
    const replacementOwner = { pid: 9202, processToken: "darwin:live" };
    await mkdir(locksRoot, { recursive: true });
    await writeFile(lockPath, JSON.stringify({
      pid: 9201,
      processToken: "darwin:stale",
    }));

    await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken(pid) {
          if (pid !== 9201) return "darwin:self";
          await writeFile(replacementPath, JSON.stringify(replacementOwner));
          await rename(replacementPath, lockPath);
          return "darwin:replacement";
        },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    });

    await expect(readFile(lockPath, "utf8"))
      .resolves.toBe(JSON.stringify(replacementOwner));
  });

  it("cleans dead-owner pipeline worktrees for a terminal run", async () => {
    const repo = await initRepo();
    const runId = "run-dead-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await store.writeResult({
      resultVersion: "1",
      runId,
      status: "failed",
      failure: "producer-failure",
      summary: "pipeline failed",
      producerSummary: null,
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: [],
      evidence: {},
      logsRef: "logs/producer.log",
      producerId: null,
      producerVersion: null,
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    });
    const resultBefore = await readFile(path.join(store.runDirectory, "result.json"), "utf8");
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expectMissing(pipelineWorktree.path);
    await expectMissing(verifyWorktree.path);
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
    await expect(readFile(path.join(store.runDirectory, "result.json"), "utf8"))
      .resolves.toBe(resultBefore);
  }, { timeout: 120_000 });

  it("preserves live-owner pipeline worktrees for a terminal run", async () => {
    const repo = await initRepo();
    const runId = "run-live-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await store.writeResult({
      resultVersion: "1",
      runId,
      status: "failed",
      failure: "producer-failure",
      summary: "pipeline failed",
      producerSummary: null,
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: [],
      evidence: {},
      logsRef: "logs/producer.log",
      producerId: null,
      producerVersion: null,
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    });
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const markerPath = path.join(store.runDirectory, "pipeline-active.json");
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: null,
      startedAt: "2026-07-18T12:00:00.000Z",
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(access(pipelineWorktree.path)).resolves.toBeUndefined();
    await expect(access(verifyWorktree.path)).resolves.toBeUndefined();
    const preservedMarker = JSON.parse(await readFile(markerPath, "utf8")) as { pid?: unknown };
    expect(preservedMarker.pid).toBe(4242);
  }, { timeout: 120_000 });

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
    const baselineWorktree = await new WorktreeManager(
      repo.directory,
      `baseline-${runId}`,
    ).create(repo.head);
    const verifyWorktree = await new WorktreeManager(
      repo.directory,
      `verify-${runId}`,
    ).create(repo.head);
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const pipelineVerifyWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-verify`,
    ).create(repo.head);
    const unmanagedParent = await temporaryDirectory("ca-recovery-unmanaged-");
    const unmanagedWorktree = path.join(unmanagedParent, "external-worktree");
    await runGit(repo.directory, ["worktree", "add", "--detach", unmanagedWorktree, repo.head]);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "99123");
    const terminated: number[] = [];

    const result = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    });

    expect(result).toEqual({ recovered: [runId], quarantined: [] });
    expect(terminated).toEqual([]);
    await expectMissing(worktree.path);
    await expectMissing(baselineWorktree.path);
    await expectMissing(verifyWorktree.path);
    await expectMissing(pipelineWorktree.path);
    await expectMissing(pipelineVerifyWorktree.path);
    await expect(access(unmanagedWorktree)).resolves.toBeUndefined();
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
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [], quarantined: [] });
    expect(terminated).toEqual([]);
  });

  it("does not kill a stale run when its recorded process token differs", async () => {
    const repo = await initRepo();
    const runId = "run-recycled-pid";
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const store = new ArtifactStore(runId);
    await store.writeLog("lifecycle", "attempt lock acquired\n");
    await writeFile(path.join(store.runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: repo.commonDir,
      pid: 4242,
      processToken: "darwin:recorded-start",
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const calls: Array<{ pid: number; expectedToken?: string | null }> = [];
    const liveToken = "darwin:live-start";

    const result = await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return liveToken; },
        async terminateProcessTreeByPid(pid, expectedToken) {
          calls.push({ pid, expectedToken });
          if (expectedToken === undefined || expectedToken === liveToken) {
            throw new Error("test would have killed the live process");
          }
        },
      },
      isProcessAlive: () => true,
    });

    expect(result).toEqual({ recovered: [runId], quarantined: [] });
    expect(calls).toEqual([]);
    await expectMissing(worktree.path);
    await expect(store.readResult(runId)).resolves.toMatchObject({
      runId,
      status: "cancelled",
      evidence: { recovery: "startup-stale-run" },
    });
  });

  it("preserves a checkout lock whose recorded owner pid is still alive", async () => {
    const lockKey = "a".repeat(64);
    const lockPath = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks", `${lockKey}.lock`);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, String(process.pid));

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

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
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
      isProcessAlive: pid => pid === 7777,
    })).resolves.toEqual({ recovered: [], quarantined: [] });

    expect(terminated).toEqual([]);
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("7777");
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("defers recovery when the checkout lock owner is empty", async () => {
    const repo = await initRepo();
    const runId = "run-empty-checkout-owner";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const worktree = await new WorktreeManager(repo.directory, runId).create(repo.head);
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const lockPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "locks",
      `${lockKey}.lock`,
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "");

    await expect(recoverStaleRuns()).resolves.toEqual({ recovered: [], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toBeNull();
    await expect(access(worktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", anchorRef])).toBe(repo.head);
    await expect(readFile(lockPath, "utf8")).resolves.toBe("");
  }, { timeout: 120_000 });

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
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
    })).rejects.toThrow(/attempt result.*invalid|terminal attempt result is malformed/);
  });

  it("rejects a non-string process token", async () => {
    const runId = "run-malformed-process-token";
    const commonDir = path.join(process.env.CLAUDE_PLUGIN_DATA!, "missing-common-dir");
    const lockKey = createHash("sha256").update(commonDir).digest("hex");
    const runDirectory = path.join(process.env.CLAUDE_PLUGIN_DATA!, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(path.join(runDirectory, "run-start.json"), `${JSON.stringify({
      runId,
      lockKey,
      canonicalCommonDir: commonDir,
      pid: 4242,
      processToken: 123,
      startedAt: "2026-07-14T12:00:00.000Z",
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
    })).rejects.toThrow("run-start recovery record is malformed");
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
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid(pid) { terminated.push(pid); },
      },
    })).rejects.toMatchObject({ code: "ENOENT" });
    expect(terminated).toEqual([]);
  });

  it("escalates a live matching orphan cooperatively and then forcibly", async () => {
    const repo = await initRepo();
    const runId = "run-live-orphan-forced";
    const store = await createUnfinishedRun(runId, repo.commonDir, 4242, "darwin:start");
    const pipelineWorktree = await new WorktreeManager(
      repo.directory,
      `${runId}-pipeline`,
    ).create(repo.head);
    const events: string[] = [];

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return "darwin:start"; },
        async terminateProcessTreeByPid() { events.push("forced"); },
      },
      isProcessAlive: () => true,
      requestCooperativeTermination() { events.push("cooperative"); },
      async delayMs(ms) { events.push(`delay:${ms}`); },
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    expect(events).toEqual(["cooperative", "delay:3000", "forced"]);
    await expectMissing(pipelineWorktree.path);
    await expect(store.readResult(runId)).resolves.toMatchObject({
      evidence: { recovery: "startup-stale-run", escalation: "forced" },
    });
  });

  it("records cooperative recovery when an orphan exits during the grace period", async () => {
    const repo = await initRepo();
    const runId = "run-live-orphan-cooperative";
    const store = await createUnfinishedRun(runId, repo.commonDir, 4343, "darwin:start");
    const events: string[] = [];
    let alive = true;

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return "darwin:start"; },
        async terminateProcessTreeByPid() { events.push("forced"); },
      },
      isProcessAlive: () => alive,
      requestCooperativeTermination() { events.push("cooperative"); },
      async delayMs() { events.push("delay"); alive = false; },
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    expect(events).toEqual(["cooperative", "delay"]);
    await expect(store.readResult(runId)).resolves.toMatchObject({
      evidence: { recovery: "startup-stale-run", escalation: "cooperative" },
    });
  });

  it("reclaims token-mismatched live locks and preserves matching live locks", async () => {
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const mismatchedPath = path.join(locksRoot, `${"b".repeat(64)}.lock`);
    const matchingPath = path.join(locksRoot, `${"c".repeat(64)}.lock`);
    await mkdir(locksRoot, { recursive: true });
    await writeFile(mismatchedPath, JSON.stringify({ pid: 7001, processToken: "old" }));
    await writeFile(matchingPath, JSON.stringify({ pid: 7002, processToken: "live" }));

    await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken(pid) { return pid === 7001 ? "new" : "live"; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    });

    await expectMissing(mismatchedPath);
    await expect(readFile(matchingPath, "utf8")).resolves.toContain("\"processToken\":\"live\"");
  });

  it("accepts legacy bare-pid locks and reclaims only dead owners", async () => {
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    const deadPath = path.join(locksRoot, `${"d".repeat(64)}.lock`);
    const livePath = path.join(locksRoot, `${"e".repeat(64)}.lock`);
    await mkdir(locksRoot, { recursive: true });
    await writeFile(deadPath, "8001");
    await writeFile(livePath, "8002");

    await recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return "irrelevant"; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: pid => pid === 8002,
    });

    await expectMissing(deadPath);
    await expect(readFile(livePath, "utf8")).resolves.toBe("8002");
  });

  it("recovers state left under a stale plugin root", async () => {
    const repo = await initRepo();
    const runId = "run-stale-plugin-root";
    process.env.CLAUDE_PLUGIN_ROOT = path.join(await temporaryDirectory("old-plugin-root-"), "removed");
    const store = await createUnfinishedRun(runId, repo.commonDir, null);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId], quarantined: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "cancelled" });
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
        async getProcessStartToken() { return null; },
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
        async getProcessStartToken() { return null; },
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
        return { recovered: [], quarantined: [] };
      },
    });

    expect(serverEvents).toEqual(["recover", "connect"]);
  });
});
