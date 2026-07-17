import { access, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkPrimaryDependencies } from "../../src/verify/dependency-link.js";

const temporaryPaths: string[] = [];

async function fixture(): Promise<{ primary: string; worktree: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "ca-dependency-link-"));
  temporaryPaths.push(root);
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "worktree");
  await mkdir(path.join(primary, "node_modules"), { recursive: true });
  await mkdir(worktree);
  await writeFile(path.join(primary, "node_modules", "sentinel"), "safe\n");
  return { primary, worktree };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe("linkPrimaryDependencies", () => {
  it("links node_modules when package locks match", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe("inherited");
    expect(await readlink(path.join(paths.worktree, "node_modules"))).toBe(
      path.join(paths.primary, "node_modules"),
    );

    await rm(paths.worktree, { recursive: true, force: true });
    await expect(access(path.join(paths.primary, "node_modules", "sentinel"))).resolves.toBeUndefined();
  });

  it("skips the link when package locks differ", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "primary\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
    await expect(access(path.join(paths.worktree, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips the link when a non-first lockfile differs", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.primary, "pnpm-lock.yaml"), "primary\n");
    await writeFile(path.join(paths.worktree, "pnpm-lock.yaml"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
  });

  it("skips the link when a lockfile is present on only one side", async () => {
    const paths = await fixture();
    await writeFile(path.join(paths.primary, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "package-lock.json"), "{}\n");
    await writeFile(path.join(paths.worktree, "yarn.lock"), "candidate\n");

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe(
      "skipped-lockfile-mismatch",
    );
  });

  it("links node_modules when all recognized lockfiles match", async () => {
    const paths = await fixture();
    for (const lockfile of ["package-lock.json", "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]) {
      await writeFile(path.join(paths.primary, lockfile), `${lockfile}\n`);
      await writeFile(path.join(paths.worktree, lockfile), `${lockfile}\n`);
    }

    await expect(linkPrimaryDependencies(paths.primary, paths.worktree)).resolves.toBe("inherited");
  });
});
