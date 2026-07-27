import path from "node:path";

/**
 * Decides whether a `git worktree list --porcelain` field is the registration
 * for `worktreePath`.
 *
 * git reports the worktree path in its own format, which on Windows is
 * forward-slashed (`C:/Users/...`) while a recorded worktree path is
 * canonicalized by Node and back-slashed (`C:\Users\...`). Comparing the raw
 * field therefore never matches on Windows, so callers must resolve the
 * reported path first. `worktreePath` is expected to already be canonical.
 */
export function isWorktreeRegistrationFor(field: string, worktreePath: string): boolean {
  if (!field.startsWith("worktree ")) return false;
  return path.resolve(field.slice("worktree ".length)) === worktreePath;
}
