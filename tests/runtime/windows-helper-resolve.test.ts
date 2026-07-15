import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveJobKillHelper,
  WindowsPlatformServices,
} from "../../src/platform/windows-platform-services.js";

describe("Windows job helper resolution (all OSes)", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, {
      recursive: true, force: true,
    })));
  });

  async function tempRoot(): Promise<string> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "windows-helper-"));
    tempDirectories.push(directory);
    return directory;
  }

  it("resolves the architecture-specific helper path", () => {
    const root = path.join("root", "plugin");
    expect(resolveJobKillHelper(root, "x64").path).toBe(
      path.join(root, "native", "bin", "win32-job-kill-x64.exe"),
    );
  });

  it("reports whether the helper is available", async () => {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    expect(await helper.checkAvailable()).toBe(false);

    await fs.mkdir(path.dirname(helper.path), { recursive: true });
    await fs.writeFile(helper.path, "fixture", { mode: 0o755 });
    expect(await helper.checkAvailable()).toBe(true);
  });

  it("fails closed before spawning when the helper is missing", async () => {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    const services = new WindowsPlatformServices(root, "x64");
    const spawnAttempt = services.spawnSupervised({
      executable: {
        kind: "native",
        command: path.join(root, "must-not-be-spawned"),
        prefixArgs: [],
        resolvedFrom: "test",
      },
      args: [],
      cwd: root,
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });

    await expect(spawnAttempt).rejects.toMatchObject({
      message: "windows process-tree helper missing",
      detail: { path: helper.path },
    });
  });

  async function servicesWithExec(
    fakeExec: (...args: unknown[]) => unknown,
  ): Promise<WindowsPlatformServices> {
    const root = await tempRoot();
    const helper = resolveJobKillHelper(root, "x64");
    await fs.mkdir(path.dirname(helper.path), { recursive: true });
    await fs.writeFile(helper.path, "fixture");
    return new WindowsPlatformServices(root, "x64", fakeExec as never);
  }

  it("uses the native helper token mode", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: null, stdout: string) => void)(null, "12345\n");
    });

    await expect(services.getProcessStartToken(42)).resolves.toBe("win32:12345");
    await expect(services.getProcessStartToken(42)).resolves.toBe("win32:12345");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual(["token", "42"]);
  });

  it("returns null for native helper exit 2 without PowerShell", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      (args[3] as (error: NodeJS.ErrnoException, stdout: string) => void)(
        Object.assign(new Error("gone"), { code: 2 }),
        "",
      );
    });

    await expect(services.getProcessStartToken(42)).resolves.toBeNull();
    await expect(services.getProcessStartToken(42)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("falls back to PowerShell when the native helper fails", async () => {
    const calls: unknown[][] = [];
    const services = await servicesWithExec((...args: unknown[]) => {
      calls.push(args);
      if (calls.length === 1) {
        (args[3] as (error: Error, stdout: string) => void)(new Error("helper failed"), "");
      } else {
        (args[2] as (error: null, stdout: string) => void)(null, "67890\n");
      }
    });

    await expect(services.getProcessStartToken(42)).resolves.toBe("win32:67890");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toBe("powershell.exe");
    expect(calls[1]?.[1]).toEqual([
      "-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id 42).StartTime.ToFileTimeUtc()",
    ]);
  });

  it("memoizes a successful own-process token", async () => {
    let calls = 0;
    const services = await servicesWithExec((...args: unknown[]) => {
      calls += 1;
      (args[3] as (error: null, stdout: string) => void)(null, "12345");
    });

    await expect(services.getProcessStartToken(process.pid)).resolves.toBe("win32:12345");
    await expect(services.getProcessStartToken(process.pid)).resolves.toBe("win32:12345");
    expect(calls).toBe(1);
  });
});
