import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acquireWxFileLock } from "../../src/platform/posix-platform-services.js";
import {
  canonicalizeForScope,
  WindowsPlatformServices,
} from "../../src/platform/windows-platform-services.js";

describe("canonicalizeForScope (pure, all OSes)", () => {
  it("treats differently-cased paths inside the root as in scope", () => {
    expect(canonicalizeForScope("C:\\Repo\\SRC\\a.ts", "c:\\repo")).toBe(true);
  });

  it("treats the root itself as in scope", () => {
    expect(canonicalizeForScope("C:\\Repo", "c:\\repo\\")).toBe(true);
  });

  it("rejects paths outside the root", () => {
    expect(canonicalizeForScope("C:\\Other\\a.ts", "c:\\repo")).toBe(false);
  });

  it("rejects sibling prefixes that are not path boundaries", () => {
    expect(canonicalizeForScope("C:\\Repo2\\a.ts", "c:\\repo")).toBe(false);
  });
});

describe("acquireWxFileLock (shared, all OSes)", () => {
  it("locks, releases, and can relock the same key", async () => {
    const key = `test-${randomUUID()}`;
    const first = await acquireWxFileLock(key);
    await first.release();
    const second = await acquireWxFileLock(key);
    await second.release();
  });
});

describe.runIf(process.platform === "win32")("WindowsPlatformServices (win32-gated)", () => {
  const ps = new WindowsPlatformServices();

  it("spawns a node child and captures bounded stdout", async () => {
    const executable = await ps.resolveExecutable({ explicitPath: process.execPath, name: "node" });
    const proc = await ps.spawnSupervised({
      executable,
      args: ["-e", "console.log('hi')"],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      stdin: undefined,
    });
    const exit = await proc.done;
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout.trim()).toBe("hi");
  });

  it("returns a win32 process start token for the current process", async () => {
    const token = await ps.getProcessStartToken(process.pid);
    expect(token).toMatch(/^win32:\d+$/);
  });

  it("creates a writable secure temp directory", async () => {
    const dir = await ps.createSecureTempDirectory();
    expect(dir.length).toBeGreaterThan(0);
  });
});
