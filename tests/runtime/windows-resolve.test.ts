import { describe, expect, it } from "vitest";
import { normalizeWindowsEnv } from "../../src/platform/windows-env.js";
import { resolveWindowsExecutable } from "../../src/platform/windows-platform-services.js";

describe("normalizeWindowsEnv", () => {
  it("collapses PATH/Path/path into one canonical Path key", () => {
    const out = normalizeWindowsEnv({ PATH: "a", Path: "b", path: "c" });
    expect(Object.keys(out).filter(k => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(out.Path).toBe("c");
  });

  it("collapses TEMP case variants with canonical casing and last-writer-wins", () => {
    const out = normalizeWindowsEnv({ TEMP: "first", temp: "second", Temp: "last" });

    expect(Object.keys(out).filter(k => k.toLowerCase() === "temp")).toEqual(["TEMP"]);
    expect(out.TEMP).toBe("last");
  });

  it("collapses ComSpec case variants with canonical casing", () => {
    const out = normalizeWindowsEnv({ ComSpec: "first", COMSPEC: "last" });

    expect(Object.keys(out).filter(k => k.toLowerCase() === "comspec")).toEqual(["ComSpec"]);
    expect(out.ComSpec).toBe("last");
  });
});

describe("windows executable resolution (fs-faked, runs on all OSes)", () => {
  const fakeFs = (existing: string[]) => ({
    async isFile(p: string) { return existing.includes(p.toLowerCase()); },
    async readFile(_p: string): Promise<string> { throw new Error("not needed"); },
  });
  it("prefers .exe over .cmd on the same PATH entry", async () => {
    const r = await resolveWindowsExecutable(
      { name: "codex" },
      { pathEntries: ["C:\\tools"], pathext: [".EXE", ".COM", ".CMD", ".BAT"],
        fs: fakeFs(["c:\\tools\\codex.exe", "c:\\tools\\codex.cmd"]), nodeExe: "C:\\node\\node.exe" });
    expect(r.kind).toBe("native");
    expect(r.command.toLowerCase()).toBe("c:\\tools\\codex.exe");
  });
  it("falls back to cmd-wrapper with user values out of the command string", async () => {
    const r = await resolveWindowsExecutable(
      { name: "codex" },
      { pathEntries: ["C:\\tools"], pathext: [".EXE", ".COM", ".CMD", ".BAT"],
        fs: fakeFs(["c:\\tools\\codex.cmd"]), nodeExe: "C:\\node\\node.exe",
        comSpec: "C:\\Windows\\System32\\cmd.exe" });
    expect(r.kind).toBe("cmd-wrapper");
    expect(r.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(r.prefixArgs).toEqual(["/d", "/s", "/c", "C:\\tools\\codex.cmd"]);
  });
  it("resolves an npm shim to a node entrypoint when the JS entry exists", async () => {
    const r = await resolveWindowsExecutable(
      { name: "codex" },
      { pathEntries: ["C:\\nvm\\v26"], pathext: [".EXE", ".COM", ".CMD", ".BAT"],
        fs: fakeFs(["c:\\nvm\\v26\\codex.cmd", "c:\\nvm\\v26\\node_modules\\codex\\bin\\codex.js"]),
        npmEntryProbe: ["node_modules\\codex\\bin\\codex.js"], nodeExe: "C:\\nvm\\v26\\node.exe" });
    expect(r.kind).toBe("node-entrypoint");
    expect(r.command).toBe("C:\\nvm\\v26\\node.exe");
    expect(r.prefixArgs).toEqual(["C:\\nvm\\v26\\node_modules\\codex\\bin\\codex.js"]);
  });
});
