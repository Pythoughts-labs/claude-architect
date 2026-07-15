# P0-B Cross-Platform Hardening (0.9.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the P0-A runtime honestly cross-platform: native Windows Platform Services with a Job Object process-tree helper, named tested write-confinement backends per certified OS, Windows path/locking/env/CRLF/drive-UNC/Unicode coverage, full cross-session crash recovery, and PID process-identity protection — shipped as `0.9.0`.

**Architecture:** Everything plugs into the existing C4 `PlatformServices` seam (`src/platform/platform-services.ts`) and the C5 adapter contract. New code is: a `WindowsPlatformServices` implementation, a `native/` Job Object helper, a `src/platform/sandbox/` backend selection module, a process-identity token threaded through `RunStartRecord` → `RecoveryManager`, and platform-conditional tests. No canonical contract changes except two additive `PlatformServices` methods.

**Tech Stack:** TypeScript (ESM, Node ≥22), vitest, esbuild bundle (`runtime/server.mjs`), C (single-file Win32 Job Object helper, MSVC/mingw), GitHub Actions matrix (macos-14, ubuntu-latest, windows-latest).

## Global Constraints

- Node.js floor: **22** (bootstrap enforces; keep Node-20-parseable `runtime/bootstrap.mjs` untouched).
- Never merge native Windows and WSL: `environmentType: "native" | "wsl"` stays separate everywhere.
- Codex single-agent controls stay verbatim: `--disable multi_agent` and `-c features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}`.
- Process-tree supervision alone does NOT satisfy write confinement; edit-lane eligibility requires a named `writeConfinementBackend`, else fail closed.
- No shell scripts in the shipped Windows path; `cmd.exe /d /s /c` only for trusted fully-resolved `.cmd`/`.bat`, user values never in the command string.
- All spawns are argv-based, no `shell: true` ever.
- Every run: `npm run typecheck && npm test && npm run build && bash scripts/validate-release.sh` must stay green; `runtime/server.mjs` must be byte-stable after rebuild.
- Platform-specific tests are gated with `describe.runIf(process.platform === "...")` so the suite passes on every OS; the release gate requires the CI matrix green on all three.
- Commit style: repo convention `feat(runtime):` / `test(runtime):` / `fix(platform):`; NO Claude co-author trailers.

## File Structure

```
src/platform/
  platform-services.ts          # MODIFY: +getProcessStartToken, +terminateProcessTreeByPid token arg
  posix-platform-services.ts    # MODIFY: implement the two additions
  windows-platform-services.ts  # CREATE: full C4 impl for win32 (Task 2–4)
  windows-env.ts                # CREATE: case-insensitive env-key normalization → canonical keys
  select-platform.ts            # MODIFY: return WindowsPlatformServices (Task 5)
  sandbox/
    backends.ts                 # CREATE: named backend registry + selection (Task 6)
native/
  win32-job-kill.c              # CREATE: Job Object tree-kill helper source
  build-win32.md                # CREATE: exact build command + checksum instructions
  bin/win32-job-kill-x64.exe    # CREATE (built on Windows CI, committed)
src/runtime/
  attempt-runtime.ts            # MODIFY: record processToken; sandbox fail-closed selection
  recovery-manager.ts           # MODIFY: token-checked kill; orphan escalation; cross-session lock reclaim
  environment-policy.ts         # MODIFY: WIN32_ESSENTIAL_ENV + canonical Path
.github/workflows/ci.yml       # CREATE: 3-OS matrix
```

---

### Task 1: Process-identity token (PID-reuse protection)

Closes the deferred P0-A boundary: `run-start.json` stores only a PID, so a recovery kill can hit a recycled PID. Add a platform process-start token; recovery only kills when the live process's token matches the recorded one.

**Files:**
- Modify: `src/platform/platform-services.ts`
- Modify: `src/platform/posix-platform-services.ts`
- Modify: `src/runtime/attempt-runtime.ts` (RunStartRecord + pid recording seam, ~`src/runtime/attempt-runtime.ts:96` and `:549`)
- Modify: `src/runtime/recovery-manager.ts` (RunStartRecord parse ~`:28`,`:172`; kill site ~`:477`)
- Test: `tests/runtime/process-token.test.ts`, extend `tests/runtime/recovery-manager.test.ts`

**Interfaces:**
- Consumes: existing `PlatformServices`, `RunStartRecord`.
- Produces:
  - `PlatformServices.getProcessStartToken(pid: number): Promise<string | null>` — opaque stable token for a live pid (`null` = not determinable / dead).
  - `PlatformServices.terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void>` — when `expectedToken` is a string and the live token differs, do NOT kill (treat as already-gone).
  - `RunStartRecord.processToken: string | null` (additive; old records without the field parse with `processToken: null` for backward compat — token check is then skipped, preserving P0-A behavior).

- [ ] **Step 1: Write failing tests**

```ts
// tests/runtime/process-token.test.ts
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
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
    await new Promise(r => child.on("close", r));
    expect(await ps.getProcessStartToken(pid)).toBeNull();
  });

  it("terminateProcessTreeByPid skips the kill when the token mismatches", async () => {
    const ps = new PosixPlatformServices();
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { detached: true });
    const pid = child.pid!;
    await ps.terminateProcessTreeByPid(pid, "not-the-real-token");
    // Process must still be alive: signal 0 succeeds.
    expect(() => process.kill(pid, 0)).not.toThrow();
    await ps.terminateProcessTreeByPid(pid); // no token → unconditional (P0-A behavior)
    await new Promise(r => child.on("close", r));
  });
});
```

In `tests/runtime/recovery-manager.test.ts`, add a case seeding a `run-start.json` whose `pid` is alive but whose `processToken` differs from the live token (inject `getProcessStartToken` via the existing test-deps seam alongside `isProcessAlive`): recovery must NOT call `terminateProcessTreeByPid` with an effective kill, and must still archive/clean the stale run.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/process-token.test.ts` → FAIL: `getProcessStartToken is not a function`.

- [ ] **Step 3: Implement**

`src/platform/platform-services.ts` — add to the interface:

```ts
  /** Opaque per-boot-stable identity for a live pid; null when dead/undeterminable. */
  getProcessStartToken(pid: number): Promise<string | null>;
  terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void>;
```

`src/platform/posix-platform-services.ts`:

```ts
  async getProcessStartToken(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (nodeProcess.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        // field 22 (starttime, clock ticks since boot) after the parenthesized comm
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const starttime = afterComm[19];
        return starttime ? `linux:${starttime}` : null;
      } catch { return null; }
    }
    // darwin: ps lstart is stable for the process lifetime
    return new Promise(resolve => {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
        const line = stdout.trim();
        resolve(error || line.length === 0 ? null : `darwin:${line}`);
      });
    });
  }

  async terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void> {
    if (typeof expectedToken === "string") {
      const live = await this.getProcessStartToken(pid);
      if (live !== expectedToken) return; // recycled or dead pid: never signal it
    }
    killProcessGroup(pid, "SIGKILL");
  }
```

`src/runtime/attempt-runtime.ts` — add `processToken: string | null` to `RunStartRecord`; in `withRunStartPidRecording`, after the pid is known, `await ps.getProcessStartToken(pid)` and persist it in the same durable rewrite that records the pid (best-effort: on token-read failure store `null`).

`src/runtime/recovery-manager.ts` — add `processToken` to its `RunStartRecord` and `parseRunStart` (accept absent → `null`; reject non-string non-null); at the kill site (`~:477`) pass it: `await ps.terminateProcessTreeByPid(record.pid, record.processToken)`.

Also update `DiagnosticsOnlyPlatformServices` in `select-platform.ts` with a throwing `getProcessStartToken` (removed in Task 5).

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/process-token.test.ts tests/runtime/recovery-manager.test.ts` → PASS; then `npm run typecheck && npm test && npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ src/runtime/attempt-runtime.ts src/runtime/recovery-manager.ts tests/runtime/ runtime/server.mjs
git commit -m "feat(platform): bind crash-recovery kills to a process start token"
```

---

### Task 2: WindowsPlatformServices — executable resolution

**Files:**
- Create: `src/platform/windows-platform-services.ts`
- Create: `src/platform/windows-env.ts`
- Test: `tests/runtime/windows-resolve.test.ts` (logic is pure enough to run on ALL OSes via injected fs/env fakes; real-spawn coverage is Windows-gated in Task 3)

**Interfaces:**
- Consumes: `ExecutableRequest`, `ResolvedExecutable` from `platform-services.ts`.
- Produces:
  - `class WindowsPlatformServices implements PlatformServices` with `os: "win32"`.
  - `resolveExecutable` order per C4/B1: (1) `PATHEXT` search preferring `.exe` then `.com` (`kind:"native"`); (2) npm JS entry point next to a found `.cmd` shim (`<dir>/node_modules/<name>/...` via the shim's target or `<dir>/<name>` package `bin`) invoked as `kind:"node-entrypoint"` with `command: <node.exe>`, `prefixArgs: [entry]`; (3) trusted fully-resolved `.cmd`/`.bat` as `kind:"cmd-wrapper"`, `command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"`, `prefixArgs: ["/d","/s","/c", resolvedCmdPath]` — user args go in `args`, never concatenated into a command string.
  - `windows-env.ts`: `normalizeWindowsEnv(env: Record<string,string|undefined>): Record<string,string>` — case-insensitive dedup; for each collision keep the LAST canonical-cased winner with canonical names `Path`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` (others keep first-seen casing); exactly one `Path` key in the output.

- [x] **Step 1: Write failing tests**

```ts
// tests/runtime/windows-resolve.test.ts
import { describe, expect, it } from "vitest";
import { normalizeWindowsEnv } from "../../src/platform/windows-env.js";
import { resolveWindowsExecutable } from "../../src/platform/windows-platform-services.js";

describe("normalizeWindowsEnv", () => {
  it("collapses PATH/Path/path into one canonical Path key", () => {
    const out = normalizeWindowsEnv({ PATH: "a", Path: "b", path: "c" });
    expect(Object.keys(out).filter(k => k.toLowerCase() === "path")).toEqual(["Path"]);
    expect(out.Path).toBe("c"); // last writer wins
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
```

- [x] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/windows-resolve.test.ts` → FAIL: module not found.

- [x] **Step 3: Implement**

`src/platform/windows-env.ts`:

```ts
const CANONICAL = new Map(["Path","SystemRoot","ComSpec","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA"]
  .map(name => [name.toLowerCase(), name]));

export function normalizeWindowsEnv(env: Record<string, string | undefined>): Record<string, string> {
  const byLower = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    byLower.set(lower, { name: CANONICAL.get(lower) ?? byLower.get(lower)?.name ?? name, value });
  }
  return Object.fromEntries([...byLower.values()].map(e => [e.name, e.value]));
}
```

`src/platform/windows-platform-services.ts` — export a pure, dependency-injected `resolveWindowsExecutable(request, deps)` implementing the three-tier order (explicitPath handled first exactly like POSIX: must exist, `kind:"native"`), plus the `WindowsPlatformServices` class whose `resolveExecutable` wires real deps (`process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"` split/uppercased, real `fs`, `process.execPath` for node). npm-entry detection: when the winner is a `.cmd`/`.bat`, probe `path.join(dir, "node_modules", request.name)` package.json `bin` for a JS entry; if readable, return node-entrypoint; else return cmd-wrapper. Set `resolvedFrom` provenance strings (`pathext:<path>`, `npm-entry:<entry>`, `cmd-wrapper:<path>`). Leave the other `PlatformServices` methods as `throw new RuntimeError("implemented in Task 3/4")` stubs for now — the class is not selected until Task 5.

- [x] **Step 4: Run** — `npx vitest run tests/runtime/windows-resolve.test.ts` → PASS; `npm run typecheck`.

- [x] **Step 5: Commit**

```bash
git add src/platform/windows-platform-services.ts src/platform/windows-env.ts tests/runtime/windows-resolve.test.ts
git commit -m "feat(platform): Windows executable resolution with PATHEXT, npm entry, and cmd-wrapper tiers"
```

---

### Task 3: WindowsPlatformServices — spawn, locking, temp, canonical paths

**Files:**
- Modify: `src/platform/windows-platform-services.ts`
- Test: `tests/runtime/windows-platform.test.ts` (all `describe.runIf(process.platform === "win32")` except pure path-logic cases)

**Interfaces:**
- Consumes: `SpawnRequest`, `CheckoutLock`, `CanonicalPath`; `normalizeWindowsEnv` from Task 2.
- Produces: working `spawnSupervised`, `requestCooperativeCancellation`, `acquireCheckoutLock`, `createSecureTempDirectory`, `canonicalizePath`, `getProcessStartToken` on win32. `terminateProcessTree*` lands in Task 4.

- [x] **Step 1: Write failing tests** — Windows-gated: spawn `node -e "console.log('hi')"` and assert bounded stdout + exit 0; spawn with an env containing `PATH` and `Path` and assert the child sees exactly one `Path`; lock the same checkout twice and assert the second acquire times out with `checkout is locked`; `canonicalizePath("C:\\Repo\\..\\Repo")` returns a canonical drive-letter path and the git common dir for a temp repo; UNC input `\\\\?\\C:\\Repo` canonicalizes without throwing; `createSecureTempDirectory` returns a writable dir under `%TEMP%`. Pure (all-OS) case: `canonicalizeForScope("C:\\Repo\\SRC\\a.ts", "c:\\repo")` (exported helper) treats the paths as inside-scope case-insensitively.

- [x] **Step 2: Run to verify failure** — on win32 FAIL (stubs throw); on POSIX the gated suite skips, pure cases FAIL: helper missing.

- [x] **Step 3: Implement**

  - `spawnSupervised`: same shape as POSIX (`src/platform/posix-platform-services.ts:72-97`) but `detached: false`, `windowsHide: true`, and `env: normalizeWindowsEnv(req.env)`. Keep the mandatory `error`-listener spawn-failure settlement and BoundedBuffer drains verbatim.
  - `requestCooperativeCancellation`: `child.kill("SIGTERM")` equivalent via stored ChildProcess handle (keep a `WeakMap<SupervisedProcess, ChildProcess>`), it is best-effort on Windows; forced kill is Task 4.
  - `acquireCheckoutLock`: reuse the POSIX algorithm verbatim (it is already `open(wx)`-based and works on NTFS); extract the shared implementation into a small exported function in `posix-platform-services.ts` OR duplicate the 20 lines — prefer extraction: `export async function acquireWxFileLock(key: string): Promise<CheckoutLock>` consumed by both classes. Key = sha256 of `canonicalizePath(checkout).gitCommonDir ?? canonical` exactly as POSIX (`posix-platform-services.ts:111-130`) so cross-implementation lock keys agree.
  - `canonicalizePath`: `fs.realpath` (resolves 8.3 names, symlinks, case) then `git rev-parse --path-format=absolute --git-common-dir` via `execFile` (same bootstrap exception comment as POSIX line 29); lowercase-compare helper `canonicalizeForScope(p, root)` exported for Task 7.
  - `getProcessStartToken`: `wmic` is dead; use PowerShell-free `execFile("cmd.exe", ["/d","/s","/c", ...])`? No — user values in command string are banned. Use Node: `execFile(process.execPath, ["-e", ...])` is silly. Correct approach: `Get-Process` is PowerShell; instead read `CreationDate` via `execFile("powershell.exe", ["-NoProfile","-Command", "(Get-Process -Id " + pid + ").StartTime.ToFileTimeUtc()"])` — pid is a validated safe integer, not a user string, so interpolation is safe; return `win32:<filetime>` or `null` on any error.
  - `createSecureTempDirectory`: `fs.mkdtemp(path.join(os.tmpdir(), "claude-architect-"))` (same as POSIX).

- [x] **Step 4: Run** — POSIX: pure cases PASS, gated skip; full `npm test` green. (Windows CI proves the gated cases in Task 9.)

- [x] **Step 5: Commit**

```bash
git add src/platform/ tests/runtime/windows-platform.test.ts
git commit -m "feat(platform): Windows spawn, checkout locking, canonical paths, and process tokens"
```

---

### Task 4: Native Windows Job Object process-tree helper

**Files:**
- Create: `native/win32-job-kill.c`, `native/build-win32.md`
- Create: `native/bin/win32-job-kill-x64.exe` (built + committed from Windows CI; see Step 4)
- Modify: `src/platform/windows-platform-services.ts` (spawn under Job Object; terminate via helper)
- Test: `tests/runtime/windows-job-kill.test.ts` (win32-gated fork-bomb-lite), `tests/runtime/windows-helper-resolve.test.ts` (all-OS resolution logic)

**Interfaces:**
- Consumes: `${CLAUDE_PLUGIN_ROOT}` resolution (same pattern the runtime already uses for `runtime/bootstrap.mjs`).
- Produces: `terminateProcessTree(process)` / `terminateProcessTreeByPid(pid, token?)` on win32 that reliably kill all descendants. Helper protocol: `win32-job-kill.exe <pid>` — opens the process, assigns/queries its Job, `TerminateJobObject`, exit 0 on success, 2 when the pid is already gone, 1 on failure. When the helper binary is missing on win32, `spawnSupervised` **fails closed** with a structured `RuntimeError("windows process-tree helper missing", { path })` BEFORE spawning a Producer (no supervision without termination capability).

- [x] **Step 1: Write failing tests**

All-OS: `resolveJobKillHelper(pluginRoot, arch)` returns `<root>/native/bin/win32-job-kill-<arch>.exe` and a `checkAvailable()` that reports missing files. Win32-gated: spawn a Node fixture that spawns a grandchild writing a heartbeat file every 100ms; call `terminateProcessTree`; assert the heartbeat stops within 2s (no surviving descendants).

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement**

`native/win32-job-kill.c` (complete file):

```c
#include <windows.h>
#include <stdlib.h>
int main(int argc, char **argv) {
    if (argc != 2) return 1;
    DWORD pid = (DWORD)strtoul(argv[1], NULL, 10);
    if (pid <= 1) return 1;
    HANDLE h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, FALSE, pid);
    if (!h) return GetLastError() == ERROR_INVALID_PARAMETER ? 2 : 1; /* 2: already gone */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) { CloseHandle(h); return 1; }
    /* If the target is already in a job we cannot join, fall back to TerminateProcess tree-root. */
    if (!AssignProcessToJobObject(job, h)) {
        BOOL inJob = FALSE; IsProcessInJob(h, NULL, &inJob);
        if (!inJob) { CloseHandle(job); CloseHandle(h); return 1; }
    }
    BOOL ok = TerminateJobObject(job, 137);
    if (!ok) ok = TerminateProcess(h, 137);
    CloseHandle(job); CloseHandle(h);
    return ok ? 0 : 1;
}
```

`native/build-win32.md`: `cl /O2 /W4 win32-job-kill.c /Fe:bin\win32-job-kill-x64.exe` (MSVC) or `x86_64-w64-mingw32-gcc -O2 -o bin/win32-job-kill-x64.exe win32-job-kill.c`; record the SHA-256 of the committed binary in this file on every rebuild.

TypeScript side: `WindowsPlatformServices.spawnSupervised` resolves the helper first and throws the structured fail-closed error when absent; store child handles; `terminateProcessTree*` spawns the helper with `[String(pid)]`, treats exit 2 as success (ESRCH-equivalent), exit 1 as `RuntimeError`. Token check from Task 1 gates the by-pid path identically to POSIX.

Better containment (same task): create the Job at spawn time — spawn the helper is only for recovery-by-pid; for live children, `spawnSupervised` can rely on the helper's assign-and-terminate at kill time, which is sufficient for the acceptance test.

- [ ] **Step 4: Build the binary on Windows (CI or a Windows box), commit it, run the win32-gated test there** — Expected: heartbeat stops, no survivors. On POSIX: resolution tests PASS, gated skip.

- [x] **Step 5: Commit** — landed as `491ff04` (Step 4's Windows binary build remains pending CI)

```bash
git add native/ src/platform/windows-platform-services.ts tests/runtime/
git commit -m "feat(platform): Job Object process-tree helper for native Windows"
```

---

### Task 5: Select Windows implementation + Windows environment-essential set

**Files:**
- Modify: `src/platform/select-platform.ts` (delete `DiagnosticsOnlyPlatformServices`, return `WindowsPlatformServices` on win32; keep `UnsupportedPlatformError` export until nothing imports it, then remove)
- Modify: `src/runtime/environment-policy.ts`
- Modify: `src/mcp/doctor.ts` (drop the "diagnostics-only Windows platform" issue branch; keep honest capability reporting)
- Test: extend `tests/runtime/environment-policy.test.ts`, `tests/runtime/doctor.test.ts`

**Interfaces:**
- Consumes: `WindowsPlatformServices` (Tasks 2–4), `normalizeWindowsEnv`.
- Produces: `buildEnvironment({ os: "win32", ... })` seeds exactly `["SystemRoot","ComSpec","TEMP","TMP","USERPROFILE","APPDATA","LOCALAPPDATA","Path"]` from a case-normalized view of `process.env` (source `"platform"`), honors `tempHome` by overriding `USERPROFILE` (and `APPDATA`/`LOCALAPPDATA` under it: `<tempHome>\\AppData\\Roaming`, `<tempHome>\\AppData\\Local`), and still forces `CLAUDE_ARCHITECT_DELEGATED=1`.

- [x] **Step 1: Write failing tests** — with `process.env` polluted by `PATH` and `Path`, `buildEnvironment({os:"win32", adapterAllowlist:[]})` yields exactly one `Path`; `tempHome` set → `USERPROFILE === tempHome` and both AppData vars point under it; provenance entries sorted and sourced `"platform"`; POSIX behavior unchanged (regression: existing suite still green). Doctor test: on win32 selection, `doctor()` no longer emits the unsupported-platform issue.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement** — in `environment-policy.ts` replace the `args.os === "win32" ? [] : POSIX_ESSENTIAL_ENV` branch (`environment-policy.ts:145`) with a `WIN32_ESSENTIAL_ENV` list read through `normalizeWindowsEnv(process.env)`; keep the XDG skip logic POSIX-only; add the tempHome AppData overrides in the same place the POSIX `HOME` override lives (`:154-156`). `select-platform.ts` becomes:

```ts
import { PosixPlatformServices } from "./posix-platform-services.js";
import { WindowsPlatformServices } from "./windows-platform-services.js";
import type { PlatformServices } from "./platform-services.js";

let services: PlatformServices | undefined;
export function getPlatformServices(): PlatformServices {
  if (!services) services = process.platform === "win32"
    ? new WindowsPlatformServices()
    : new PosixPlatformServices();
  return services;
}
```

- [x] **Step 4: Run** — `npm run typecheck && npm test && npm run build` → all green, bundle byte-stable check via `bash scripts/validate-release.sh`.

- [x] **Step 5: Commit** — landed as `a9a0880`

```bash
git add src/platform/select-platform.ts src/runtime/environment-policy.ts src/mcp/doctor.ts tests/runtime/ runtime/server.mjs
git commit -m "feat(runtime): first-class Windows platform selection and essential environment"
```

---

### Task 6: Named sandbox backends with fail-closed selection

**Files:**
- Create: `src/platform/sandbox/backends.ts`
- Modify: `src/producers/codex-adapter.ts` (certification table → backend registry, `codex-adapter.ts:149-166`)
- Modify: `src/runtime/attempt-runtime.ts` (select backend from the capability report before spawn; fail closed)
- Test: `tests/runtime/sandbox-backends.test.ts`

**Interfaces:**
- Consumes: `CapabilityReport` (`producer-adapter.ts:12-26`).
- Produces:

```ts
export interface SandboxBackend {
  id: string;                                  // e.g. "codex-native-sandbox"
  kind: "producer-native" | "os";
  platforms: ReadonlyArray<{ os: "darwin" | "linux" | "win32"; arch?: string;
    environmentType: "native" | "wsl"; state: "certified" | "tested" | "unsupported" }>;
}
export function selectSandboxBackend(report: CapabilityReport):
  { backend: SandboxBackend; state: "certified" | "tested" } | { backend: null; reason: string };
```

Registry contents for 0.9.0 (states may only be PROMOTED by a real green CI/integration run in Task 9 — start Linux/Windows as `"unsupported"` and flip in Task 9 with evidence):

```ts
export const SANDBOX_BACKENDS: SandboxBackend[] = [{
  id: "codex-native-sandbox", kind: "producer-native",
  platforms: [
    { os: "darwin", arch: "arm64", environmentType: "native", state: "certified" }, // Seatbelt, P0-A proven
    { os: "linux",  environmentType: "native", state: "unsupported" },              // Landlock — flip after Task 9 gate
    { os: "win32",  environmentType: "native", state: "unsupported" },              // flip only with real confinement proof
  ],
}];
```

- [x] **Step 1: Write failing tests** — `selectSandboxBackend` returns the darwin/arm64 certified entry; returns `{backend:null, reason:"no-write-confinement-backend"}` for linux while unsupported; AttemptRuntime test (extend existing fake-producer harness in `tests/runtime/attempt-runtime.test.ts`): a fake report with `writeConfinementBackend: null` on the edit lane fails closed with the existing `unavailable`/`no-eligible-producer` classification and never spawns; a report naming an unknown backend id also fails closed.

- [x] **Step 2: Run to verify failure.**

- [x] **Step 3: Implement** — `backends.ts` as above; `codex-adapter.ts` replaces its inline `certified = darwin && arm64 && native` check with a registry lookup so certification lives in ONE place; `attempt-runtime.ts` validates the selected report's `writeConfinementBackend` against the registry right before environment build and maps a mismatch to the run's `unavailable` classification with reason `"unrecognized-write-confinement-backend"`.

- [x] **Step 4: Run** — focused + full suite + typecheck + build → green.

- [x] **Step 5: Commit** — landed as `083cd8f`

```bash
git add src/platform/sandbox/ src/producers/codex-adapter.ts src/runtime/attempt-runtime.ts tests/runtime/ runtime/server.mjs
git commit -m "feat(runtime): named write-confinement backends with fail-closed selection"
```

---

### Task 7: CRLF, env-key, and path-scope coverage (case / drive / UNC / Unicode)

**Files:**
- Modify: `src/verify/structural-verifier.ts` + `src/verify/project-verifier.ts` (only if the RED tests expose a gap — scope comparison must go through `canonicalizeForScope` on win32)
- Test: `tests/runtime/crlf-events.test.ts`, extend `tests/runtime/structural-verifier.test.ts`, `tests/runtime/environment-policy.test.ts`

**Interfaces:**
- Consumes: `codex-adapter.normalizeEvents` (already splits `/\r?\n/u`, `codex-adapter.ts:231`), `canonicalizeForScope` (Task 3), existing verifier scope checks.
- Produces: regression proof, not new API.

- [x] **Step 1: Write failing/regression tests**
  - CRLF: feed `normalizeEvents` a `SupervisedExit` whose stdout uses `\r\n` line endings and a BOM-free UTF-8 payload with a Unicode path (`src/ünï cödé/α.ts`); assert identical events to the `\n` variant. Also a mixed `\r\n`/`\n` stream.
  - Env keys: `normalizeWindowsEnv` fuzz cases — `TEMP`/`temp`/`Temp`, `ComSpec`/`COMSPEC`.
  - Path scope: structural-verifier case-evasion test already exists for case-insensitive forbidden scope; ADD drive-letter (`C:\repo` vs `c:\repo`) and UNC (`\\\\server\\share\\repo` prefix) cases as pure unit tests against the exported scope helper, win32-gated where a real filesystem is needed; ADD a space-and-Unicode worktree path e2e case on POSIX (temp dir named `wt ünïcode`) driving the existing fake-producer attempt to `verified-candidate`.

- [x] **Step 2: Run** — expect the CRLF and Unicode-path cases to PASS already (they are regression locks); expect drive/UNC scope cases to FAIL until the helper is wired into the verifiers' scope comparison on win32.

- [x] **Step 3: Implement the minimal scope fix** — route the verifiers' allowlist/forbidden comparisons through a platform-aware normalizer: on win32 lowercase + strip `\\\\?\\` prefix before prefix-compare; POSIX behavior byte-identical to today.

- [x] **Step 4: Run** — focused + full suite green on POSIX.

- [x] **Step 5: Commit** — landed as `a13ffd6`

```bash
git add src/verify/ tests/runtime/
git commit -m "test(runtime): CRLF events, Windows env keys, and case/drive/UNC path-scope coverage"
```

---

### Task 8: Full cross-session crash recovery

**Files:**
- Modify: `src/runtime/recovery-manager.ts`
- Modify: `docs/` operator notes (update-during-active-attempt contract paragraph, colocated with the Task 20 bootstrap operator doc)
- Test: extend `tests/runtime/recovery-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 token-checked kills; existing lock/prune/anchor recovery.
- Produces (extending `recoverStaleRuns()`; same return shape plus richer evidence):
  - **Orphan escalation:** when a recorded pid is alive AND its token matches (a genuinely live orphan from a dead session), first `requestCooperativeCancellation`-equivalent (SIGTERM / best-effort), wait the repository-standard 3s grace, then `terminateProcessTreeByPid(pid, token)`; record `escalation: "cooperative" | "forced"` in the recovery evidence.
  - **Cross-session lock races:** lock files now persist `{ pid, processToken }` JSON instead of the bare pid string (`posix-platform-services.ts:121`); reclaim only when the owner is dead OR token-mismatched; a live matching owner leaves the lock alone (today's live-lock-aware behavior, now token-hardened). Old bare-pid lock files parse as `{pid, processToken:null}`.
  - **Update-during-active-attempt:** no code — document that the previous `${CLAUDE_PLUGIN_ROOT}` stays live until `/reload-plugins`, and recovery on next start owns any run the old root left behind; add a test proving recovery of a run dir written by a *different* plugin-root path string.

- [ ] **Step 1: Write failing tests** — (a) live orphan with matching token: assert cooperative-then-forced ordering via an injected fake `PlatformServices` recording call order and a fake clock for the 3s grace; (b) lock owned by live pid with MISMATCHED token → reclaimed; live pid with matching token → untouched; (c) legacy bare-pid lock file → parsed, dead-owner reclaim still works; (d) run-start written under a stale plugin root → still recovered.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** — extend the lock write in both platform services to the JSON form via the shared `acquireWxFileLock`; extend `recovery-manager.ts` lock parsing (`bounded read + JSON.parse` fallback to bare integer), add the escalation sequence with the injectable clock/grace already used by the recovery test seam.

- [ ] **Step 4: Run** — focused recovery suite + full suite + typecheck + build → green.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/recovery-manager.ts src/platform/ docs/ tests/runtime/recovery-manager.test.ts runtime/server.mjs
git commit -m "feat(runtime): cross-session crash recovery with orphan escalation and token-hardened locks"
```

---

### Task 9: CI matrix, capability promotion, and the 0.9.0 release gate

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `src/platform/sandbox/backends.ts` (state promotions backed by green runs ONLY)
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`, `CHANGELOG.md` (→ `0.9.0`)
- Modify: `scripts/validate-release.sh` (require `native/bin/win32-job-kill-x64.exe` present + non-empty; version sync check for 0.9.0)
- Test: `tests/runtime/plugin-wiring.test.mjs` version expectations

**Interfaces:**
- Consumes: everything above.
- Produces: the shipped 0.9.0.

- [ ] **Step 1: Write the workflow**

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [macos-14, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - if: runner.os != 'Windows'
        run: bash scripts/validate-release.sh
```

- [ ] **Step 2: Push a branch, confirm all three legs green.** Windows leg must run the win32-gated suites (Tasks 3, 4, 7) for real. Expected: green ×3.

- [ ] **Step 3: Promote backend states with evidence** — flip `linux/native` for `codex-native-sandbox` to `"tested"` only if a real Linux confinement integration test (mirror of the P0-A macOS gate in `codex-adapter.test.ts`: inside-worktree marker created, outside-home marker blocked) passes on the Linux leg or a local Linux box; leave win32 `"unsupported"` unless the same proof exists. Update README support matrix to say exactly what the states say — no aspirational rows. Record the evidence (CI run URL) in CHANGELOG.

- [ ] **Step 4: Version sync + release validation** — bump all `0.8.0` → `0.9.0` metadata; extend `validate-release.sh` with the native-binary presence check; run:

```bash
npm run typecheck && npm test && npm run build && bash scripts/validate-release.sh
```

Expected: all green, byte-stable bundle.

- [ ] **Step 5: P0-B gate checklist (do not tag until every box is checked)**
  - [ ] CI green on macOS, Linux, Windows for every claimed matrix entry.
  - [ ] Space/Unicode paths covered for project, plugin, temp, and Producer paths (Task 7 e2e case + Windows leg).
  - [ ] Cooperative cancellation and forced termination leave no descendants (Task 4 fixture, all OSes).
  - [ ] Worktree create/remove/stale-recovery/lock-release covered incl. native Windows locked-file behavior (win32-gated: removal retries on `EBUSY`-style errors — add the retry if the Windows leg exposes it).
  - [ ] Path-scope enforcement tested with case/drive/UNC (Task 7).
  - [ ] Producer discovery covers native executables and trusted `.cmd` wrappers (Task 2).
  - [ ] CRLF/LF event parsing (Task 7); Windows `Path`/`PATH` normalization (Tasks 2, 5).
  - [ ] Main-checkout integrity checks pass on all OSes (existing integrator suite on the CI matrix).
  - [ ] Marketplace install/update smoke on macOS + Windows native (+ WSL reported as Linux) with and without Git Bash — manual checklist, record results in CHANGELOG.
  - [ ] Tag: `git tag -a v0.9.0 -m "v0.9.0 — P0-B cross-platform hardening"` and push, then update/reload installed copy and re-run `doctor`.

- [ ] **Step 6: Commit + release**

```bash
git add .github/ .claude-plugin/ README.md CHANGELOG.md scripts/validate-release.sh src/platform/sandbox/backends.ts tests/
git commit -m "chore(release): 0.9.0 cross-platform hardening gate"
```

---

## Self-Review

**Spec coverage (B1–B6 → tasks):** B1 → Tasks 2–3 (PATHEXT tiers, env normalization, drive/UNC/Unicode, Windows locking). B2 → Task 4 (Job Object helper, no shipped shell script, fork-bomb-lite acceptance). B3 → Task 5 (selection + Windows essential env). B4 → Task 6 (named backends, fail-closed, supervision ≠ confinement). B5 → Task 7 (CRLF, env keys, case/drive/UNC scope). B6 → Tasks 1 + 8 (token-hardened kills, orphan escalation, cross-session lock reclaim, update-during-attempt). Release gates → Task 9. PID process-identity protection (deferred P0-A boundary) → Task 1.

**Known constraint surfaced:** Tasks 3, 4, and the Windows CI leg require a real Windows environment; the plan keeps every suite green on POSIX via `describe.runIf` gating, and Task 9 is where Windows evidence is actually produced. Backend states start `unsupported` and are only promoted with recorded evidence — the plan cannot silently over-claim.

**Type consistency check:** `getProcessStartToken`/`terminateProcessTreeByPid(pid, expectedToken?)` used identically in Tasks 1, 3, 4, 8; `RunStartRecord.processToken: string | null` matches between attempt-runtime and recovery-manager; `canonicalizeForScope` defined Task 3, consumed Task 7; `acquireWxFileLock` extracted Task 3, extended Task 8; `selectSandboxBackend` defined Task 6, promoted Task 9.
