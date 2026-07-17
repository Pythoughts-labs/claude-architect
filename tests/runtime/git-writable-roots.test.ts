import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { resolveLinkedWorktreeWritableRoots } from "../../src/pipeline/git-writable-roots.js";
import { RuntimeError } from "../../src/util/errors.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe("resolveLinkedWorktreeWritableRoots", () => {
  it("resolves the private gitdir and shared objects directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-roots-"));
    temporaryPaths.push(root);
    const repo = path.join(root, "repo");
    const linked = path.join(root, "linked");
    await mkdir(repo);
    expect((await git(repo, ["init", "-q"])).exitCode).toBe(0);
    await writeFile(path.join(repo, "a.txt"), "a\n");
    expect((await git(repo, ["add", "a.txt"])).exitCode).toBe(0);
    expect((await git(repo, ["commit", "-q", "-m", "initial"])).exitCode).toBe(0);
    expect((await git(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"])).exitCode).toBe(0);

    // The resolver canonicalizes via realpath, so compare against realpath'd
    // expectations (git reports forward slashes; realpath is native-separator
    // on Windows).
    const privateGitDir = await realpath(
      (await git(linked, ["rev-parse", "--absolute-git-dir"])).stdout.trim());
    const commonGitDir = await realpath(
      (await git(linked, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
    await expect(resolveLinkedWorktreeWritableRoots(linked)).resolves.toEqual([
      privateGitDir,
      path.join(commonGitDir, "objects"),
    ]);
  });

  it("rejects a symlinked .git entry with a structured error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-roots-"));
    temporaryPaths.push(root);
    const worktree = path.join(root, "worktree");
    await mkdir(worktree);
    const pointer = path.join(root, "pointer");
    await writeFile(pointer, "gitdir: elsewhere\n");
    await symlink(pointer, path.join(worktree, ".git"));

    await expect(resolveLinkedWorktreeWritableRoots(worktree)).rejects.toMatchObject({
      name: "RuntimeError",
      detail: { classification: "sandbox-violation" },
    });
  });

  it("rejects a malformed commondir with a structured error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-roots-"));
    temporaryPaths.push(root);
    const worktree = path.join(root, "worktree");
    const gitDir = path.join(root, "common", "worktrees", "fix");
    await mkdir(worktree, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(path.join(gitDir, "commondir"), "\n");

    await expect(resolveLinkedWorktreeWritableRoots(worktree)).rejects.toBeInstanceOf(RuntimeError);
  });

  it("rejects a private git directory outside common worktrees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-git-roots-"));
    temporaryPaths.push(root);
    const worktree = path.join(root, "worktree");
    const commonDir = path.join(root, "common");
    const gitDir = path.join(root, "escaped");
    await mkdir(worktree);
    await mkdir(path.join(commonDir, "worktrees"), { recursive: true });
    await mkdir(path.join(commonDir, "objects"));
    await mkdir(gitDir);
    await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    await writeFile(path.join(gitDir, "commondir"), `${commonDir}\n`);

    await expect(resolveLinkedWorktreeWritableRoots(worktree)).rejects.toMatchObject({
      name: "RuntimeError",
      detail: { classification: "sandbox-violation" },
    });
  });
});
