import path from "node:path";
import { describe, expect, it } from "vitest";
import { isWorktreeRegistrationFor } from "../../src/git/worktree-registration.js";

describe("worktree registration matching", () => {
  const worktree = path.resolve(path.join("repo", "worktrees", "attempt-one"));

  it("matches the registration git reports for the worktree", () => {
    expect(isWorktreeRegistrationFor(`worktree ${worktree}`, worktree)).toBe(true);
  });

  // The regression this guards: git prints its own path format, so the reported
  // path is equivalent to but not byte-identical with the recorded one. A raw
  // string comparison misses it — on Windows for every single registration,
  // because git forward-slashes what Node canonicalized with backslashes.
  it("matches a registration reported in an equivalent but non-normalized form", () => {
    const reported = `${worktree}${path.sep}.`;
    expect(reported).not.toBe(worktree);
    expect(isWorktreeRegistrationFor(`worktree ${reported}`, worktree)).toBe(true);
  });

  it("does not match a different worktree, including a path prefix of it", () => {
    expect(isWorktreeRegistrationFor(`worktree ${worktree}-other`, worktree)).toBe(false);
    expect(isWorktreeRegistrationFor(`worktree ${path.dirname(worktree)}`, worktree)).toBe(false);
  });

  it("ignores porcelain fields that are not a worktree registration", () => {
    expect(isWorktreeRegistrationFor(`branch refs/heads/${worktree}`, worktree)).toBe(false);
    expect(isWorktreeRegistrationFor("bare", worktree)).toBe(false);
    // `worktreeXYZ ...` must not be read as the `worktree` field.
    expect(isWorktreeRegistrationFor(`worktreeish ${worktree}`, worktree)).toBe(false);
  });
});
