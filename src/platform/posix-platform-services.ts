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
import { lockOwnerStatus, parseLockOwner, type LockOwnerStatus } from "./lock-owner.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, FileLock, LockOwnerAnnotation, PlatformServices,
  ResolvedExecutable, SpawnRequest, SupervisedExit, SupervisedProcess,
} from "./platform-services.js";

const LOCK_RETRY_MS = 30;
const LOCK_TIMEOUT_MS = 2500;
// The owner probe shells out to `ps` on darwin. Bound it: a diagnostic must
// never turn a lock timeout that was about to return into an indefinite hang.
const OWNER_PROBE_TIMEOUT_MS = 1000;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

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

export function lockFilePath(key: string): string {
  return path.join(resolveStateDir(), "locks", `${key}.lock`);
}

export async function acquireWxFileLock(
  key: string,
  timeoutMessage?: string,
  ownerToken: string | null = null,
  owner: LockOwnerAnnotation = {},
): Promise<Omit<CheckoutLock, "repositoryIdentity">> {
  const lockPath = lockFilePath(key);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const ownerPid = nodeProcess.pid;
      // pid and processToken are load-bearing: startup recovery reclaims a lock
      // only when they prove the owner is gone. The remaining fields are read
      // by nothing but contention diagnostics and must never gate reclamation.
      const record = {
        pid: ownerPid,
        processToken: ownerToken,
        acquiredAt: new Date().toISOString(),
        ...(owner.runId === undefined ? {} : { runId: owner.runId }),
      };
      try { await handle.writeFile(JSON.stringify(record)); }
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

function processIsAlive(pid: number): boolean {
  try { nodeProcess.kill(pid, 0); return true; }
  // EPERM means the pid exists but belongs to another user: alive, not absent.
  catch (error) { return errorCode(error) === "EPERM"; }
}

function heldFor(acquiredAt: unknown): string {
  if (typeof acquiredAt !== "string") return "";
  const startedMs = Date.parse(acquiredAt);
  if (!Number.isFinite(startedMs)) return "";
  const elapsedMs = Date.now() - startedMs;
  if (elapsedMs < 0) return "";
  return `, held for ${Math.round(elapsedMs / 1000)}s`;
}

function heldByRun(runId: unknown): string {
  return typeof runId === "string" && SAFE_RUN_ID.test(runId) ? `, run ${runId}` : "";
}

/**
 * Explains a lock-acquisition timeout in terms of what the holder actually is.
 *
 * "checkout is locked" alone cannot be acted on: a live sibling session clears
 * on its own, a leaked file clears at the next server start, and a lock whose
 * record recovery refuses to parse clears only when a human deletes it. The
 * three demand different responses and used to be indistinguishable.
 *
 * Strictly best-effort. Every failure path returns null and leaves the original
 * error untouched, because a diagnostic that can fail an operation harder than
 * no diagnostic at all is worse than none. The owner's process token is used to
 * derive a status and is never reported.
 */
export async function describeLockContention(
  key: string,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<string | null> {
  let contents: string;
  try { contents = await fs.readFile(lockFilePath(key), "utf8"); }
  catch { return null; }

  const owner = parseLockOwner(contents);
  if (owner === null) {
    return "its owner cannot be identified, and startup recovery preserves a lock "
      + `it cannot parse, so remove it by hand: ${lockFilePath(key)}`;
  }

  const annotations: unknown = (() => {
    try { return JSON.parse(contents.trim()); }
    catch { return {}; }
  })();
  const extras = isRecord(annotations)
    ? `${heldByRun(annotations.runId)}${heldFor(annotations.acquiredAt)}`
    : "";

  let status: LockOwnerStatus;
  try {
    status = await lockOwnerStatus(
      owner,
      processIsAlive,
      pid => withTimeout(getProcessStartToken(pid), OWNER_PROBE_TIMEOUT_MS, null),
    );
  } catch { return null; }

  if (status === "dead") {
    return `it was left behind by a process that exited (pid ${owner.pid}${extras}); `
      + "startup recovery reclaims it on the next server start";
  }
  if (status === "unverifiable") {
    return `it is held by pid ${owner.pid}${extras}, whose identity could not be `
      + "verified; startup recovery preserves it until that changes";
  }
  const self = owner.pid === nodeProcess.pid ? " (this same process)" : "";
  return `it is held by live pid ${owner.pid}${self}${extras}`;
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void work.then(
      value => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/**
 * Wraps a checkout-lock timeout with holder detail. Enrichment failures are
 * swallowed so the caller still sees the original, accurate timeout.
 */
export async function withLockContentionDetail(
  error: unknown,
  key: string,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<unknown> {
  if (!(error instanceof RuntimeError)) return error;
  let description: string | null;
  try { description = await describeLockContention(key, getProcessStartToken); }
  catch { return error; }
  if (description === null) return error;
  return new RuntimeError(`${error.message} — ${description}`, { ...error.detail, key });
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

  async acquireCheckoutLock(
    checkout: string,
    owner: LockOwnerAnnotation = {},
  ): Promise<CheckoutLock> {
    const { canonical, gitCommonDir: commonDir } = await this.canonicalizePath(checkout);
    const repositoryIdentity = commonDir ?? canonical;
    const key = createHash("sha256").update(repositoryIdentity).digest("hex");
    const ownerToken = await this.getProcessStartToken(nodeProcess.pid);
    let lock;
    try {
      lock = await acquireWxFileLock(key, `checkout is locked: ${checkout}`, ownerToken, owner);
    } catch (error) {
      throw await withLockContentionDetail(
        error, key, pid => this.getProcessStartToken(pid),
      );
    }
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
