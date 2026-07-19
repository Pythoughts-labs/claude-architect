import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import { applyCandidateTree } from "../../src/integrate/controlled-integrator.js";
import type { CheckoutLock, PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";

const temporaryPaths: string[] = [];
const originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
const integrationHooks = vi.hoisted(() => ({
  beforeReadTree: undefined as (() => Promise<void>) | undefined,
  afterReadTree: undefined as (() => Promise<void>) | undefined,
  afterWorktreeDiff: undefined as (() => Promise<void>) | undefined,
  beforeAnchorDelete: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("../../src/git/git-exec.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/git/git-exec.js")>();
  return {
    ...actual,
    git: async (...args: Parameters<typeof actual.git>) => {
      if (args[1][0] === "read-tree" && args[1].includes("-m")
        && integrationHooks.beforeReadTree !== undefined) {
        const hook = integrationHooks.beforeReadTree;
        integrationHooks.beforeReadTree = undefined;
        await hook();
      }
      if (args[1][0] === "update-ref" && args[1].includes("-d")
        && integrationHooks.beforeAnchorDelete !== undefined) {
        const hook = integrationHooks.beforeAnchorDelete;
        integrationHooks.beforeAnchorDelete = undefined;
        await hook();
      }
      const result = await actual.git(...args);
      if (args[1][0] === "read-tree" && args[1].includes("-m")
        && integrationHooks.afterReadTree !== undefined) {
        const hook = integrationHooks.afterReadTree;
        integrationHooks.afterReadTree = undefined;
        await hook();
      }
      if (args[1][0] === "diff" && args[1].includes("--quiet")
        && integrationHooks.afterWorktreeDiff !== undefined) {
        const hook = integrationHooks.afterWorktreeDiff;
        integrationHooks.afterWorktreeDiff = undefined;
        await hook();
      }
      return result;
    },
  };
});

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function fixture(files: Record<string, string | Buffer> = { "a.txt": "base\n" }): Promise<{
  root: string;
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "ca-controlled-integrator-"));
  temporaryPaths.push(root);
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "state");
  const repoRoot = path.join(root, "repo");
  const worktreePath = path.join(root, "candidate");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  for (const [relativePath, contents] of Object.entries(files)) {
    const destination = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "base"]);
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, ["worktree", "add", "--detach", "-q", worktreePath, baseCommitOid]);
  return { root, repoRoot, worktreePath, baseCommitOid };
}

async function freeze(f: Awaited<ReturnType<typeof fixture>>, runId: string): Promise<CandidateArtifact> {
  const frozen = await freezeCandidate({
    repoRoot: f.repoRoot,
    worktreePath: f.worktreePath,
    baseCommitOid: f.baseCommitOid,
    runId,
    writeAllowlist: ["**"],
    forbiddenScope: [],
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(frozen.reason);
  return frozen.artifact;
}

afterEach(async () => {
  integrationHooks.beforeReadTree = undefined;
  integrationHooks.afterReadTree = undefined;
  integrationHooks.afterWorktreeDiff = undefined;
  integrationHooks.beforeAnchorDelete = undefined;
  if (originalPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("applyCandidateTree", () => {
  it("applies the exact candidate tree to the index and working tree", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "apply-modification");

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result.integration).toBe("applied");
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("candidate\n");
    expect(await runGit(f.repoRoot, ["diff", "--cached", "--name-status"])).toBe("M\ta.txt");
    expect(await runGit(f.repoRoot, ["rev-parse", "HEAD"])).toBe(f.baseCommitOid);
    const anchor = await git(f.repoRoot, ["show-ref", "--verify", artifact.anchorRef]);
    expect(anchor.exitCode).not.toBe(0);
  });

  it("acquires and releases one identity-bound lease for standalone integration", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "standalone-lock-ownership");
    const platformServices = getPlatformServices();
    let held = false;
    let acquireCalls = 0;
    let releaseCalls = 0;
    let applyObserved = false;
    const ps = Object.assign(Object.create(platformServices), {
      async acquireCheckoutLock(checkout: string): Promise<CheckoutLock> {
        acquireCalls += 1;
        const lock = await platformServices.acquireCheckoutLock(checkout);
        held = true;
        return {
          ...lock,
          async release() {
            expect(held).toBe(true);
            releaseCalls += 1;
            await lock.release();
            held = false;
          },
        };
      },
    }) as PlatformServices;
    integrationHooks.beforeReadTree = async () => {
      expect(held).toBe(true);
      applyObserved = true;
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
      platformServices: ps,
    });

    expect(result.integration).toBe("applied");
    expect(acquireCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(applyObserved).toBe(true);
    expect(held).toBe(false);
  });

  it("borrows the exact lease through preconditions, apply, postconditions, and anchor deletion", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "borrowed-lock-lifecycle");
    const platformServices = getPlatformServices();
    const ownerLock = await platformServices.acquireCheckoutLock(f.repoRoot);
    let held = true;
    let canonicalizeCalls = 0;
    let nestedAcquireCalls = 0;
    let borrowedReleaseCalls = 0;
    const borrowedCheckoutLock: CheckoutLock = {
      ...ownerLock,
      async release() {
        borrowedReleaseCalls += 1;
        held = false;
        await ownerLock.release();
      },
    };
    const ps = Object.assign(Object.create(platformServices), {
      async canonicalizePath(input: string) {
        expect(held).toBe(true);
        canonicalizeCalls += 1;
        return platformServices.canonicalizePath(input);
      },
      async acquireCheckoutLock(): Promise<CheckoutLock> {
        nestedAcquireCalls += 1;
        throw new Error("borrowed integration acquired a nested checkout lease");
      },
    }) as PlatformServices;
    const stages: string[] = [];
    integrationHooks.beforeReadTree = async () => {
      expect(held).toBe(true);
      stages.push("apply");
    };
    integrationHooks.afterWorktreeDiff = async () => {
      expect(held).toBe(true);
      stages.push("post-apply");
    };
    integrationHooks.beforeAnchorDelete = async () => {
      expect(held).toBe(true);
      stages.push("anchor-delete");
    };

    try {
      const result = await applyCandidateTree({
        repoRoot: f.repoRoot,
        artifact,
        expectedArtifactHash: artifact.manifestHash,
        borrowedCheckoutLock,
        platformServices: ps,
      });

      expect(result.integration).toBe("applied");
      expect(held).toBe(true);
      expect(canonicalizeCalls).toBe(1);
      expect(nestedAcquireCalls).toBe(0);
      expect(borrowedReleaseCalls).toBe(0);
      expect(stages).toEqual(["apply", "post-apply", "anchor-delete"]);
    } finally {
      if (held) {
        held = false;
        await ownerLock.release();
      }
    }
  }, { timeout: 10_000 });

  it("rejects a borrowed lease for another repository before integration preconditions", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "borrowed-lock-mismatch");
    const platformServices = getPlatformServices();
    const canonical = await platformServices.canonicalizePath(f.repoRoot);
    let canonicalizeCalls = 0;
    let acquireCalls = 0;
    let releaseCalls = 0;
    const ps = Object.assign(Object.create(platformServices), {
      async canonicalizePath(input: string) {
        canonicalizeCalls += 1;
        return platformServices.canonicalizePath(input);
      },
      async acquireCheckoutLock(): Promise<CheckoutLock> {
        acquireCalls += 1;
        throw new Error("borrowed integration acquired a nested checkout lease");
      },
    }) as PlatformServices;
    const borrowedCheckoutLock: CheckoutLock = {
      key: "wrong-repository-lock",
      repositoryIdentity: `${canonical.gitCommonDir ?? canonical.canonical}-other-repository`,
      async release() { releaseCalls += 1; },
    };
    let thrown: unknown;

    try {
      await applyCandidateTree({
        repoRoot: f.repoRoot,
        artifact,
        expectedArtifactHash: artifact.manifestHash,
        borrowedCheckoutLock,
        platformServices: ps,
      });
    } catch (error) {
      thrown = error;
    }

    expect.soft(thrown).toMatchObject({
      message: "borrowed checkout lease repository identity mismatch",
    });
    expect.soft(canonicalizeCalls).toBe(1);
    expect.soft(acquireCalls).toBe(0);
    expect.soft(releaseCalls).toBe(0);
    await expect(readFile(path.join(f.repoRoot, "a.txt"), "utf8")).resolves.toBe("base\n");
    await expect(runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).resolves.toBe(
      artifact.candidateCommitOid,
    );
  });

  it.each(["aborted", "conflicted", "thrown"] as const)(
    "leaves borrowed lease ownership with the caller on a %s path",
    async outcome => {
      const f = await fixture();
      await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
      const artifact = await freeze(f, `borrowed-lock-${outcome}`);
      const platformServices = getPlatformServices();
      const canonical = await platformServices.canonicalizePath(f.repoRoot);
      let held = true;
      let canonicalizeCalls = 0;
      let acquireCalls = 0;
      let releaseCalls = 0;
      const ps = Object.assign(Object.create(platformServices), {
        async canonicalizePath(input: string) {
          expect(held).toBe(true);
          canonicalizeCalls += 1;
          return platformServices.canonicalizePath(input);
        },
        async acquireCheckoutLock(): Promise<CheckoutLock> {
          acquireCalls += 1;
          throw new Error("borrowed integration acquired a nested checkout lease");
        },
      }) as PlatformServices;
      const borrowedCheckoutLock: CheckoutLock = {
        key: `borrowed-${outcome}`,
        repositoryIdentity: canonical.gitCommonDir ?? canonical.canonical,
        async release() {
          releaseCalls += 1;
          held = false;
        },
      };
      if (outcome === "conflicted") {
        integrationHooks.beforeReadTree = async () => {
          expect(held).toBe(true);
          await writeFile(path.join(f.repoRoot, "a.txt"), "racing edit\n");
        };
      } else if (outcome === "thrown") {
        integrationHooks.beforeReadTree = async () => {
          expect(held).toBe(true);
          throw new Error("integration hook failed");
        };
      }

      const applying = applyCandidateTree({
        repoRoot: f.repoRoot,
        artifact,
        expectedArtifactHash: outcome === "aborted" ? "f".repeat(64) : artifact.manifestHash,
        borrowedCheckoutLock,
        platformServices: ps,
      });
      if (outcome === "aborted") {
        await expect(applying).resolves.toEqual({
          integration: "aborted",
          detail: "artifact-hash-mismatch",
        });
      } else if (outcome === "conflicted") {
        await expect(applying).resolves.toEqual({
          integration: "conflicted",
          detail: "candidate-apply-conflict",
        });
      } else {
        await expect(applying).rejects.toThrow("integration hook failed");
      }
      expect.soft(canonicalizeCalls).toBe(1);
      expect.soft(acquireCalls).toBe(0);
      expect.soft(releaseCalls).toBe(0);
      expect.soft(held).toBe(true);
    },
  );

  it("materializes LF bytes exactly when repository autocrlf is enabled", async () => {
    const f = await fixture();
    const candidateBytes = Buffer.from("candidate\n");
    await writeFile(path.join(f.worktreePath, "a.txt"), candidateBytes);
    const artifact = await freeze(f, "apply-autocrlf");
    await runGit(f.repoRoot, ["config", "core.autocrlf", "true"]);

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result.integration).toBe("applied");
    expect(await readFile(path.join(f.repoRoot, "a.txt"))).toEqual(candidateBytes);
  });

  it("applies a deletion and leaves it staged", async () => {
    const f = await fixture({ "a.txt": "keep\n", "delete.txt": "remove\n" });
    await rm(path.join(f.worktreePath, "delete.txt"));
    const artifact = await freeze(f, "apply-deletion");

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result.integration).toBe("applied");
    await expect(readFile(path.join(f.repoRoot, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runGit(f.repoRoot, ["diff", "--cached", "--name-status"])).toBe("D\tdelete.txt");
  });

  it.skipIf(process.platform === "win32")("applies binary bytes and an executable mode change faithfully", async () => {
    const f = await fixture({
      "a.txt": "base\n",
      "binary.dat": Buffer.from([0, 1, 2, 3]),
      "script.sh": "#!/bin/sh\nexit 0\n",
    });
    await runGit(f.repoRoot, ["config", "core.filemode", "true"]);
    await runGit(f.worktreePath, ["config", "core.filemode", "true"]);
    const candidateBytes = Buffer.from([0, 255, 10, 13, 99]);
    await writeFile(path.join(f.worktreePath, "binary.dat"), candidateBytes);
    await chmod(path.join(f.worktreePath, "script.sh"), 0o755);
    const artifact = await freeze(f, "apply-binary-mode");

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result.integration).toBe("applied");
    expect(await readFile(path.join(f.repoRoot, "binary.dat"))).toEqual(candidateBytes);
    expect((await stat(path.join(f.repoRoot, "script.sh"))).mode & 0o111).toBe(0o111);
    expect(await runGit(f.repoRoot, ["diff", "--cached", "--name-status"])).toBe(
      "M\tbinary.dat\nM\tscript.sh",
    );
  });

  it("refuses a stale base without mutating the checkout", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "stale-base");
    await writeFile(path.join(f.repoRoot, "advance.txt"), "advanced\n");
    await runGit(f.repoRoot, ["add", "advance.txt"]);
    await runGit(f.repoRoot, ["commit", "-q", "-m", "advance"]);

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "aborted", detail: "base-changed" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await runGit(f.repoRoot, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a wrong expected artifact hash without mutating the checkout", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "wrong-hash");

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: "f".repeat(64),
    });

    expect(result).toEqual({ integration: "aborted", detail: "artifact-hash-mismatch" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await runGit(f.repoRoot, ["status", "--porcelain"])).toBe("");
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("refuses a dirty checkout and preserves its untracked file", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "dirty-checkout");
    await writeFile(path.join(f.repoRoot, "external.txt"), "external\n");

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({
      integration: "aborted",
      detail: "precondition-failed:dirty-checkout",
    });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await readFile(path.join(f.repoRoot, "external.txt"), "utf8")).toBe("external\n");
  });

  it("refuses a moved anchor without mutating the checkout", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "moved-anchor");
    await runGit(f.repoRoot, ["update-ref", artifact.anchorRef, f.baseCommitOid]);

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "aborted", detail: "candidate-anchor-mismatch" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await runGit(f.repoRoot, ["status", "--porcelain"])).toBe("");
  });

  it("refuses a candidate tree that does not match the anchored commit", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "wrong-tree");
    const baseTree = await runGit(f.repoRoot, ["rev-parse", `${f.baseCommitOid}^{tree}`]);

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact: { ...artifact, candidateTreeOid: baseTree },
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "aborted", detail: "candidate-tree-mismatch" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await runGit(f.repoRoot, ["status", "--porcelain"])).toBe("");
  });

  it("recomputes the artifact manifest from the immutable candidate tree", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "tampered-manifest");
    const changedPaths = artifact.changedPaths.map(change => ({
      ...change,
      contentHash: "f".repeat(40),
    }));

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact: { ...artifact, changedPaths },
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "aborted", detail: "artifact-identity-mismatch" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("reports a read-tree conflict without overwriting a racing checkout edit", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "read-tree-conflict");
    integrationHooks.beforeReadTree = async () => {
      await writeFile(path.join(f.repoRoot, "a.txt"), "racing edit\n");
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "conflicted", detail: "candidate-apply-conflict" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("racing edit\n");
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("preserves applied and racing files when post-apply status diverges", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "post-apply-divergence");
    integrationHooks.afterReadTree = async () => {
      await writeFile(path.join(f.repoRoot, "external.txt"), "racing untracked file\n");
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "conflicted", detail: "post-apply-divergence" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("candidate\n");
    expect(await readFile(path.join(f.repoRoot, "external.txt"), "utf8")).toBe(
      "racing untracked file\n",
    );
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("does not rewind a racing commit after the candidate tree is applied", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "racing-commit");
    integrationHooks.afterReadTree = async () => {
      await writeFile(path.join(f.repoRoot, "racing.txt"), "racing commit\n");
      await runGit(f.repoRoot, ["add", "racing.txt"]);
      await runGit(f.repoRoot, ["commit", "-q", "-m", "racing commit"]);
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "conflicted", detail: "post-apply-divergence" });
    expect(await runGit(f.repoRoot, ["rev-parse", "HEAD"])).not.toBe(f.baseCommitOid);
    expect(await readFile(path.join(f.repoRoot, "racing.txt"), "utf8")).toBe("racing commit\n");
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("detects a tracked race after the worktree diff check", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "late-tracked-race");
    integrationHooks.afterWorktreeDiff = async () => {
      await writeFile(path.join(f.repoRoot, "a.txt"), "late racing edit\n");
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result).toEqual({ integration: "conflicted", detail: "post-apply-divergence" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("late racing edit\n");
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });

  it("reports an applied tree when compare-and-delete anchor cleanup fails", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "anchor-cleanup-failure");
    integrationHooks.beforeAnchorDelete = async () => {
      await runGit(f.repoRoot, ["update-ref", artifact.anchorRef, f.baseCommitOid]);
    };

    const result = await applyCandidateTree({
      repoRoot: f.repoRoot,
      artifact,
      expectedArtifactHash: artifact.manifestHash,
    });

    expect(result.integration).toBe("applied");
    expect(result.detail).toContain("candidate anchor delete failed");
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("candidate\n");
  });

  it.skipIf(process.platform === "win32")("reports an applied tree when lock cleanup fails", async () => {
    const f = await fixture();
    await writeFile(path.join(f.worktreePath, "a.txt"), "candidate\n");
    const artifact = await freeze(f, "lock-cleanup-failure");
    const lockDirectory = path.join(f.root, "state", "locks");
    integrationHooks.afterReadTree = async () => {
      await chmod(lockDirectory, 0o500);
    };

    let result;
    try {
      result = await applyCandidateTree({
        repoRoot: f.repoRoot,
        artifact,
        expectedArtifactHash: artifact.manifestHash,
      });
    } finally {
      await chmod(lockDirectory, 0o700);
    }

    expect(result.integration).toBe("applied");
    expect(result.detail).toContain("checkout lock release failed");
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("candidate\n");
    const anchor = await git(f.repoRoot, ["show-ref", "--verify", artifact.anchorRef]);
    expect(anchor.exitCode).not.toBe(0);
  });
});
