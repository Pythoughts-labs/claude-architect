import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { checkPreconditions } from "../../src/git/repo-preconditions.js";

const filesystemProbe = vi.hoisted(() => ({
  markerAccessErrorCode: undefined as string | undefined,
  opendirCalls: 0,
  removeAfterRealpath: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: async (...args: Parameters<typeof actual.access>) => {
      if (filesystemProbe.markerAccessErrorCode !== undefined
        && String(args[0]).endsWith("MERGE_HEAD")) {
        throw Object.assign(new Error("marker probe failed"), {
          code: filesystemProbe.markerAccessErrorCode,
        });
      }
      return actual.access(...args);
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      filesystemProbe.opendirCalls += 1;
      return actual.opendir(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      if (resolved === filesystemProbe.removeAfterRealpath) {
        filesystemProbe.removeAfterRealpath = undefined;
        await actual.rm(resolved);
      }
      return resolved;
    },
  };
});

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix = "ca-repo-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function initRepo(): Promise<string> {
  const directory = await temporaryDirectory();
  await runGit(directory, ["init", "-q"]);
  await writeFile(join(directory, "a.txt"), "hello\n");
  await runGit(directory, ["add", "-A"]);
  await runGit(directory, ["commit", "-q", "-m", "init"]);
  return directory;
}

afterEach(async () => {
  filesystemProbe.markerAccessErrorCode = undefined;
  filesystemProbe.opendirCalls = 0;
  filesystemProbe.removeAfterRealpath = undefined;
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("checkPreconditions", () => {
  it("accepts a clean repository with a commit", async () => {
    const directory = await initRepo();

    const result = await checkPreconditions(directory);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseCommitOid).toMatch(/^[0-9a-f]{40}$/);
      expect(result.gitCommonDir).toBe(await realpath(join(directory, ".git")));
    }
  });

  it("rejects a bare repository", async () => {
    const directory = await temporaryDirectory("ca-bare-");
    await runGit(directory, ["init", "--bare", "-q"]);

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "bare-repository" });
  });

  it("rejects an unborn repository", async () => {
    const directory = await temporaryDirectory();
    await runGit(directory, ["init", "-q"]);

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "unborn-repository" });
  });

  it("rejects an in-progress operation", async () => {
    const directory = await initRepo();
    const gitDirectory = await runGit(directory, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(join(gitDirectory, "MERGE_HEAD"), "0000000000000000000000000000000000000000\n");

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "in-progress-operation" });
  });

  it("rejects revert and sequencer operation state", async () => {
    const revertDirectory = await initRepo();
    const revertGitDirectory = await runGit(revertDirectory, ["rev-parse", "--absolute-git-dir"]);
    await writeFile(join(revertGitDirectory, "REVERT_HEAD"), "0".repeat(40));
    await expect(checkPreconditions(revertDirectory)).resolves.toEqual({
      ok: false,
      reason: "in-progress-operation",
    });

    const sequencerDirectory = await initRepo();
    const sequencerGitDirectory = await runGit(sequencerDirectory, [
      "rev-parse",
      "--absolute-git-dir",
    ]);
    await mkdir(join(sequencerGitDirectory, "sequencer"));
    await expect(checkPreconditions(sequencerDirectory)).resolves.toEqual({
      ok: false,
      reason: "in-progress-operation",
    });
  });

  it("fails closed when an in-progress marker cannot be scanned", async () => {
    const directory = await initRepo();
    filesystemProbe.markerAccessErrorCode = "EACCES";

    await expect(checkPreconditions(directory)).resolves.toEqual({
      ok: false,
      reason: "in-progress-operation-scan-failed",
    });
  });

  it("rejects a dirty checkout", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, "a.txt"), "changed\n");

    await expect(checkPreconditions(directory)).resolves.toEqual({
      ok: false,
      reason: "dirty-checkout",
      detail: [" M a.txt"],
    });
  });

  it("names the dirty paths when the checkout is dirty", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, "untracked-file.txt"), "x");

    const result = await checkPreconditions(directory);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("dirty-checkout");
    expect(result.detail).toEqual(["?? untracked-file.txt"]);
  });

  it("bounds dirty path detail", async () => {
    const directory = await initRepo();
    await Promise.all(Array.from(
      { length: 22 },
      (_, index) => writeFile(join(directory, `untracked-${String(index).padStart(2, "0")}.txt`), "x"),
    ));

    const result = await checkPreconditions(directory);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toEqual([
      ...Array.from(
        { length: 20 },
        (_, index) => `?? untracked-${String(index).padStart(2, "0")}.txt`,
      ),
      "… and 2 more",
    ]);
  });

  it("rejects sparse checkout", async () => {
    const directory = await initRepo();
    await runGit(directory, ["config", "core.sparseCheckout", "true"]);

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "sparse-checkout" });
  });

  it("rejects a changed submodule", async () => {
    const submoduleSource = await initRepo();
    const directory = await initRepo();
    await runGit(directory, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSource, "dependency"]);
    await runGit(directory, ["commit", "-q", "-am", "add submodule"]);
    const submoduleCheckout = join(directory, "dependency");
    await writeFile(join(submoduleCheckout, "a.txt"), "new submodule commit\n");
    await runGit(submoduleCheckout, ["add", "-A"]);
    await runGit(submoduleCheckout, ["commit", "-q", "-m", "advance"]);

    await expect(checkPreconditions(directory)).resolves.toEqual({
      ok: false,
      reason: "changed-submodule",
      detail: [expect.stringContaining(" dependency ")],
    });
  }, 15_000);

  it("rejects uncommitted changes inside a submodule", async () => {
    const submoduleSource = await initRepo();
    const directory = await initRepo();
    await runGit(directory, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submoduleSource,
      "dependency",
    ]);
    await runGit(directory, ["commit", "-q", "-am", "add submodule"]);
    await writeFile(join(directory, "dependency", "a.txt"), "dirty submodule\n");

    await expect(checkPreconditions(directory)).resolves.toEqual({
      ok: false,
      reason: "dirty-checkout",
      detail: [" M dependency"],
    });
  }, 15_000);

  it("rejects a write allowlist that enters a registered submodule", async () => {
    const submoduleSource = await initRepo();
    const directory = await initRepo();
    await runGit(directory, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submoduleSource,
      "dependency",
    ]);
    await runGit(directory, ["commit", "-q", "-am", "add submodule"]);

    await expect(checkPreconditions(directory, {
      writeAllowlist: ["dependency/**"],
    })).resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["dependency"] });
  }, 15_000);

  it("rejects skip-worktree and assume-unchanged index entries", async () => {
    const skipWorktreeRepo = await initRepo();
    await runGit(skipWorktreeRepo, ["update-index", "--skip-worktree", "a.txt"]);
    await expect(checkPreconditions(skipWorktreeRepo)).resolves.toEqual({ ok: false, reason: "skip-worktree-entries" });

    const assumeUnchangedRepo = await initRepo();
    await runGit(assumeUnchangedRepo, ["update-index", "--assume-unchanged", "a.txt"]);
    await expect(checkPreconditions(assumeUnchangedRepo)).resolves.toEqual({ ok: false, reason: "skip-worktree-entries" });
  });

  it("rejects a nested repository only when the write allowlist overlaps", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, ".gitignore"), "nested/\n");
    await runGit(directory, ["add", ".gitignore"]);
    await runGit(directory, ["commit", "-q", "-m", "ignore nested test repository"]);
    const nested = join(directory, "nested");
    await mkdir(nested);
    await runGit(nested, ["init", "-q"]);

    await expect(checkPreconditions(directory)).resolves.toMatchObject({ ok: true });
    await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] })).resolves.toMatchObject({ ok: true });
    await expect(checkPreconditions(directory, { writeAllowlist: ["nested/file.txt"] })).resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["nested"] });
    await expect(checkPreconditions(directory, { writeAllowlist: ["nested/*"] })).resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["nested"] });
    await expect(checkPreconditions(directory, { writeAllowlist: ["**/*.txt"] })).resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["nested"] });
  });

  it.skipIf(process.platform === "win32")("rejects a filesystem symlink in write scope", async () => {
    const directory = await initRepo();
    const external = await temporaryDirectory("ca-symlink-target-");
    await writeFile(join(external, "outside.txt"), "outside\n");
    await symlink(external, join(directory, "linked"), "dir");
    await runGit(directory, ["add", "linked"]);
    await runGit(directory, ["commit", "-q", "-m", "add linked directory"]);

    await expect(checkPreconditions(directory)).resolves.toMatchObject({ ok: true });
    await expect(checkPreconditions(directory, {
      writeAllowlist: ["src/**"],
    })).resolves.toMatchObject({ ok: true });
    await expect(checkPreconditions(directory, {
      writeAllowlist: ["linked/**"],
    })).resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["linked"] });
  });

  it.skipIf(process.platform === "win32")("accepts a tracked symlink to a contained regular file in primary and linked worktrees", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, "CHANGELOG.md"), "release notes\n");
    await mkdir(join(directory, "src", "package"), { recursive: true });
    await symlink("../../CHANGELOG.md", join(directory, "src", "package", "CHANGELOG.md"), "file");
    await runGit(directory, ["add", "CHANGELOG.md", "src/package/CHANGELOG.md"]);
    await runGit(directory, ["commit", "-q", "-m", "add packaged changelog link"]);

    await expect(checkPreconditions(directory, {
      writeAllowlist: ["src/**"],
    })).resolves.toMatchObject({ ok: true });

    const base = await runGit(directory, ["rev-parse", "HEAD"]);
    const linked = await temporaryDirectory("ca-symlink-linked-");
    await rm(linked, { recursive: true, force: true });
    await runGit(directory, ["worktree", "add", "--detach", "-q", linked, base]);
    try {
      await expect(checkPreconditions(linked, {
        writeAllowlist: ["src/**"],
      })).resolves.toMatchObject({ ok: true, baseCommitOid: base });
    } finally {
      await runGit(directory, ["worktree", "remove", "--force", linked]);
    }
  });

  it.skipIf(process.platform === "win32")("rejects a tracked absolute symlink to a regular file in the same checkout", async () => {
    const directory = await initRepo();
    const target = join(directory, "target.txt");
    await writeFile(target, "target\n");
    await symlink(target, join(directory, "absolute-link"), "file");
    await runGit(directory, ["add", "absolute-link", "target.txt"]);
    await runGit(directory, ["commit", "-q", "-m", "add absolute file link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["absolute-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["absolute-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked relative symlink that resolves through an absolute symlink", async () => {
    const directory = await initRepo();
    const target = join(directory, "target.txt");
    await writeFile(target, "target\n");
    await symlink(target, join(directory, "absolute-link"), "file");
    await symlink("absolute-link", join(directory, "outer-link"), "file");
    await runGit(directory, ["add", "absolute-link", "outer-link", "target.txt"]);
    await runGit(directory, ["commit", "-q", "-m", "add chained file links"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["outer-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["outer-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked symlink to a contained directory", async () => {
    const directory = await initRepo();
    await mkdir(join(directory, "shared"));
    await mkdir(join(directory, "src"));
    await symlink("../shared", join(directory, "src", "shared"), "dir");
    await runGit(directory, ["add", "src/shared"]);
    await runGit(directory, ["commit", "-q", "-m", "add directory link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["src/shared"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked symlink to an external regular file", async () => {
    const directory = await initRepo();
    const external = await temporaryDirectory("ca-symlink-file-target-");
    await writeFile(join(external, "outside.txt"), "outside\n");
    await symlink(join(external, "outside.txt"), join(directory, "outside-link"), "file");
    await runGit(directory, ["add", "outside-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add external file link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["outside-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["outside-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a broken tracked symlink", async () => {
    const directory = await initRepo();
    await symlink("missing.txt", join(directory, "broken-link"), "file");
    await runGit(directory, ["add", "broken-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add broken link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["broken-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["broken-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a cyclic tracked symlink", async () => {
    const directory = await initRepo();
    await symlink("cyclic-link", join(directory, "cyclic-link"), "file");
    await runGit(directory, ["add", "cyclic-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add cyclic link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["cyclic-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["cyclic-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked symlink with a non-directory target component", async () => {
    const directory = await initRepo();
    await symlink("a.txt/child", join(directory, "not-directory-link"), "file");
    await runGit(directory, ["add", "not-directory-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add non-directory link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["not-directory-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["not-directory-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects an ignored untracked symlink to a contained regular file", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, ".gitignore"), "ignored-link\n");
    await writeFile(join(directory, "target.txt"), "target\n");
    await runGit(directory, ["add", ".gitignore", "target.txt"]);
    await runGit(directory, ["commit", "-q", "-m", "prepare ignored link"]);
    await symlink("target.txt", join(directory, "ignored-link"), "file");

    await expect(checkPreconditions(directory, { writeAllowlist: ["ignored-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["ignored-link"] });
  });

  it.skipIf(process.platform === "win32")("does not confuse a literal backslash with a path separator", async () => {
    const directory = await initRepo();
    await writeFile(join(directory, ".gitignore"), "a/b\n");
    await writeFile(join(directory, "target.txt"), "target\n");
    await symlink("target.txt", join(directory, "a\\b"), "file");
    await runGit(directory, ["add", "-A"]);
    await runGit(directory, ["commit", "-q", "-m", "add literal backslash link"]);

    await mkdir(join(directory, "a"));
    await symlink("../target.txt", join(directory, "a", "b"), "file");

    await expect(checkPreconditions(directory, { writeAllowlist: ["a/b"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["a/b"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked symlink to Git metadata", async () => {
    const directory = await initRepo();
    await symlink(".git/config", join(directory, "git-config-link"), "file");
    await runGit(directory, ["add", "git-config-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add Git metadata link"]);

    await expect(checkPreconditions(directory, { writeAllowlist: ["git-config-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["git-config-link"] });
  });

  it.skipIf(process.platform === "win32")("rejects a tracked symlink to a linked worktree's .git file", async () => {
    const directory = await initRepo();
    const base = await runGit(directory, ["rev-parse", "HEAD"]);
    const linked = await temporaryDirectory("ca-git-link-worktree-");
    await rm(linked, { recursive: true, force: true });
    await runGit(directory, ["worktree", "add", "--detach", "-q", linked, base]);
    try {
      await symlink(".git", join(linked, "git-link"), "file");
      await runGit(linked, ["add", "git-link"]);
      await runGit(linked, ["commit", "-q", "-m", "add git metadata link"]);

      await expect(checkPreconditions(linked, { writeAllowlist: ["git-link"] }))
        .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["git-link"] });
    } finally {
      await runGit(directory, ["worktree", "remove", "--force", linked]);
    }
  });

  it.skipIf(process.platform === "win32")("fails closed when a tracked symlink target cannot be resolved", async () => {
    const directory = await initRepo();
    const targetDirectory = join(directory, "unreadable-target");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "target.txt"), "target\n");
    await writeFile(join(directory, ".gitignore"), "unreadable-target/\n");
    await symlink("unreadable-target/target.txt", join(directory, "unreadable-link"), "file");
    await runGit(directory, ["add", ".gitignore", "unreadable-link"]);
    await runGit(directory, ["commit", "-q", "-m", "add unreadable link"]);
    await chmod(targetDirectory, 0o000);

    try {
      await expect(checkPreconditions(directory, { writeAllowlist: ["unreadable-link"] }))
        .resolves.toEqual({ ok: false, reason: "nested-repository-scan-failed" });
    } finally {
      await chmod(targetDirectory, 0o700);
    }
  });

  it.skipIf(process.platform === "win32")("fails closed when a symlink target disappears after resolution", async () => {
    const directory = await initRepo();
    const target = join(directory, "race-target.txt");
    await writeFile(target, "target\n");
    await symlink("race-target.txt", join(directory, "race-link"), "file");
    await runGit(directory, ["add", "race-link", "race-target.txt"]);
    await runGit(directory, ["commit", "-q", "-m", "add race link"]);
    filesystemProbe.removeAfterRealpath = await realpath(target);

    await expect(checkPreconditions(directory, { writeAllowlist: ["race-link"] }))
      .resolves.toEqual({ ok: false, reason: "nested-repository-scan-failed" });
    expect(filesystemProbe.removeAfterRealpath).toBeUndefined();
  });

  it("streams nested-repository discovery with opendir", async () => {
    const directory = await initRepo();

    await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] })).resolves.toMatchObject({
      ok: true,
    });

    expect(filesystemProbe.opendirCalls).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("does not scan an unreadable ignored directory outside the write allowlist", async () => {
    const directory = await initRepo();
    const unreadable = join(directory, "ignored");
    await writeFile(join(directory, ".gitignore"), "ignored/\n");
    await runGit(directory, ["add", ".gitignore"]);
    await runGit(directory, ["commit", "-q", "-m", "ignore unreadable directory"]);
    await mkdir(unreadable);
    await chmod(unreadable, 0o000);

    try {
      await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] })).resolves.toMatchObject({ ok: true });
    } finally {
      await chmod(unreadable, 0o700);
    }
  });

  it.skipIf(process.platform === "win32")("fails closed when a relevant nested-repository branch cannot be scanned", async () => {
    const directory = await initRepo();
    const unreadable = join(directory, "src", "ignored");
    await writeFile(join(directory, ".gitignore"), "src/ignored/\n");
    await runGit(directory, ["add", ".gitignore"]);
    await runGit(directory, ["commit", "-q", "-m", "ignore unreadable source directory"]);
    await mkdir(unreadable, { recursive: true });
    await chmod(unreadable, 0o000);

    try {
      await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] })).resolves.toEqual({
        ok: false,
        reason: "nested-repository-scan-failed",
      });
    } finally {
      await chmod(unreadable, 0o700);
    }
  });

  it("fails closed when nested-repository discovery exceeds its directory-entry budget", async () => {
    const directory = await initRepo();
    const generated = join(directory, "src", "generated");
    await writeFile(join(directory, ".gitignore"), "src/generated/\n");
    await runGit(directory, ["add", ".gitignore"]);
    await runGit(directory, ["commit", "-q", "-m", "ignore generated source directory"]);
    await mkdir(generated, { recursive: true });
    for (let offset = 0; offset < 10_001; offset += 250) {
      await Promise.all(Array.from(
        { length: Math.min(250, 10_001 - offset) },
        (_, index) => writeFile(join(generated, `entry-${offset + index}.txt`), ""),
      ));
    }

    await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] })).resolves.toEqual({
      ok: false,
      reason: "nested-repository-scan-failed",
    });
  }, 60_000);

  it("supports detached HEAD", async () => {
    const directory = await initRepo();
    const base = await runGit(directory, ["rev-parse", "HEAD"]);
    await runGit(directory, ["checkout", "--detach", "-q", base]);

    await expect(checkPreconditions(directory)).resolves.toMatchObject({ ok: true, baseCommitOid: base });
  });

  it("supports existing linked worktrees", async () => {
    const directory = await initRepo();
    const base = await runGit(directory, ["rev-parse", "HEAD"]);
    const linked = await temporaryDirectory("ca-linked-");
    await rm(linked, { recursive: true, force: true });
    await runGit(directory, ["worktree", "add", "--detach", "-q", linked, base]);
    try {
      await expect(checkPreconditions(directory)).resolves.toMatchObject({ ok: true, baseCommitOid: base });
    } finally {
      await runGit(directory, ["worktree", "remove", "--force", linked]);
    }
  });

  it("supports Git LFS pointer blobs", async () => {
    const directory = await initRepo();
    await runGit(directory, ["config", "filter.lfs.clean", "cat"]);
    await runGit(directory, ["config", "filter.lfs.smudge", "cat"]);
    await writeFile(join(directory, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(join(directory, "asset.bin"), [
      "version https://git-lfs.github.com/spec/v1",
      "oid sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "size 1",
      "",
    ].join("\n"));
    await runGit(directory, ["add", ".gitattributes", "asset.bin"]);
    await runGit(directory, ["commit", "-q", "-m", "add lfs pointer"]);

    await expect(checkPreconditions(directory)).resolves.toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === "win32")("supports a repository reached through a symlink", async () => {
    const directory = await initRepo();
    const base = await runGit(directory, ["rev-parse", "HEAD"]);
    const aliasRoot = await temporaryDirectory("ca-alias-");
    const alias = join(aliasRoot, "repo-alias");
    await symlink(directory, alias, "dir");

    const result = await checkPreconditions(alias);

    expect(result).toEqual({
      ok: true,
      baseCommitOid: base,
      gitCommonDir: await realpath(join(directory, ".git")),
    });
  });
});
