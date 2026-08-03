import { describe, expect, it } from "vitest";
import { platformPathsEqual } from "../../src/util/platform-path.js";

describe("platform path equality", () => {
  it("normalizes Windows separators and extended-length prefixes", () => {
    expect(platformPathsEqual(
      "\\\\?\\C:\\State\\Worktrees\\Run-1",
      "C:\\State\\Worktrees\\Run-1",
      "win32",
    )).toBe(true);
    expect(platformPathsEqual(
      "\\\\?\\UNC\\server\\share\\State",
      "\\\\server\\share\\State",
      "win32",
    )).toBe(true);
  });

  it("does not guess a Windows directory's case-sensitivity policy", () => {
    expect(platformPathsEqual(
      "C:\\State\\Worktrees\\Run-1",
      "c:\\state\\worktrees\\run-1",
      "win32",
    )).toBe(false);
  });

  it("keeps POSIX path comparison case-sensitive", () => {
    expect(platformPathsEqual("/state/Run-1", "/state/run-1", "linux")).toBe(false);
  });
});
