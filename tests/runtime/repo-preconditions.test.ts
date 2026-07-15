import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "../../src/git/git-exec.js";
import { checkPreconditions } from "../../src/git/repo-preconditions.js";

const filesystemProbe = vi.hoisted(() => ({
  markerAccessErrorCode: undefined as string | undefined,
  opendirCalls: 0,
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
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
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

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "dirty-checkout" });
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

    await expect(checkPreconditions(directory)).resolves.toEqual({ ok: false, reason: "changed-submodule" });
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
    })).resolves.toEqual({ ok: false, reason: "nested-repository" });
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
    await expect(checkPreconditions(directory, { writeAllowlist: ["nested/file.txt"] })).resolves.toEqual({ ok: false, reason: "nested-repository" });
    await expect(checkPreconditions(directory, { writeAllowlist: ["nested/*"] })).resolves.toEqual({ ok: false, reason: "nested-repository" });
    await expect(checkPreconditions(directory, { writeAllowlist: ["**/*.txt"] })).resolves.toEqual({ ok: false, reason: "nested-repository" });
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
    })).resolves.toEqual({ ok: false, reason: "nested-repository" });
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
  }, 15_000);

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
