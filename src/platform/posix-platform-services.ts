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
  CanonicalPath, CheckoutLock, ExecutableRequest, FileLock, PlatformServices, ResolvedExecutable,
  SpawnRequest, SupervisedExit, SupervisedProcess,
} from "./platform-services.js";

const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = 2500;

// Fixed 64-hex key for the state-dir-scoped cleanup-journal mutex. sha256 so it
// matches the recovery lock-name pattern and is reclaimed like any dead lock, and
// distinct (by domain prefix) from checkout locks keyed on a repository identity.
export const CLEANUP_JOURNAL_LOCK_KEY =
  createHash("sha256").update("claude-architect:cleanup-journal:v1").digest("hex");

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function acquireWxFileLock(
  key: string,
  timeoutMessage?: string,
  ownerToken: string | null = null,
): Promise<Omit<CheckoutLock, "repositoryIdentity">> {
  const lockDirectory = path.join(resolveStateDir(), "locks");
  const lockPath = path.join(lockDirectory, `${key}.lock`);
  await fs.mkdir(lockDirectory, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const ownerPid = nodeProcess.pid;
      try {
        await handle.writeFile(JSON.stringify({ pid: ownerPid, processToken: ownerToken }));
      }
      finally { await handle.close(); }
      return {
        key,
        release: async () => {
          let recordedOwner: unknown;
          try { recordedOwner = JSON.parse(await fs.readFile(lockPath, "utf8")); }
          catch { return; }
          if (!isRecord(recordedOwner)
            || recordedOwner.pid !== ownerPid
            || recordedOwner.processToken !== ownerToken) return;
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new RuntimeError(timeoutMessage ?? `lock is held: ${key}`, { key });
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  async getProcessStartToken(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return null;
    if (nodeProcess.platform === "linux") {
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const afterComm = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const starttime = afterComm[19];
        return starttime ? `linux:${starttime}` : null;
      } catch {
        return null;
      }
    }
    return new Promise(resolve => {
      try {
        execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
          const line = stdout.trim();
          resolve(error || line.length === 0 ? null : `darwin:${line}`);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async terminateProcessTreeByPid(pid: number, expectedToken?: string | null): Promise<void> {
    if (typeof expectedToken === "string") {
      const liveToken = await this.getProcessStartToken(pid);
      if (liveToken !== expectedToken) return;
    }
    killProcessGroup(pid, "SIGKILL");
  }

  async acquireCheckoutLock(checkout: string): Promise<CheckoutLock> {
    const { canonical, gitCommonDir: commonDir } = await this.canonicalizePath(checkout);
    const repositoryIdentity = commonDir ?? canonical;
    const key = createHash("sha256").update(repositoryIdentity).digest("hex");
    const ownerToken = await this.getProcessStartToken(nodeProcess.pid);
    const lock = await acquireWxFileLock(key, `checkout is locked: ${checkout}`, ownerToken);
    return { ...lock, repositoryIdentity };
  }

  async acquireCleanupJournalLock(): Promise<FileLock> {
    const ownerToken = await this.getProcessStartToken(nodeProcess.pid);
    return acquireWxFileLock(CLEANUP_JOURNAL_LOCK_KEY, "cleanup journal is locked", ownerToken);
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
