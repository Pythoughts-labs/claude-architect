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
import { buildRunManifest } from "../../src/runtime/run-manifest.js";

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

function slicedManagedIds(runId: string): string[] {
  return [
    `${runId}-slice-1-attempt-0`,
    `${runId}-slice-1-attempt-0-review`,
    `${runId}-slice-1-attempt-0-verify`,
    `verify-${runId}-slice-1-attempt-0-pipeline`,
    `${runId}-composed-review`,
    `${runId}-final-verify`,
    `verify-${runId}-final-pipeline`,
  ];
}

async function createManagedWorktrees(
  repo: { directory: string; head: string },
  managedIds: string[],
): Promise<Array<{ path: string; cleanup(): Promise<void> }>> {
  const worktrees: Array<{ path: string; cleanup(): Promise<void> }> = [];
  for (const managedId of managedIds) {
    worktrees.push(await new WorktreeManager(repo.directory, managedId).create(repo.head));
  }
  return worktrees;
}

async function writeTerminalFailure(store: ArtifactStore, runId: string): Promise<void> {
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
}

async function writeVerifiedCandidate(
  store: ArtifactStore,
  runId: string,
  repo: { directory: string; head: string },
): Promise<void> {
  const tree = await runGit(repo.directory, ["rev-parse", `${repo.head}^{tree}`]);
  const manifestHash = createHash("sha256").update("[]").digest("hex");
  const anchorRef = `refs/claude-architect/candidates/${runId}`;
  await runGit(repo.directory, ["update-ref", anchorRef, repo.head]);
  await store.writeResult({
    resultVersion: "1",
    runId,
    status: "verified-candidate",
    failure: null,
    summary: "candidate produced and independently verified",
    producerSummary: "test producer",
    candidate: {
      baseCommitOid: repo.head,
      candidateTreeOid: tree,
      candidateCommitOid: repo.head,
      anchorRef,
      manifestHash,
      changedPaths: [],
      patch: "",
    },
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "stub",
    producerVersion: "1",
    producerModel: null,
    durationMs: 1,
    sessionId: null,
  });
  await store.writeManifest(buildRunManifest({
    runId,
    repoRoot: repo.directory,
    baseCommitOid: repo.head,
    candidateManifestHash: manifestHash,
    producer: { id: "stub", version: "1", model: null },
    effectivePolicy: { isolation: "temporary-home", retries: 0 },
    repositoryInstructions: [],
    prompt: "test",
    executionPolicy: { network: "denied", writeAllowlist: ["**"] },
    environment: [],
    packagedVerifier: { version: "1", content: "test" },
  }));
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
  it("downgrades a verified candidate before clearing a dead sliced pipeline marker", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-pipeline-authority";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: true,
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "failed",
      failure: "verification-failure",
      candidate: expect.any(Object),
      unresolvedIssues: ["pipeline-interrupted-before-terminal-cleanup"],
      evidence: {
        pipelineRecovery: "interrupted-before-terminal-cleanup",
      },
    });
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
  });

  it("preserves a verified candidate while clearing a dead non-sliced pipeline marker", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-non-sliced-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "verified-candidate",
      failure: null,
    });
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
  });

  it("treats a legacy pipeline marker as non-sliced during recovery", async () => {
    const repo = await initRepo();
    const runId = "run-interrupted-legacy-pipeline";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeVerifiedCandidate(store, runId, repo);
    await writeFile(path.join(store.runDirectory, "pipeline-active.json"), `${JSON.stringify({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
    })}\n`);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({
      status: "verified-candidate",
      failure: null,
    });
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
  });

  it("cleans every sliced worktree and ref for a terminal run without touching a prefix neighbor", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-terminal";
    const neighborRunId = `${runId}-neighbor`;
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    await writeTerminalFailure(store, runId);
    const slicedWorktrees = await createManagedWorktrees(repo, slicedManagedIds(runId));
    const neighborWorktree = (await createManagedWorktrees(
      repo,
      [`${neighborRunId}-slice-1-attempt-0`],
    ))[0]!;
    const sliceRefs = [
      `refs/claude-architect/slices/${runId}/slice-1-attempt-1`,
      `refs/claude-architect/slices/${runId}/slice-2-attempt-0`,
    ];
    const neighborRef = `refs/claude-architect/slices/${neighborRunId}/slice-1-attempt-0`;
    for (const ref of [...sliceRefs, neighborRef]) {
      await runGit(repo.directory, ["update-ref", ref, repo.head]);
    }
    await store.writePipelineActiveMarker({
      pid: 4242,
      processToken: "darwin:dead",
      startedAt: "2026-07-18T12:00:00.000Z",
      sliced: true,
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    await Promise.all(slicedWorktrees.map(worktree => expectMissing(worktree.path)));
    await expect(access(neighborWorktree.path)).resolves.toBeUndefined();
    for (const ref of sliceRefs) {
      expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", ref])).exitCode)
        .not.toBe(0);
    }
    expect(await runGit(repo.directory, ["rev-parse", neighborRef])).toBe(repo.head);
    await expectMissing(path.join(store.runDirectory, "pipeline-active.json"));
    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });
    await expect(access(neighborWorktree.path)).resolves.toBeUndefined();
    expect(await runGit(repo.directory, ["rev-parse", neighborRef])).toBe(repo.head);
  }, { timeout: 120_000 });

  it("waits for the checkout lease and preserves a run that completes while waiting", async () => {
    const repo = await initRepo();
    const runId = "run-completes-while-lease-waits";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
        async acquireCheckoutLock() {
          // The producer reaches a terminal result while recovery waits for the
          // lease; recovery must observe it and leave the run untouched.
          await writeTerminalFailure(store, runId);
          return { key: "test", repositoryIdentity: repo.commonDir, async release() {} };
        },
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "failed" });
  });

  it("preserves an unfinished run when its marker becomes live while the lease waits", async () => {
    const repo = await initRepo();
    const runId = "run-marker-live-while-lease-waits";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return "darwin:live"; },
        async terminateProcessTreeByPid() {},
        async acquireCheckoutLock() {
          await store.writePipelineActiveMarker({
            pid: 9191,
            processToken: "darwin:live",
            startedAt: "2026-07-18T12:00:00.000Z",
            sliced: false,
          });
          return { key: "test", repositoryIdentity: repo.commonDir, async release() {} };
        },
      },
      isProcessAlive: pid => pid === 9191,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("preserves a replacement live run-start owner installed while the lease waits", async () => {
    const repo = await initRepo();
    const runId = "run-replacement-owner-while-lease-waits";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const lockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const runStartPath = path.join(store.runDirectory, "run-start.json");

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return "darwin:new-owner"; },
        async terminateProcessTreeByPid() {},
        async acquireCheckoutLock() {
          // A fresh, live owner claims the same run while we wait for the lease.
          await writeFile(runStartPath, `${JSON.stringify({
            runId,
            lockKey,
            canonicalCommonDir: repo.commonDir,
            pid: 7373,
            processToken: "darwin:new-owner",
            startedAt: "2026-07-18T12:30:00.000Z",
          })}\n`);
          return { key: "test", repositoryIdentity: repo.commonDir, async release() {} };
        },
      },
      isProcessAlive: pid => pid === 7373,
    })).resolves.toEqual({ recovered: [] });

    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("exposes both recovery and release failures and releases exactly once", async () => {
    const repo = await initRepo();
    const runId = "run-recovery-and-release-fail";
    await createUnfinishedRun(runId, repo.commonDir, null);
    let releases = 0;

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
        async acquireCheckoutLock() {
          return {
            key: "test",
            repositoryIdentity: "/identity/that/does/not/match",
            async release() { releases += 1; throw new Error("release boom"); },
          };
        },
      },
      isProcessAlive: () => false,
    })).rejects.toThrow(AggregateError);

    expect(releases).toBe(1);
  });

  it("fails visibly when the acquired checkout identity differs", async () => {
    const repo = await initRepo();
    const runId = "run-lease-identity-differs";
    await createUnfinishedRun(runId, repo.commonDir, null);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
        async acquireCheckoutLock() {
          return {
            key: "test",
            repositoryIdentity: "/identity/that/does/not/match",
            async release() {},
          };
        },
      },
      isProcessAlive: () => false,
    })).rejects.toThrow("checkout lease repository identity changed during recovery");
  });

  it("preserves a malformed lock during the broad reclaim sweep", async () => {
    // No stale runs: exercise only the end-of-recovery broad lock sweep.
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    await mkdir(locksRoot, { recursive: true });
    const strayLock = path.join(locksRoot, `${"de".repeat(32)}.lock`);
    await writeFile(strayLock, "not-json-not-a-pid");

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

    // A lock whose owner cannot be parsed is never unlinked blindly.
    await expect(access(strayLock)).resolves.toBeUndefined();
  });

  it("refuses to unlink a malformed exact lock and fails closed", async () => {
    const repo = await initRepo();
    const runId = "run-malformed-exact-lock";
    await createUnfinishedRun(runId, repo.commonDir, null);
    const locksRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "locks");
    await mkdir(locksRoot, { recursive: true });
    // The exact checkout lock key for this run carries unparseable bytes.
    const exactLockKey = createHash("sha256").update(repo.commonDir).digest("hex");
    const exactLock = path.join(locksRoot, `${exactLockKey}.lock`);
    await writeFile(exactLock, "not-json-not-a-pid");

    // reclaimExactLock refuses to remove it, so the checkout lease cannot be
    // acquired — recovery fails closed rather than force-clearing the lock.
    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).rejects.toThrow("checkout is locked");

    await expect(access(exactLock)).resolves.toBeUndefined();
  });

  it("cleans every sliced worktree and ref for an unfinished run idempotently", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-unfinished";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const slicedWorktrees = await createManagedWorktrees(repo, slicedManagedIds(runId));
    const sliceRefs = [
      `refs/claude-architect/slices/${runId}/slice-1-attempt-1`,
      `refs/claude-architect/slices/${runId}/slice-2-attempt-0`,
    ];
    for (const ref of sliceRefs) await runGit(repo.directory, ["update-ref", ref, repo.head]);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [runId] });

    await Promise.all(slicedWorktrees.map(worktree => expectMissing(worktree.path)));
    for (const ref of sliceRefs) {
      expect((await git(repo.directory, ["rev-parse", "--verify", "--quiet", ref])).exitCode)
        .not.toBe(0);
    }
    await expect(store.readResult(runId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });
  }, { timeout: 120_000 });

  it("fails closed on a malformed ref inside the run-specific slice namespace", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-malformed-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const malformedRef = `refs/claude-architect/slices/${runId}/unexpected`;
    await runGit(repo.directory, ["update-ref", malformedRef, repo.head]);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).rejects.toThrow("temporary slice ref name is malformed during recovery");

    expect(await runGit(repo.directory, ["rev-parse", malformedRef])).toBe(repo.head);
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("fails closed when a slice ref points to a tag that peels to a commit", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-tag-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["tag", "-a", "slice-tag", "-m", "slice tag", repo.head]);
    const tagOid = await runGit(repo.directory, ["rev-parse", "refs/tags/slice-tag"]);
    await runGit(repo.directory, ["update-ref", sliceRef, tagOid]);

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).rejects.toThrow("temporary slice ref does not identify a commit during recovery");

    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(tagOid);
    await expect(store.readResult(runId)).resolves.toBeNull();
  });

  it("rejects a non-commit slice ref even when a replacement object spoofs its type", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-replacement-spoof";
    await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    const treeOid = await runGit(repo.directory, ["rev-parse", `${repo.head}^{tree}`]);
    await runGit(repo.directory, ["update-ref", sliceRef, treeOid]);
    await runGit(repo.directory, ["update-ref", `refs/replace/${treeOid}`, repo.head]);
    expect(await runGit(repo.directory, ["cat-file", "-t", treeOid])).toBe("commit");

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).rejects.toThrow("temporary slice ref does not identify a commit during recovery");

    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(treeOid);
  });

  it("disables replacement objects only for temporary-ref object type validation", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-no-replace-scope";
    await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["update-ref", sliceRef, repo.head]);
    const observed: Array<{ command: string; noReplace: string | undefined }> = [];

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
      git: async (cwd, args, options) => {
        observed.push({
          command: args[0] ?? "",
          noReplace: typeof options === "object"
            ? options.env?.GIT_NO_REPLACE_OBJECTS
            : undefined,
        });
        return git(cwd, args, options);
      },
    })).resolves.toEqual({ recovered: [runId] });

    expect(observed.filter(call => call.command === "cat-file"))
      .toEqual([{ command: "cat-file", noReplace: "1" }]);
    expect(observed.filter(call => call.command !== "cat-file").every(
      call => call.noReplace === undefined,
    )).toBe(true);
  });

  it("fails closed when a slice ref moves after recovery enumeration", async () => {
    const repo = await initRepo();
    const runId = "run-sliced-moved-ref";
    const store = await createUnfinishedRun(runId, repo.commonDir, null);
    const sliceRef = `refs/claude-architect/slices/${runId}/slice-2-attempt-0`;
    await runGit(repo.directory, ["update-ref", sliceRef, repo.head]);
    const movedOid = await runGit(repo.directory, [
      "commit-tree",
      `${repo.head}^{tree}`,
      "-p",
      repo.head,
      "-m",
      "moved slice ref",
    ]);
    let moved = false;

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
      git: async (cwd, args, options) => {
        const result = await git(cwd, args, options);
        if (!moved && args[0] === "for-each-ref") {
          moved = true;
          await runGit(repo.directory, ["update-ref", sliceRef, movedOid, repo.head]);
        }
        return result;
      },
    })).rejects.toThrow("temporary slice ref moved during recovery");

    expect(await runGit(repo.directory, ["rev-parse", sliceRef])).toBe(movedOid);
    await expect(store.readResult(runId)).resolves.toBeNull();
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
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => false,
    })).resolves.toEqual({ recovered: [] });

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
      sliced: false,
    });

    await expect(recoverStaleRuns({
      platformServices: {
        os: "darwin",
        async getProcessStartToken() { return null; },
        async terminateProcessTreeByPid() {},
      },
      isProcessAlive: () => true,
    })).resolves.toEqual({ recovered: [] });

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

    expect(result).toEqual({ recovered: [runId] });
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
    })).resolves.toEqual({ recovered: [] });
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

    expect(result).toEqual({ recovered: [runId] });
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
        async getProcessStartToken() { return null; },
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
    })).resolves.toEqual({ recovered: [runId] });

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
    })).resolves.toEqual({ recovered: [runId] });

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
    })).resolves.toEqual({ recovered: [runId] });

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
        return { recovered: [] };
      },
    });

    expect(serverEvents).toEqual(["recover", "connect"]);
  });
});
