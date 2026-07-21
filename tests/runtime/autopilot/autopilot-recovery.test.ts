import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowBranchManager,
  type RemoteTransport,
  type WorkflowBranchIdentity,
} from "../../../src/autopilot/branch-manager.js";
import type { AutopilotPhase, AutopilotWorkflowState } from "../../../src/autopilot/types.js";
import { WorkflowStore } from "../../../src/autopilot/workflow-store.js";
import { git } from "../../../src/git/git-exec.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";
import { recoverStaleRuns } from "../../../src/runtime/recovery-manager.js";

interface Fixture {
  root: string;
  repository: string;
  remote: string;
  branchManager: WorkflowBranchManager;
  branch: WorkflowBranchIdentity;
  store: WorkflowStore;
}

type ByteSnapshot = Array<{ name: string; bytes: string }>;

const temporaryPaths: string[] = [];
const savedEnvironment = new Map<string, string | undefined>();
let workflowSequence = 0;

const GIT_ENVIRONMENT_KEYS = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
] as const;
const CURRENT_PROCESS_TOKEN = "autopilot-recovery-current-process";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args, {
    env: {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function localTransport(remote: string): RemoteTransport {
  return {
    fetch: (cwd, _url, sourceRef, destinationRef) => git(cwd, [
      "fetch", "--no-tags", "--no-write-fetch-head", remote,
      `${sourceRef}:${destinationRef}`,
    ], {
      env: {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }),
    listHeads: cwd => git(cwd, ["ls-remote", "--heads", remote], {
      env: {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!,
        GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM!,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }),
  };
}

function initialState(branch: WorkflowBranchIdentity): AutopilotWorkflowState {
  return {
    stateVersion: "1",
    workflowId: branch.workflowId,
    repositoryIdentity: branch.repositoryIdentity,
    baseCommitOid: branch.baseCommitOid,
    workflowRef: branch.branchRef,
    worktreePath: branch.worktreePath,
    autopilotSpecHash: "2".repeat(64),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: [{
      id: "task-1",
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    }],
    intentJournal: { ref: "journal.ndjson", entryCount: 0, lastEntryHash: null },
    finalGate: null,
    shipping: {
      branch: branch.branch,
      prNumber: null,
      prUrl: null,
      ciDeadlineAt: "2026-07-21T20:00:00.000Z",
    },
    ciObservations: [],
    cleanup: null,
    terminal: null,
    createdAt: "2026-07-21T18:00:00.000Z",
    updatedAt: "2026-07-21T18:00:00.000Z",
  };
}

async function createFixture(options: { createState?: boolean } = {}): Promise<Fixture> {
  workflowSequence += 1;
  const root = await temporaryDirectory(`ca-autopilot-recovery-${workflowSequence}-`);
  const repository = path.join(root, "primary checkout");
  const remote = path.join(root, "remote.git");
  await mkdir(repository);
  await mkdir(remote);
  await runGit(repository, ["init", "-q", "-b", "main"]);
  await runGit(repository, ["config", "--local", "user.name", "Autopilot Recovery Test"]);
  await runGit(repository, ["config", "--local", "user.email", "recovery@example.invalid"]);
  await writeFile(path.join(repository, "tracked.txt"), "base\n");
  await runGit(repository, ["add", "-A"]);
  await runGit(repository, ["commit", "-q", "-m", "base"]);
  await runGit(remote, ["init", "--bare", "-q"]);
  await runGit(repository, ["push", remote, "refs/heads/main:refs/heads/main"]);
  await runGit(repository, [
    "config", "remote.origin.url", "https://github.com/example/project.git",
  ]);
  const workflowId = `workflow-recovery-${workflowSequence.toString().padStart(3, "0")}`;
  const selectedPlatform = getPlatformServices();
  const branchManager = new WorkflowBranchManager({
    remoteTransport: localTransport(remote),
    platformServices: {
      os: selectedPlatform.os,
      acquireCheckoutLock: selectedPlatform.acquireCheckoutLock.bind(selectedPlatform),
      canonicalizePath: selectedPlatform.canonicalizePath.bind(selectedPlatform),
      getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
    },
  });
  const branch = await branchManager.create({
    checkoutPath: await realpath(repository),
    workflowId,
    topic: "autopilot-recovery",
    remote: "origin",
    baseBranch: "main",
  });
  const store = new WorkflowStore(workflowId, {
    stateDirectory: process.env.CLAUDE_PLUGIN_DATA,
    now: () => "2026-07-21T18:01:00.000Z",
    getProcessStartToken: async pid => pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
  });
  if (options.createState !== false) {
    await store.create(initialState(branch));
    await store.acquireLease();
    await store.beginIntent({
      expectedRevision: 0,
      operation: "record-workflow-spec",
      idempotencyKey: "workflow-spec",
    });
    await store.completeIntent({
      expectedRevision: 0,
      idempotencyKey: "workflow-spec",
      completion: { spec: { version: "test" }, branch },
    });
  }
  return { root, repository, remote, branchManager, branch, store };
}

function ownershipPath(workflowId: string): string {
  return path.join(
    process.env.CLAUDE_PLUGIN_DATA!,
    "autopilot-branches",
    `${createHash("sha256").update(workflowId).digest("hex")}.json`,
  );
}

async function makeBootstrapOwnerDead(fixture: Fixture): Promise<void> {
  const filename = ownershipPath(fixture.branch.workflowId);
  const registration = JSON.parse(await readFile(filename, "utf8")) as {
    bootstrapOwner: { pid: number; processToken: string | null; createdAt: string };
  };
  registration.bootstrapOwner.pid = 900_001;
  registration.bootstrapOwner.processToken = "dead-bootstrap-token";
  await writeFile(filename, `${JSON.stringify(registration)}\n`);
}

async function makeLeaseDead(store: WorkflowStore): Promise<void> {
  await writeFile(store.ownerPath, `${JSON.stringify({
    workflowId: store.workflowId,
    pid: 900_002,
    processToken: "dead-lease-token",
    acquiredAt: "2026-07-21T17:00:00.000Z",
  })}\n`);
}

async function advanceToCleaningUp(store: WorkflowStore): Promise<AutopilotWorkflowState> {
  const phases: AutopilotPhase[] = [
    "running-task",
    "promoting-task",
    "final-review",
    "pushing",
    "creating-draft-pr",
    "waiting-required-checks",
    "marking-ready",
    "cleaning-up",
  ];
  let state = await store.read();
  for (const phase of phases) {
    state = await store.transition({ expectedRevision: state.revision, to: phase });
  }
  return await store.update({
    expectedRevision: state.revision,
    update(draft) {
      draft.finalGate = {
        reportRef: "reports/final.json",
        reportHash: "3".repeat(64),
        headCommitOid: draft.baseCommitOid,
        eligibilityHash: "4".repeat(64),
      };
    },
  });
}

async function snapshot(directory: string): Promise<ByteSnapshot> {
  const output: ByteSnapshot = [];
  async function visit(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolute, name);
      else output.push({ name, bytes: (await readFile(absolute)).toString("base64") });
    }
  }
  try {
    await visit(await realpath(directory), "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return output;
}

async function recoveryDependencies() {
  return {
    isProcessAlive: (pid: number) => pid === process.pid,
    platformServices: {
      os: getPlatformServices().os,
      getProcessStartToken: async (pid: number) =>
        pid === process.pid ? CURRENT_PROCESS_TOKEN : null,
      terminateProcessTreeByPid: async () => undefined,
    },
    git,
  };
}

beforeEach(async () => {
  workflowSequence = 0;
  for (const key of ["CLAUDE_PLUGIN_DATA", "CLAUDE_ARCHITECT_STATE_DIR", "NODE_ENV", ...GIT_ENVIRONMENT_KEYS]) {
    savedEnvironment.set(key, process.env[key]);
  }
  const stateRoot = await temporaryDirectory("ca-autopilot-recovery-state-");
  const globalConfig = path.join(stateRoot, "global.gitconfig");
  const systemConfig = path.join(stateRoot, "system.gitconfig");
  await writeFile(globalConfig, "");
  await writeFile(systemConfig, "");
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  process.env.NODE_ENV = "test";
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnvironment.clear();
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("autopilot startup recovery", () => {
  it("preserves a workflow byte-for-byte when an owner is live", async () => {
    const fixture = await createFixture();
    const before = await snapshot(fixture.store.workflowDirectory);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "live-preserve",
    }]);
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(before);
  });

  it("reports resume for a non-terminal workflow with dead owners and is byte-idempotent", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const afterFirst = await snapshot(fixture.store.workflowDirectory);
    const second = await recoverStaleRuns(await recoveryDependencies());

    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "resume",
    }]);
    expect(second.workflows).toEqual(first.workflows);
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(afterFirst);
  });

  it("finalizes observed cleanup and converges byte-idempotently", async () => {
    const fixture = await createFixture();
    const cleaning = await advanceToCleaningUp(fixture.store);
    await fixture.store.beginIntent({
      expectedRevision: cleaning.revision,
      operation: "cleanup-workflow-branch",
      idempotencyKey: `cleanup:${fixture.branch.baseCommitOid}`,
      expectedIdentities: { headCommitOid: fixture.branch.baseCommitOid },
    });
    await expect(fixture.branchManager.cleanup(fixture.branch, fixture.branch.baseCommitOid))
      .resolves.toEqual({ ok: true, worktreeRemoved: true, refsRemoved: true });
    await makeLeaseDead(fixture.store);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const afterFirst = await snapshot(fixture.store.workflowDirectory);
    const state = await fixture.store.read();
    const journal = await fixture.store.readIntentJournal();
    const second = await recoverStaleRuns(await recoveryDependencies());

    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "finalize",
    }]);
    expect(state).toMatchObject({
      phase: "ready-for-human-review",
      cleanup: { status: "succeeded", worktreeRemoved: true, lockReleased: true },
      terminal: { classification: "ready-for-human-review", reason: null },
    });
    expect(journal.intents.find(intent =>
      intent.intent.operation === "cleanup-workflow-branch")?.completion?.completion)
      .toEqual({ worktreeRemoved: true, refsRemoved: true });
    expect(second.workflows).toBeUndefined();
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(afterFirst);
  });

  it("disposes a dead bootstrap orphan and converges byte-idempotently", async () => {
    const fixture = await createFixture({ createState: false });
    await makeBootstrapOwnerDead(fixture);

    const first = await recoverStaleRuns(await recoveryDependencies());
    const afterFirst = await snapshot(process.env.CLAUDE_PLUGIN_DATA!);
    const second = await recoverStaleRuns(await recoveryDependencies());

    expect(first.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "dispose",
    }]);
    await expect(lstat(fixture.branch.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(ownershipPath(fixture.branch.workflowId)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(second.workflows).toBeUndefined();
    expect(await snapshot(process.env.CLAUDE_PLUGIN_DATA!)).toEqual(afterFirst);
  });

  it("fails closed when a non-terminal workflow has no lease", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await fixture.store.releaseLease();

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
  });

  it("fails closed when owner liveness is ambiguous", async () => {
    const fixture = await createFixture();
    await makeBootstrapOwnerDead(fixture);
    await writeFile(fixture.store.ownerPath, `${JSON.stringify({
      workflowId: fixture.store.workflowId,
      pid: process.pid,
      processToken: null,
      acquiredAt: "2026-07-21T17:00:00.000Z",
    })}\n`);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
  });

  it("does not infer cleanup success from the cleaning-up phase", async () => {
    const fixture = await createFixture();
    const cleaning = await advanceToCleaningUp(fixture.store);
    await fixture.store.beginIntent({
      expectedRevision: cleaning.revision,
      operation: "cleanup-workflow-branch",
      idempotencyKey: `cleanup:${fixture.branch.baseCommitOid}`,
      expectedIdentities: { headCommitOid: fixture.branch.baseCommitOid },
    });
    await makeBootstrapOwnerDead(fixture);
    await makeLeaseDead(fixture.store);
    const before = await snapshot(fixture.store.workflowDirectory);

    const result = await recoverStaleRuns(await recoveryDependencies());

    expect(result.workflows).toEqual([{
      workflowId: fixture.branch.workflowId,
      disposition: "human-decision-required",
    }]);
    await expect(lstat(fixture.branch.worktreePath)).resolves.toBeDefined();
    expect(await snapshot(fixture.store.workflowDirectory)).toEqual(before);
  });
});
