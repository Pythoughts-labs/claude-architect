import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PosixPlatformServices } from "../../src/platform/posix-platform-services.js";

describe.runIf(process.platform !== "win32")("process start token", () => {
  it("returns a stable token for a live pid and null for a dead one", async () => {
    const ps = new PosixPlatformServices();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"]);
    const pid = child.pid!;
    const a = await ps.getProcessStartToken(pid);
    const b = await ps.getProcessStartToken(pid);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    child.kill("SIGKILL");
    await new Promise(resolve => child.on("close", resolve));
    expect(await ps.getProcessStartToken(pid)).toBeNull();
  });

  it("terminateProcessTreeByPid skips the kill when the token mismatches", async () => {
    const ps = new PosixPlatformServices();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { detached: true });
    const pid = child.pid!;
    await ps.terminateProcessTreeByPid(pid, "not-the-real-token");
    expect(() => process.kill(pid, 0)).not.toThrow();
    await ps.terminateProcessTreeByPid(pid);
    await new Promise(resolve => child.on("close", resolve));
  });
});
