import { describe, expect, it } from "vitest";
import {
  EMPTY_DIRECTORY_TIMEOUT_ENV,
  resolveEmptyDirectoryTimeoutMs,
} from "../../src/platform/bound-directory-cleanup.js";

describe("resolveEmptyDirectoryTimeoutMs", () => {
  it("defaults to 120000ms when unset or empty", () => {
    expect(resolveEmptyDirectoryTimeoutMs({})).toBe(120_000);
    expect(resolveEmptyDirectoryTimeoutMs({ [EMPTY_DIRECTORY_TIMEOUT_ENV]: "" })).toBe(120_000);
  });

  it("honors a positive integer override", () => {
    // A large disposable worktree (big node_modules / monorepo checkout) can
    // routinely exceed the default budget; this is the override that lets an
    // operator raise it instead of eating a teardown failure on every attempt.
    expect(resolveEmptyDirectoryTimeoutMs({ [EMPTY_DIRECTORY_TIMEOUT_ENV]: "600000" }))
      .toBe(600_000);
  });

  it("fails closed to the default and warns on a non-positive-integer value", () => {
    // A typo (or an attempt to disable the bound with 0/negative/non-numeric)
    // must not silently produce an unbounded or nonsensical timeout — a wedged
    // Producer process would then never be cleaned up.
    const warnings: string[] = [];
    expect(resolveEmptyDirectoryTimeoutMs(
      { [EMPTY_DIRECTORY_TIMEOUT_ENV]: "not-a-number" },
      message => warnings.push(message),
    )).toBe(120_000);
    expect(warnings).toEqual([expect.stringContaining("is not a positive integer")]);
  });

  it.each(["0", "-1", "1.5"])("rejects the non-positive-integer value %s", value => {
    const warnings: string[] = [];
    expect(resolveEmptyDirectoryTimeoutMs(
      { [EMPTY_DIRECTORY_TIMEOUT_ENV]: value },
      message => warnings.push(message),
    )).toBe(120_000);
    expect(warnings).toHaveLength(1);
  });
});
