import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import { applyCandidateTree } from "../../src/integrate/controlled-integrator.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";

const temporaryPaths: string[] = [];
const originalPluginData = process.env.CLAUDE_PLUGIN_DATA;
const integrationHooks = vi.hoisted(() => ({
  beforeReadTree: undefined as (() => Promise<void>) | undefined,
  afterReadTree: undefined as (() => Promise<void>) | undefined,
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
      const result = await actual.git(...args);
      if (args[1][0] === "read-tree" && args[1].includes("-m")
        && integrationHooks.afterReadTree !== undefined) {
        const hook = integrationHooks.afterReadTree;
        integrationHooks.afterReadTree = undefined;
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
  if (originalPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = originalPluginData;
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
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

  it("rolls back when post-apply status reveals untracked divergence", async () => {
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

    expect(result).toEqual({ integration: "aborted", detail: "post-apply-sanity-failed" });
    expect(await readFile(path.join(f.repoRoot, "a.txt"), "utf8")).toBe("base\n");
    expect(await readFile(path.join(f.repoRoot, "external.txt"), "utf8")).toBe(
      "racing untracked file\n",
    );
    expect(await runGit(f.repoRoot, ["rev-parse", artifact.anchorRef])).toBe(
      artifact.candidateCommitOid,
    );
  });
});
