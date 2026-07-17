import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, type GitResult } from "../../src/git/git-exec.js";

const temporaryPaths: string[] = [];

function rawGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        ...env,
      },
    }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function expectGit(cwd: string, args: string[]): Promise<GitResult> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result;
}

async function makeRepo(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ca-git-exec-"));
  temporaryPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await expectGit(repo, ["init", "-q"]);
  await writeFile(path.join(repo, "base.txt"), "base\n");
  await expectGit(repo, ["add", "base.txt"]);
  await expectGit(repo, ["commit", "-q", "-m", "base"]);
  return { root, repo };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe("git execution hardening", () => {
  it.skipIf(process.platform === "win32")(
    "disables local hooks, fsmonitor, and clean filters in an ordinary repository",
    async () => {
      const fixture = await makeRepo();
      const hookMarker = path.join(fixture.root, "hook-ran");
      const monitorMarker = path.join(fixture.root, "fsmonitor-ran");
      const filterMarker = path.join(fixture.root, "filter-ran");
      const hook = path.join(fixture.repo, ".git", "hooks", "post-checkout");
      const monitor = path.join(fixture.root, "fsmonitor.sh");
      const filter = path.join(fixture.root, "filter.sh");
      await writeFile(hook, `#!/bin/sh\nprintf ran > "${hookMarker}"\n`);
      await writeFile(monitor, `#!/bin/sh\nprintf ran > "${monitorMarker}"\nprintf '0\\0'\n`);
      await writeFile(filter, `#!/bin/sh\nprintf ran > "${filterMarker}"\nprintf transformed\n`);
      await Promise.all([chmod(hook, 0o755), chmod(monitor, 0o755), chmod(filter, 0o755)]);
      await rawGit(fixture.repo, ["config", "core.fsmonitor", monitor]);
      await rawGit(fixture.repo, ["config", "filter.hostile.clean", filter]);
      await rawGit(fixture.repo, ["config", "filter.hostile.required", "true"]);
      await writeFile(path.join(fixture.repo, ".gitattributes"), "payload.txt filter=hostile\n");
      await writeFile(path.join(fixture.repo, "payload.txt"), "original bytes\n");

      await expectGit(fixture.repo, ["status", "--porcelain"]);
      await expectGit(fixture.repo, ["checkout", "-q", "-b", "hardened"]);
      await expectGit(fixture.repo, ["add", ".gitattributes", "payload.txt"]);
      const staged = await expectGit(fixture.repo, ["show", ":payload.txt"]);

      expect(staged.stdout).toBe("original bytes\n");
      await expect(readFile(hookMarker)).rejects.toBeDefined();
      await expect(readFile(monitorMarker)).rejects.toBeDefined();
      await expect(readFile(filterMarker)).rejects.toBeDefined();
    },
  );

  it("ignores host global configuration", async () => {
    const fixture = await makeRepo();
    const globalConfig = path.join(fixture.root, "host.gitconfig");
    await writeFile(globalConfig, "[host]\n\tvalue = leaked\n");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const result = await git(fixture.repo, ["config", "--get", "host.value"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  it.skipIf(process.platform === "win32")("neutralizes a worktree-scoped filter when enabled", async () => {
    const fixture = await makeRepo();
    const marker = path.join(fixture.root, "worktree-filter-ran");
    const filter = path.join(fixture.root, "worktree-filter.sh");
    await writeFile(filter, `#!/bin/sh\nprintf ran > "${marker}"\nprintf transformed\n`);
    await chmod(filter, 0o755);
    await rawGit(fixture.repo, ["config", "extensions.worktreeConfig", "true"]);
    await rawGit(fixture.repo, ["config", "--worktree", "filter.worktree.clean", filter]);
    await rawGit(fixture.repo, ["config", "--worktree", "filter.worktree.required", "true"]);
    await writeFile(path.join(fixture.repo, ".gitattributes"), "payload.txt filter=worktree\n");
    await writeFile(path.join(fixture.repo, "payload.txt"), "worktree bytes\n");

    await expectGit(fixture.repo, ["add", ".gitattributes", "payload.txt"]);
    const staged = await expectGit(fixture.repo, ["show", ":payload.txt"]);

    expect(staged.stdout).toBe("worktree bytes\n");
    await expect(readFile(marker)).rejects.toBeDefined();
  });

  it("fails closed when a filter driver name contains an equals sign", async () => {
    const fixture = await makeRepo();
    const configPath = path.join(fixture.repo, ".git", "config");
    const existing = await readFile(configPath, "utf8");
    await writeFile(configPath, `${existing}\n[filter "bad=name"]\n\tclean = cat\n`);

    const result = await git(fixture.repo, ["status", "--porcelain"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unsafe Git filter driver name");
  });

  it("applies runtime-supplied config after hardening config", async () => {
    const fixture = await makeRepo();

    const result = await expectGit(fixture.repo, [
      "-c", "core.autocrlf=input", "config", "--get", "core.autocrlf",
    ]);

    expect(result.stdout.trim()).toBe("input");
  });

  it("reports output truncated at a caller-supplied bound", async () => {
    const fixture = await makeRepo();

    const result = await git(fixture.repo, ["show", "HEAD:base.txt"], { maxOutputBytes: 2 });

    expect(result.exitCode).toBe(0);
    expect(result.truncated?.stdout).toBe(true);
  });
});
