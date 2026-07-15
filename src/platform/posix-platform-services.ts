import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeProcess from "node:process";
import { resolveStateDir } from "../runtime/state-dir.js";
import { BoundedBuffer } from "../util/bounded-buffer.js";
import { RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, PlatformServices, ResolvedExecutable,
  SpawnRequest, SupervisedExit, SupervisedProcess,
} from "./platform-services.js";

const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = 2500;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gitCommonDir(cwd: string): Promise<string> {
  // Intentional bootstrap exception until Task 8 provides the shared argv-based Git helper.
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // pid <= 1 is never a valid spawned-child group: -1 is the "no pid" sentinel from a failed
  // spawn(), 0 means "current process group", and 1 is init/a container's PID-1 entrypoint.
  // Negating any of these into process.kill(-pid, ...) would signal a group we must never touch.
  if (pid <= 1) {
    logger.warn("skipped process-group terminate for invalid pid", { pid, signal });
    return;
  }
  try { nodeProcess.kill(-pid, signal); }
  catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
}

export class PosixPlatformServices implements PlatformServices {
  readonly os = nodeProcess.platform === "darwin" ? "darwin" : "linux";

  async resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable> {
    if (request.explicitPath !== undefined) {
      try { await fs.access(request.explicitPath, constants.X_OK); }
      catch (cause) { throw new RuntimeError(`executable is not accessible: ${request.explicitPath}`, { cause }); }
      return {
        kind: "native", command: request.explicitPath, prefixArgs: [],
        resolvedFrom: `explicit:${request.explicitPath}`,
      };
    }
    for (const directory of (request.searchPath ?? nodeProcess.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(directory, request.name);
      try {
        await fs.access(candidate, constants.X_OK);
        return { kind: "native", command: candidate, prefixArgs: [], resolvedFrom: `path:${candidate}` };
      } catch { /* continue searching PATH */ }
    }
    throw new RuntimeError(`executable not found on PATH: ${request.name}`);
  }

  async spawnSupervised(req: SpawnRequest): Promise<SupervisedProcess> {
    const child = spawn(req.executable.command, [...req.executable.prefixArgs, ...req.args], {
      cwd: req.cwd, env: req.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const outBuf = new BoundedBuffer(req.maxOutputBytes), errBuf = new BoundedBuffer(req.maxOutputBytes);
    child.stdout.on("data", (c: Buffer) => outBuf.push(c));   // always drain, even after truncation, to avoid deadlock
    child.stderr.on("data", (c: Buffer) => errBuf.push(c));
    if (req.stdin != null) { child.stdin?.on("error", () => {}); child.stdin?.write(req.stdin); child.stdin?.end(); }
    let settled = false;
    const done = new Promise<SupervisedExit>((resolve) => {
      const finish = (e: SupervisedExit) => { if (!settled) { settled = true; resolve(e); } };
      // MANDATORY: without this, a failed spawn (ENOENT/EACCES) emits 'error' with no listener → uncaught
      // exception crashes the MCP server. Instead settle done with a spawn-failure marker.
      child.on("error", (err) => finish({
        exitCode: null, signal: null, timedOut: false, cancelled: false,
        stdout: outBuf.toString(), stderr: errBuf.toString(),
        truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated }, spawnError: err,
      }));
      child.on("close", (code, signal) => finish({
        exitCode: code, signal: signal as NodeJS.Signals | null, timedOut: false, cancelled: false,
        stdout: outBuf.toString(), stderr: errBuf.toString(),
        truncated: { stdout: outBuf.truncated, stderr: errBuf.truncated },
      }));
    });
    return { pid: child.pid ?? -1, done, stdout: child.stdout, stderr: child.stderr };
  }

  async requestCooperativeCancellation(proc: SupervisedProcess): Promise<void> {
    killProcessGroup(proc.pid, "SIGTERM");
  }

  async terminateProcessTree(proc: SupervisedProcess): Promise<void> {
    killProcessGroup(proc.pid, "SIGKILL");
  }

  async terminateProcessTreeByPid(pid: number): Promise<void> {
    killProcessGroup(pid, "SIGKILL");
  }

  async acquireCheckoutLock(checkout: string): Promise<CheckoutLock> {
    const { canonical, gitCommonDir: commonDir } = await this.canonicalizePath(checkout);
    const key = createHash("sha256").update(commonDir ?? canonical).digest("hex");
    const lockDirectory = path.join(resolveStateDir(), "locks");
    const lockPath = path.join(lockDirectory, `${key}.lock`);
    await fs.mkdir(lockDirectory, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        try { await handle.writeFile(String(nodeProcess.pid)); }
        finally { await handle.close(); }
        return { key, release: async () => { await fs.rm(lockPath, { force: true }); } };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new RuntimeError(`checkout is locked: ${checkout}`, { key });
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  async createSecureTempDirectory(): Promise<string> {
    return fs.mkdtemp(path.join(tmpdir(), "claude-architect-"));
  }

  async canonicalizePath(input: string): Promise<CanonicalPath> {
    const canonical = await fs.realpath(input);
    let commonDir: string | null = null;
    try { commonDir = await fs.realpath(await gitCommonDir(canonical)); }
    catch { commonDir = null; }
    return { input, canonical, gitCommonDir: commonDir };
  }
}
