import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findWorktreeRegistration } from "../../src/git/worktree-registration.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "worktree-registration-"));
  const worktree = path.join(root, "attempt-one");
  const other = path.join(root, "attempt-two");
  await Promise.all([mkdir(worktree), mkdir(other)]);
  return { root, worktree, other };
}

describe("worktree registration matching", () => {
  it("finds the canonical registration Git reports for the worktree", async () => {
    const f = await fixture();
    try {
      await expect(findWorktreeRegistration([
        `worktree ${f.other}`,
        `worktree ${f.worktree}`,
      ], f.worktree)).resolves.toBe(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("skips an unrelated missing registration before the live target", async () => {
    const f = await fixture();
    try {
      await expect(findWorktreeRegistration([
        `worktree ${path.join(f.root, "missing-unrelated")}`,
        `worktree ${f.worktree}`,
      ], f.worktree)).resolves.toBe(1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("canonicalizes an equivalent reported path before matching", async () => {
    const f = await fixture();
    try {
      const reported = `${f.worktree}${path.sep}.`;
      expect(reported).not.toBe(f.worktree);
      await expect(findWorktreeRegistration([
        `worktree ${reported}`,
      ], f.worktree)).resolves.toBe(0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("supports a missing stale worktree only when explicitly allowed", async () => {
    const f = await fixture();
    const missing = path.join(f.root, "missing-worktree");
    try {
      await expect(findWorktreeRegistration([
        `worktree ${missing}`,
      ], missing, true)).resolves.toBe(0);
      await expect(findWorktreeRegistration([
        `worktree ${missing}`,
      ], missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "preserves missing registrations when Windows case policy is unknowable",
    async () => {
      const f = await fixture();
      const missing = path.join(f.root, "Missing-Worktree");
      try {
        await expect(findWorktreeRegistration(
          [`worktree ${missing}`],
          missing.toUpperCase(),
          true,
        )).resolves.toBe(-1);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it("ignores fields that are not worktree registrations", async () => {
    const f = await fixture();
    try {
      await expect(findWorktreeRegistration([
        `branch refs/heads/${f.worktree}`,
        "bare",
        `worktreeish ${f.worktree}`,
      ], f.worktree)).resolves.toBe(-1);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
