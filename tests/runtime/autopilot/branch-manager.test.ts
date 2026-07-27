import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowBranchError,
  WorkflowBranchManager,
  type CreateWorkflowBranchRequest,
  type RemoteTransport,
  type WorkflowBranchBootstrapOwnerRecord,
  type WorkflowBranchIdentity,
} from "../../../src/autopilot/branch-manager.js";
import { git, type GitResult } from "../../../src/git/git-exec.js";
import { getPlatformServices } from "../../../src/platform/select-platform.js";

interface Fixture {
  repoRoot: string;
  bareRemote: string;
  baseOid: string;
  manager: WorkflowBranchManager;
  request: CreateWorkflowBranchRequest;
}

interface CheckoutSnapshot {
  head: string;
  symbolicHead: Pick<GitResult, "exitCode" | "stdout">;
  index: Buffer;
  trackedBytes: Buffer;
  status: string;
}

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousStateDirectory: string | undefined;
let previousNodeEnvironment: string | undefined;
let previousAmbientGitEnvironment = new Map<string, string>();
let fixtureSequence = 0;

const AMBIENT_GIT_ENVIRONMENT = /^(?:GIT_CONFIG_.*|GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|NAMESPACE))$/;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function localTransport(bareRemote: string): RemoteTransport {
  return {
    fetch: (cwd, canonicalUrl, sourceRef, destinationRef) => {
      if (canonicalUrl !== "https://github.com/example/project.git"
        || sourceRef !== "refs/heads/main"
        || !/^refs\/claude-architect\/autopilot\/[a-z0-9-]+\/fetch-[0-9a-f-]+$/.test(destinationRef)) {
        return Promise.resolve({ exitCode: 2, stdout: "", stderr: "unexpected fetch identity" });
      }
      return git(cwd, [
        "fetch", "--no-tags", "--no-write-fetch-head", bareRemote,
        `${sourceRef}:${destinationRef}`,
      ]);
    },
    listHeads: (cwd, canonicalUrl) => canonicalUrl === "https://github.com/example/project.git"
      ? git(cwd, ["ls-remote", "--heads", bareRemote])
      : Promise.resolve({ exitCode: 2, stdout: "", stderr: "unexpected remote identity" }),
  };
}

async function initFixture(options: {
  prefix?: string;
  objectFormat?: "sha1" | "sha256";
} = {}): Promise<Fixture | null> {
  fixtureSequence += 1;
  const root = await temporaryDirectory(options.prefix ?? "ca-branch-manager-");
  const repoRootPath = path.join(root, "primary checkout");
  const bareRemotePath = path.join(root, "remote repository.git");
  await mkdir(repoRootPath);
  const repoRoot = await realpath(repoRootPath);
  const initArgs = ["init", "-q", "-b", "main"];
  if (options.objectFormat === "sha256") initArgs.splice(1, 0, "--object-format=sha256");
  const initialized = await git(repoRoot, initArgs);
  if (initialized.exitCode !== 0 && options.objectFormat === "sha256") return null;
  expect(initialized.exitCode, initialized.stderr).toBe(0);
  await runGit(repoRoot, ["config", "--local", "user.name", "Branch Manager Test"]);
  await runGit(repoRoot, ["config", "--local", "user.email", "branch-manager@example.invalid"]);
  await writeFile(path.join(repoRoot, "tracked.txt"), "initial bytes\n");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  const baseOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const bareArgs = ["init", "--bare", "-q"];
  if (options.objectFormat === "sha256") bareArgs.splice(1, 0, "--object-format=sha256");
  await mkdir(bareRemotePath);
  const bareRemote = await realpath(bareRemotePath);
  await runGit(bareRemote, bareArgs);
  await runGit(repoRoot, ["push", bareRemote, "refs/heads/main:refs/heads/main"]);
  await runGit(repoRoot, ["config", "remote.origin.url", "https://github.com/Example/Project"]);
  const manager = new WorkflowBranchManager({ remoteTransport: localTransport(bareRemote) });
  return {
    repoRoot,
    bareRemote,
    baseOid,
    manager,
    request: {
      checkoutPath: repoRoot,
      workflowId: fixtureSequence === 1
        ? "0123456789abcdef"
        : `0123456789abcde${fixtureSequence.toString(16)}`,
      topic: "delegation-autopilot",
      remote: "origin",
      baseBranch: "main",
    },
  };
}

async function snapshotCheckout(repoRoot: string): Promise<CheckoutSnapshot> {
  const symbolicHead = await git(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return {
    head: await runGit(repoRoot, ["rev-parse", "HEAD"]),
    symbolicHead: { exitCode: symbolicHead.exitCode, stdout: symbolicHead.stdout },
    index: await readFile(path.join(repoRoot, ".git", "index")),
    trackedBytes: await readFile(path.join(repoRoot, "tracked.txt")),
    status: (await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout,
  };
}

async function expectCreateFailure(
  fixture: Fixture,
  classification: string,
  manager = fixture.manager,
): Promise<void> {
  const before = await snapshotCheckout(fixture.repoRoot);
  let caught: unknown;
  try {
    await manager.create(fixture.request);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowBranchError);
  expect((caught as WorkflowBranchError).classification).toBe(classification);
  expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
}

async function advanceRemote(fixture: Fixture): Promise<string> {
  const writer = await temporaryDirectory("ca-branch-remote-writer-");
  await runGit(writer, ["init", "-q", "-b", "writer-staging"]);
  await runGit(writer, ["config", "--local", "user.name", "Branch Manager Test"]);
  await runGit(writer, ["config", "--local", "user.email", "branch-manager@example.invalid"]);
  await runGit(writer, ["fetch", "-q", fixture.bareRemote, "refs/heads/main"]);
  await runGit(writer, ["checkout", "-q", "-b", "main", "FETCH_HEAD"]);
  await writeFile(path.join(writer, "remote.txt"), "remote advance\n");
  await runGit(writer, ["add", "-A"]);
  await runGit(writer, ["commit", "-q", "-m", "advance remote"]);
  await runGit(writer, ["push", fixture.bareRemote, "refs/heads/main:refs/heads/main"]);
  return runGit(writer, ["rev-parse", "HEAD"]);
}

beforeEach(async () => {
  fixtureSequence = 0;
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousStateDirectory = process.env.CLAUDE_ARCHITECT_STATE_DIR;
  previousNodeEnvironment = process.env.NODE_ENV;
  previousAmbientGitEnvironment = new Map(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => AMBIENT_GIT_ENVIRONMENT.test(entry[0])
        && entry[1] !== undefined,
    ),
  );
  for (const key of previousAmbientGitEnvironment.keys()) delete process.env[key];
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-branch-state-");
  const globalConfig = path.join(process.env.CLAUDE_PLUGIN_DATA, "global.gitconfig");
  const systemConfig = path.join(process.env.CLAUDE_PLUGIN_DATA, "system.gitconfig");
  await writeFile(globalConfig, "");
  await writeFile(systemConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  process.env.NODE_ENV = "test";
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousStateDirectory === undefined) delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
  else process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateDirectory;
  if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnvironment;
  for (const key of Object.keys(process.env)) {
    if (AMBIENT_GIT_ENVIRONMENT.test(key)) delete process.env[key];
  }
  for (const [key, value] of previousAmbientGitEnvironment) process.env[key] = value;
  await Promise.all(temporaryPaths.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("WorkflowBranchManager", () => {
  it("records the bootstrap owner in durable branch registration metadata", async () => {
    const fixture = (await initFixture())!;
    const beforeCreate = Date.now();

    const created = await fixture.manager.create(fixture.request);

    const ownershipName = createHash("sha256")
      .update(fixture.request.workflowId).digest("hex");
    const ownershipPath = path.join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "autopilot-branches",
      `${ownershipName}.json`,
    );
    const registration = JSON.parse(await readFile(ownershipPath, "utf8")) as {
      bootstrapOwner: WorkflowBranchBootstrapOwnerRecord;
    };
    expect(registration.bootstrapOwner).toEqual({
      workflowId: fixture.request.workflowId,
      pid: process.pid,
      processToken: await getPlatformServices().getProcessStartToken(process.pid),
      createdAt: expect.any(String),
    });
    expect(Date.parse(registration.bootstrapOwner.createdAt)).toBeGreaterThanOrEqual(beforeCreate);
    expect(Date.parse(registration.bootstrapOwner.createdAt)).toBeLessThanOrEqual(Date.now());
    await fixture.manager.cleanup(created);
  });

  it("reads a bootstrap owner from a durable branch registration", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    const recoveryManager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
    });

    const owner = await recoveryManager.readBootstrapOwner(fixture.request.workflowId);

    expect(owner).toEqual({
      workflowId: fixture.request.workflowId,
      pid: process.pid,
      processToken: await getPlatformServices().getProcessStartToken(process.pid),
      createdAt: expect.any(String),
    });
    await fixture.manager.cleanup(created);
  });

  it("removes the bootstrap owner with successful cleanup", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    await expect(fixture.manager.readBootstrapOwner(fixture.request.workflowId))
      .resolves.toBeDefined();

    await expect(fixture.manager.cleanup(created)).resolves.toMatchObject({ ok: true });

    await expect(fixture.manager.readBootstrapOwner(fixture.request.workflowId))
      .resolves.toBeNull();
  });

  it("derives a fresh branch and leaves the primary checkout untouched", async () => {
    const fixture = (await initFixture())!;
    const before = await snapshotCheckout(fixture.repoRoot);

    const created = await fixture.manager.create(fixture.request);

    expect(created.branch).toBe("feat/delegation-autopilot-01234567");
    expect(created.remoteUrl).toBe("https://github.com/example/project.git");
    expect(created.ownerRepo).toBe("example/project");
    expect(created.baseCommitOid).toBe(fixture.baseOid);
    expect(created.gitCommonDir).toBe(await realpath(path.join(fixture.repoRoot, ".git")));
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
    expect(await runGit(created.worktreePath, ["symbolic-ref", "--short", "HEAD"]))
      .toBe(created.branch);
    expect(await runGit(created.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.baseOid);
    await expect(fixture.manager.revalidate(created)).resolves.toEqual({ ok: true });
    await expect(fixture.manager.cleanup(created)).resolves.toEqual({
      ok: true,
      worktreeRemoved: true,
      refsRemoved: true,
    });
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
  });

  it.each(["stdout", "stderr"] as const)(
    "fails closed when successful git %s is truncated",
    async stream => {
      const fixture = (await initFixture())!;
      const created = await fixture.manager.create(fixture.request);
      const truncatingManager = new WorkflowBranchManager({
        remoteTransport: localTransport(fixture.bareRemote),
        git: async (cwd, args, options) => {
          const result = await git(cwd, args, options);
          if (args[0] !== "rev-parse" || args[1] !== "--verify" || args[2] !== "HEAD") {
            return result;
          }
          return {
            ...result,
            truncated: { stdout: stream === "stdout", stderr: stream === "stderr" },
          };
        },
      });

      await expect(truncatingManager.revalidate(created)).resolves.toEqual({
        ok: false,
        classification: "git-command-failed",
      });
      await fixture.manager.cleanup(created);
    },
  );

  it("preserves and supports a dirty primary checkout", async () => {
    const fixture = (await initFixture())!;
    await writeFile(path.join(fixture.repoRoot, "tracked.txt"), "human dirty bytes\n");
    await writeFile(path.join(fixture.repoRoot, "untracked.txt"), "human untracked bytes\n");
    const before = await snapshotCheckout(fixture.repoRoot);

    const created = await fixture.manager.create(fixture.request);

    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
    await fixture.manager.cleanup(created);
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
  });

  it("preserves and supports a detached primary checkout", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, ["checkout", "--detach", "-q", fixture.baseOid]);
    const before = await snapshotCheckout(fixture.repoRoot);

    const created = await fixture.manager.create(fixture.request);

    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
    await fixture.manager.cleanup(created);
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
  });

  it.each([
    ["http://github.com/example/project.git", "remote-url-not-https"],
    ["ssh://github.com/example/project.git", "remote-url-not-https"],
    ["https://gitlab.com/example/project.git", "remote-host-not-github"],
    ["https://user@github.com/example/project.git", "remote-url-has-credentials-or-suffix"],
    ["https://github.com/example/project.git?ref=x", "remote-url-has-credentials-or-suffix"],
    ["https://github.com/example/project.git#fragment", "remote-url-has-credentials-or-suffix"],
  ])("rejects untrusted remote URL %s", async (remoteUrl, classification) => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, ["config", "remote.origin.url", remoteUrl]);
    await expectCreateFailure(fixture, classification);
  });

  it("rejects push URL overrides", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, [
      "config", "remote.origin.pushurl", "https://github.com/example/other.git",
    ]);
    await expectCreateFailure(fixture, "remote-pushurl-configured");
  });

  it.each(["insteadOf", "pushInsteadOf"])("rejects url.%s rewrites", async rewriteName => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, [
      "config", `url.https://mirror.invalid/.${rewriteName}`, "https://github.com/",
    ]);
    await expectCreateFailure(fixture, "remote-url-rewrite-configured");
  });

  it("isolates network operations from a rewrite introduced after remote validation", async () => {
    const fixture = (await initFixture())!;
    const canonicalUrl = "https://github.com/example/project.git";
    let rewriteIntroduced = false;
    let isolatedNetworkOperations = 0;
    const isolatedRunner: typeof git = async (cwd, args, options) => {
      const remoteArgument = args.indexOf(canonicalUrl);
      if (remoteArgument !== -1) {
        expect(cwd).not.toBe(fixture.repoRoot);
        const rewrite = await git(cwd, [
          "config", "--local", "--get-regexp", "^url\\..*\\.insteadof$",
        ]);
        expect(rewrite.exitCode).toBe(1);
        isolatedNetworkOperations += 1;
        const localArgs = [...args];
        localArgs[remoteArgument] = fixture.bareRemote;
        return git(cwd, localArgs, options);
      }
      const result = await git(cwd, args, options);
      if (!rewriteIntroduced
        && cwd === fixture.repoRoot
        && args[0] === "config"
        && args.at(-1) === "remote.origin.url"
        && result.exitCode === 0) {
        await runGit(fixture.repoRoot, [
          "config", "url.file:///attacker/.insteadOf", "https://github.com/",
        ]);
        rewriteIntroduced = true;
      }
      return result;
    };
    const manager = new WorkflowBranchManager({ git: isolatedRunner });

    const created = await manager.create(fixture.request);

    expect(rewriteIntroduced).toBe(true);
    expect(isolatedNetworkOperations).toBe(3);
    await expect(manager.cleanup(created)).resolves.toMatchObject({ ok: true });
  });

  it("isolates the default transport from late inherited and conditional rewrites", async () => {
    const fixture = (await initFixture())!;
    const canonicalUrl = "https://github.com/example/project.git";
    const globalConfig = process.env.GIT_CONFIG_GLOBAL!;
    const systemConfig = process.env.GIT_CONFIG_SYSTEM!;
    const includedConfig = path.join(process.env.CLAUDE_PLUGIN_DATA!, "transport-include.gitconfig");
    const transportRoot = path.join(process.env.CLAUDE_PLUGIN_DATA!, "autopilot-remote");
    const gitConfigInclude = includedConfig.replaceAll("\\", "/");
    const gitConfigTransportRoot = transportRoot.replaceAll("\\", "/");
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    let rewriteIntroduced = false;
    let isolatedNetworkOperations = 0;
    const isolatedRunner: typeof git = async (cwd, args, options) => {
      const remoteArgument = args.indexOf(canonicalUrl);
      if (remoteArgument !== -1) {
        expect(cwd).not.toBe(fixture.repoRoot);
        expect(typeof options).toBe("object");
        const environment = typeof options === "object" ? options.env : undefined;
        expect(environment).toMatchObject({
          GIT_CONFIG_GLOBAL: nullDevice,
          GIT_CONFIG_SYSTEM: nullDevice,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "",
          HOME: cwd,
          XDG_CONFIG_HOME: cwd,
        });
        const rewrite = await git(cwd, [
          "config", "--includes", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$",
        ], options);
        expect(rewrite.exitCode, rewrite.stdout).toBe(1);
        isolatedNetworkOperations += 1;
        const localArgs = [...args];
        localArgs[remoteArgument] = fixture.bareRemote;
        return git(cwd, localArgs, options);
      }
      const result = await git(cwd, args, options);
      if (!rewriteIntroduced
        && cwd === fixture.repoRoot
        && args[0] === "config"
        && args.at(-1) === "remote.origin.url"
        && result.exitCode === 0) {
        await writeFile(includedConfig, [
          "[url \"file:///conditional-attacker/\"]",
          "\tinsteadOf = https://github.com/",
          "",
        ].join("\n"));
        await writeFile(globalConfig, [
          `[includeIf \"gitdir:${gitConfigTransportRoot}/**\"]`,
          `\tpath = ${gitConfigInclude}`,
          "[url \"file:///global-attacker/\"]",
          "\tinsteadOf = https://github.com/",
          "",
        ].join("\n"));
        await writeFile(systemConfig, [
          "[url \"file:///system-attacker/\"]",
          "\tpushInsteadOf = https://github.com/",
          "",
        ].join("\n"));
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.GIT_CONFIG_KEY_0 = "url.file:///command-attacker/.insteadOf";
        process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
        rewriteIntroduced = true;
      }
      return result;
    };
    const manager = new WorkflowBranchManager({ git: isolatedRunner });

    const created = await manager.create(fixture.request);

    expect(rewriteIntroduced).toBe(true);
    expect(isolatedNetworkOperations).toBe(3);
    expect(created.baseCommitOid).toBe(fixture.baseOid);
    await expect(manager.cleanup(created)).resolves.toMatchObject({ ok: true });
  });

  it("ignores hostile ambient Git configuration", async () => {
    const fixture = (await initFixture())!;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "url.file:///attacker/.insteadOf";
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";

    const created = await fixture.manager.create(fixture.request);

    await expect(fixture.manager.revalidate(created)).resolves.toEqual({ ok: true });
    await expect(fixture.manager.cleanup(created)).resolves.toMatchObject({ ok: true });
  });

  it("detects a remote identity change without mutating either checkout", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    const primaryBefore = await snapshotCheckout(fixture.repoRoot);
    await runGit(fixture.repoRoot, [
      "config", "remote.origin.url", "https://github.com/example/different.git",
    ]);

    await expect(fixture.manager.revalidate(created)).resolves.toEqual({
      ok: false,
      classification: "remote-identity-changed",
    });
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(primaryBefore);
  });

  it("rejects an existing local branch", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, [
      "branch", "feat/delegation-autopilot-01234567", fixture.baseOid,
    ]);
    await expectCreateFailure(fixture, "local-branch-exists");
  });

  it("rejects an existing remote branch", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.bareRemote, [
      "update-ref", "refs/heads/feat/delegation-autopilot-01234567", fixture.baseOid,
    ]);
    await expectCreateFailure(fixture, "remote-branch-exists");
  });

  it("rejects case-insensitive local branch collisions", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.repoRoot, [
      "branch", "Feat/Delegation-Autopilot-01234567", fixture.baseOid,
    ]);
    await expectCreateFailure(fixture, "local-branch-exists");
  });

  it("rejects case-insensitive remote branch collisions", async () => {
    const fixture = (await initFixture())!;
    await runGit(fixture.bareRemote, [
      "update-ref", "refs/heads/Feat/Delegation-Autopilot-01234567", fixture.baseOid,
    ]);
    await expectCreateFailure(fixture, "remote-branch-exists");
  });

  it("preserves a colliding linked worktree", async () => {
    const fixture = (await initFixture())!;
    const managedId = `workflow-${createHash("sha256")
      .update(fixture.request.workflowId).digest("hex").slice(0, 32)}`;
    const collision = path.join(process.env.CLAUDE_PLUGIN_DATA!, "worktrees", managedId);
    const sentinel = path.join(collision, "sentinel.txt");
    await mkdir(path.dirname(collision), { recursive: true });
    await runGit(fixture.repoRoot, ["worktree", "add", "--detach", collision, fixture.baseOid]);
    await writeFile(sentinel, "keep\n");
    const before = await snapshotCheckout(fixture.repoRoot);

    await expect(fixture.manager.create(fixture.request)).rejects.toThrow("git worktree add failed");

    await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
    expect((await git(fixture.repoRoot, [
      "show-ref", "--verify", "--quiet", "refs/heads/feat/delegation-autopilot-01234567",
    ])).exitCode).toBe(1);
  });

  it("rejects a checkout-lock repository identity mismatch", async () => {
    const fixture = (await initFixture())!;
    const selected = getPlatformServices();
    const manager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
      platformServices: {
        os: selected.os,
        canonicalizePath: input => selected.canonicalizePath(input),
        acquireCheckoutLock: async checkout => {
          const lock = await selected.acquireCheckoutLock(checkout);
          return { ...lock, repositoryIdentity: `${lock.repositoryIdentity}-changed` };
        },
      },
    });

    await expectCreateFailure(fixture, "repository-identity-mismatch", manager);
  });

  it("fails closed while the branch ref lock is held and removes its fetched ref", async () => {
    const fixture = (await initFixture())!;
    const lockPath = path.join(
      fixture.repoRoot,
      ".git",
      "refs",
      "heads",
      "feat",
      "delegation-autopilot-01234567.lock",
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "held\n");
    const before = await snapshotCheckout(fixture.repoRoot);

    await expect(fixture.manager.create(fixture.request)).rejects.toThrow("git create workflow refs failed");

    expect(await snapshotCheckout(fixture.repoRoot)).toEqual(before);
    expect((await git(fixture.repoRoot, [
      "for-each-ref", "--format=%(refname)",
      `refs/claude-architect/autopilot/${fixture.request.workflowId}/`,
    ])).stdout).toBe("");
  });

  it("rejects a stale fetched base", async () => {
    const fixture = (await initFixture())!;
    await advanceRemote(fixture);
    const staleTransport: RemoteTransport = {
      listHeads: cwd => git(cwd, ["ls-remote", "--heads", fixture.bareRemote]),
      fetch: (cwd, _url, _source, destination) => git(cwd, [
        "update-ref", destination, fixture.baseOid,
      ]),
    };
    const manager = new WorkflowBranchManager({ remoteTransport: staleTransport });

    await expectCreateFailure(fixture, "stale-fetched-base", manager);
  });

  it("supports SHA-256 object-format repositories when Git does", async () => {
    const fixture = await initFixture({ objectFormat: "sha256" });
    if (fixture === null) return;

    const created = await fixture.manager.create(fixture.request);

    expect(created.baseCommitOid).toMatch(/^[0-9a-f]{64}$/);
    expect(await runGit(created.worktreePath, ["rev-parse", "HEAD"])).toBe(created.baseCommitOid);
    await fixture.manager.cleanup(created);
  });

  it("supports repository and state paths containing spaces, Unicode, and newlines", async () => {
    const priorPluginData = process.env.CLAUDE_PLUGIN_DATA;
    const statePrefix = process.platform === "win32"
      ? "ca state ünicode space "
      : "ca state ünicode\nspace ";
    process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory(statePrefix);
    const fixture = (await initFixture({ prefix: "ca repo ünicode space " }))!;
    try {
      const created = await fixture.manager.create(fixture.request);
      expect(created.worktreePath).toContain(statePrefix);
      await expect(stat(created.worktreePath)).resolves.toBeDefined();
      await expect(fixture.manager.revalidate(created)).resolves.toEqual({ ok: true });
      await expect(fixture.manager.cleanup(created)).resolves.toEqual({
        ok: true,
        worktreeRemoved: true,
        refsRemoved: true,
      });
      await expect(stat(created.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await git(fixture.repoRoot, [
        "show-ref", "--verify", "--quiet", created.branchRef,
      ])).exitCode).toBe(1);
      expect((await git(fixture.repoRoot, [
        "show-ref", "--verify", "--quiet", created.baseRef,
      ])).exitCode).toBe(1);
      expect((await git(fixture.repoRoot, ["worktree", "list", "--porcelain", "-z"])).stdout)
        .not.toContain(created.worktreePath);
    } finally {
      process.env.CLAUDE_PLUGIN_DATA = priorPluginData;
    }
  });

  it("allows exactly one of two simultaneous creators to win", async () => {
    const fixture = (await initFixture())!;
    const first = new WorkflowBranchManager({ remoteTransport: localTransport(fixture.bareRemote) });
    const second = new WorkflowBranchManager({ remoteTransport: localTransport(fixture.bareRemote) });

    const results = await Promise.allSettled([
      first.create(fixture.request),
      second.create(fixture.request),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<WorkflowBranchIdentity> => result.status === "fulfilled",
    );
    const rejected = results.filter(result => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkflowBranchError);
    await fixture.manager.cleanup(fulfilled[0]!.value);
  });

  it("classifies worktree dirt, branch drift, operation state, and base drift without repairs", async () => {
    const fixture = (await initFixture())!;
    const dirty = await fixture.manager.create(fixture.request);
    await writeFile(path.join(dirty.worktreePath, "untracked.txt"), "dirty\n");
    await expect(fixture.manager.revalidate(dirty)).resolves.toEqual({
      ok: false,
      classification: "dirty-worktree",
    });
    await fixture.manager.cleanup(dirty);

    const secondFixture = (await initFixture())!;
    const branchDrift = await secondFixture.manager.create(secondFixture.request);
    await runGit(branchDrift.worktreePath, ["checkout", "--detach", "-q"]);
    await expect(secondFixture.manager.revalidate(branchDrift)).resolves.toEqual({
      ok: false,
      classification: "branch-changed",
    });

    const thirdFixture = (await initFixture())!;
    const headDrift = await thirdFixture.manager.create(thirdFixture.request);
    await writeFile(path.join(headDrift.worktreePath, "committed.txt"), "advance\n");
    await runGit(headDrift.worktreePath, ["add", "-A"]);
    await runGit(headDrift.worktreePath, ["commit", "-q", "-m", "advance"]);
    await expect(thirdFixture.manager.revalidate(headDrift)).resolves.toEqual({
      ok: false,
      classification: "head-changed",
    });

    const fourthFixture = (await initFixture())!;
    const operation = await fourthFixture.manager.create(fourthFixture.request);
    const gitDirectory = await runGit(operation.worktreePath, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(path.join(gitDirectory, "MERGE_HEAD"), operation.baseCommitOid);
    await expect(fourthFixture.manager.revalidate(operation)).resolves.toEqual({
      ok: false,
      classification: "in-progress-operation",
    });

    const fifthFixture = (await initFixture())!;
    const baseDrift = await fifthFixture.manager.create(fifthFixture.request);
    await advanceRemote(fifthFixture);
    await expect(fifthFixture.manager.revalidate(baseDrift)).resolves.toEqual({
      ok: false,
      classification: "remote-base-changed",
    });
  });

  it("revalidates ownership and remote identity without discarding staged recovery bytes", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    await writeFile(path.join(created.worktreePath, "tracked.txt"), "staged candidate bytes\n");
    await runGit(created.worktreePath, ["add", "tracked.txt"]);
    const lock = await getPlatformServices().acquireCheckoutLock(created.worktreePath);
    try {
      await expect(fixture.manager.revalidateForStagedPromotionUnderLock(
        created,
        created.baseCommitOid,
        lock,
      )).resolves.toEqual({ ok: true });

      await advanceRemote(fixture);
      await expect(fixture.manager.revalidateForStagedPromotionUnderLock(
        created,
        created.baseCommitOid,
        lock,
      )).resolves.toEqual({ ok: false, classification: "remote-base-changed" });

      expect(await readFile(path.join(created.worktreePath, "tracked.txt"), "utf8"))
        .toBe("staged candidate bytes\n");
      expect(await runGit(created.worktreePath, ["diff", "--cached", "--name-only"]))
        .toBe("tracked.txt");
    } finally {
      await lock.release();
    }
  });

  it("refuses cleanup when ownership identity is changed", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    const sentinel = path.join(created.worktreePath, "sentinel.txt");
    await writeFile(sentinel, "preserve\n");

    await expect(fixture.manager.cleanup({ ...created, branch: "feat/tampered" })).resolves.toEqual({
      ok: false,
      classification: "cleanup-failed",
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve\n");
  });

  it("resumes cleanup after refs fail once without touching an unowned path", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    let failRefRemoval = true;
    const cleanupManager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
      git: async (cwd, args, options) => {
        const stdin = typeof options === "object" ? options.stdin : undefined;
        if (failRefRemoval
          && args[0] === "update-ref"
          && stdin?.includes(`delete ${created.branchRef}`)) {
          failRefRemoval = false;
          return { exitCode: 1, stdout: "", stderr: "simulated ref lock" };
        }
        return git(cwd, args, options);
      },
    });

    await expect(cleanupManager.cleanup(created)).resolves.toEqual({
      ok: false,
      classification: "cleanup-failed",
    });
    await expect(stat(created.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cleanupManager.cleanup(created)).resolves.toEqual({
      ok: true,
      worktreeRemoved: false,
      refsRemoved: true,
    });
  });

  it("returns stable results when transport or lock release reports a failure", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    const rejectingTransport: RemoteTransport = {
      fetch: () => Promise.reject(new Error("unexpected fetch")),
      listHeads: () => Promise.reject(new Error("simulated transport rejection")),
    };
    const rejectingManager = new WorkflowBranchManager({ remoteTransport: rejectingTransport });
    await expect(rejectingManager.revalidate(created)).resolves.toEqual({
      ok: false,
      classification: "git-command-failed",
    });

    const selected = getPlatformServices();
    const releaseFailingManager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
      platformServices: {
        os: selected.os,
        canonicalizePath: input => selected.canonicalizePath(input),
        acquireCheckoutLock: async checkout => {
          const lock = await selected.acquireCheckoutLock(checkout);
          return {
            ...lock,
            release: async () => {
              await lock.release();
              throw new Error("simulated release report failure");
            },
          };
        },
      },
    });
    await expect(releaseFailingManager.revalidate(created)).resolves.toEqual({
      ok: false,
      classification: "git-command-failed",
    });
    await expect(releaseFailingManager.cleanup(created)).resolves.toEqual({
      ok: true,
      worktreeRemoved: true,
      refsRemoved: true,
    });
  });

  it("returns a durable identity when lock release reports failure after create", async () => {
    const fixture = (await initFixture())!;
    const selected = getPlatformServices();
    const manager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
      platformServices: {
        os: selected.os,
        canonicalizePath: input => selected.canonicalizePath(input),
        acquireCheckoutLock: async checkout => {
          const lock = await selected.acquireCheckoutLock(checkout);
          return {
            ...lock,
            release: async () => {
              await lock.release();
              throw new Error("simulated release report failure");
            },
          };
        },
      },
    });

    const created = await manager.create(fixture.request);

    await expect(fixture.manager.revalidate(created)).resolves.toEqual({ ok: true });
    await expect(fixture.manager.cleanup(created)).resolves.toMatchObject({ ok: true });
  });

  it("resumes cleanup after ownership removal fails after refs are gone", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    let failOwnershipRemoval = true;
    const manager = new WorkflowBranchManager({
      remoteTransport: localTransport(fixture.bareRemote),
      removeOwnership: ownershipPath => {
        if (failOwnershipRemoval) {
          failOwnershipRemoval = false;
          return Promise.reject(new Error("simulated ownership removal failure"));
        }
        return rm(ownershipPath);
      },
    });

    await expect(manager.cleanup(created)).resolves.toEqual({
      ok: false,
      classification: "cleanup-failed",
    });
    await expect(manager.cleanup(created)).resolves.toEqual({
      ok: true,
      worktreeRemoved: false,
      refsRemoved: false,
    });
  });

  it("removes an owned stale registration when its worktree directory disappeared", async () => {
    const fixture = (await initFixture())!;
    const created = await fixture.manager.create(fixture.request);
    await rm(created.worktreePath, { recursive: true });

    await expect(fixture.manager.cleanup(created)).resolves.toEqual({
      ok: true,
      worktreeRemoved: true,
      refsRemoved: true,
    });
    expect((await git(fixture.repoRoot, ["worktree", "list", "--porcelain"])).stdout)
      .not.toContain(created.worktreePath);
  });
});
