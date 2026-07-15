import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJobKillHelper, WindowsPlatformServices } from "../../src/platform/windows-platform-services.js";

const POLL_INTERVAL_MS = 50;

async function waitForHeartbeat(heartbeatPath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await fs.stat(heartbeatPath); return; }
    catch { await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS)); }
  }
  throw new Error("heartbeat did not appear");
}

const jobHelper = resolveJobKillHelper(path.resolve("."), process.arch);

function runHelper(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(jobHelper.path, args, { windowsHide: true, shell: false }, (error, stdout) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error === null ? 0 : 1, stdout });
    });
  });
}

describe.runIf(
  process.platform === "win32" && existsSync(jobHelper.path),
)("Windows job helper termination", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, {
      recursive: true, force: true,
    })));
  });

  it("prints a creation token for the current process", async () => {
    const result = await runHelper(["token", String(process.pid)]);
    expect(result.code).toBe(0);
    expect(BigInt(result.stdout.trim())).toBeGreaterThan(0n);
  });

  it("returns exit 2 for a dead process", async () => {
    const child = execFile(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise<void>((resolve, reject) => {
      child.on("close", () => resolve());
      child.on("error", reject);
    });
    const result = await runHelper(["token", String(child.pid)]);
    expect(result.code).toBe(2);
  });

  it("stops a child process tree heartbeat", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "windows-job-kill-"));
    tempDirectories.push(directory);
    const heartbeatPath = path.join(directory, "heartbeat");
    const services = new WindowsPlatformServices();
    const executable = await services.resolveExecutable({
      explicitPath: process.execPath,
      name: "node",
    });
    const grandchildScript = [
      "const fs = require('node:fs');",
      `const heartbeat = ${JSON.stringify(heartbeatPath)};`,
      "setInterval(() => fs.writeFileSync(heartbeat, String(Date.now())), 100);",
    ].join("");
    const childScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const proc = await services.spawnSupervised({
      executable,
      args: ["-e", childScript],
      cwd: directory,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });

    await waitForHeartbeat(heartbeatPath);
    await services.terminateProcessTree(proc);
    const deadline = Date.now() + 2_000;
    let stopped = false;
    while (Date.now() < deadline) {
      const before = (await fs.stat(heartbeatPath)).mtimeMs;
      await new Promise(resolve => setTimeout(resolve, 250));
      const after = (await fs.stat(heartbeatPath)).mtimeMs;
      if (after === before) { stopped = true; break; }
    }
    expect(stopped).toBe(true);
  });
});
