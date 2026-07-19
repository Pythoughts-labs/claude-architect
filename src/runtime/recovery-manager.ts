import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { RuntimeError } from "../util/errors.js";
import { ArtifactStore } from "./artifact-store.js";
import { resolveStateDir } from "./state-dir.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_STATE_FILE_BYTES = 8_000_000;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]*$/;
const LOCK_NAME = /^([0-9a-f]{64})\.lock$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";

interface RunStartRecord {
  runId: string;
  lockKey: string;
  canonicalCommonDir: string;
  pid: number | null;
  processToken: string | null;
  startedAt: string;
}

type PruneReason = "max-age" | "max-bytes";
type AnchorCleanup = "not-applicable" | "deleted" | "already-absent";

interface CleanupRecord {
  event: "prune-cleanup-intent" | "prune-cleanup-complete" | "prune-cleanup-rollback";
  runId: string;
  reason: PruneReason;
  anchorCleanup: AnchorCleanup | "pending";
  archiveBytes: number;
  quarantineName: string;
  repoRoot: string | null;
  anchorRef: string | null;
  backupRef: string | null;
  candidateCommitOid: string | null;
  recordedAt: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export interface RecoveryDependencies {
  platformServices?: Pick<PlatformServices, "os" | "getProcessStartToken" | "terminateProcessTreeByPid">;
  isProcessAlive?: (pid: number) => boolean;
  requestCooperativeTermination?: (pid: number) => void | Promise<void>;
  delayMs?: (ms: number) => Promise<void>;
  graceMs?: number;
}

interface LockOwner {
  pid: number;
  processToken: string | null;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isPlainDirectory(metadata: Awaited<ReturnType<typeof lstat>>): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function sameIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expected: DirectoryIdentity,
): boolean {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function validateRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId)) {
    throw new RuntimeError("recovery record has an invalid run id");
  }
}

async function stateRoot(): Promise<string | null> {
  const configured = nodeProcess.env.CLAUDE_PLUGIN_DATA
    ?? (nodeProcess.env.NODE_ENV === "test"
      ? nodeProcess.env.CLAUDE_ARCHITECT_STATE_DIR
      : undefined);
  if (configured === undefined) return null;
  const root = path.resolve(resolveStateDir());
  try {
    const metadata = await lstat(root);
    if (!isPlainDirectory(metadata)) {
      throw new RuntimeError("plugin data directory must be a plain directory during recovery");
    }
    await realpath(root);
    return root;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readBoundedRegularFile(filename: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATE_FILE_BYTES) {
      throw new RuntimeError("recovery state entry is not a bounded regular file");
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readCleanupJournal(filename: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDWR | NO_FOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATE_FILE_BYTES) {
      throw new RuntimeError("cleanup journal is not a bounded regular file");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (text === "" || text.endsWith("\n")) return text;
    const finalNewline = text.lastIndexOf("\n");
    const completePrefix = finalNewline === -1 ? "" : text.slice(0, finalNewline + 1);
    await handle.truncate(Buffer.byteLength(completePrefix, "utf8"));
    await handle.sync();
    return completePrefix;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function plainDirectoryIdentity(directory: string): Promise<DirectoryIdentity | null> {
  try {
    const metadata = await lstat(directory);
    if (!isPlainDirectory(metadata)) {
      throw new RuntimeError("recovery directory must not be a symbolic link");
    }
    return { dev: metadata.dev, ino: metadata.ino };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function removePlainDirectory(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(directory);
  if (!isPlainDirectory(metadata) || !sameIdentity(metadata, expected)) {
    throw new RuntimeError("recovery directory identity changed before removal");
  }
  await rm(directory, { recursive: true, force: false });
}

function parseRunStart(text: string, expectedRunId: string): RunStartRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RuntimeError("run-start recovery record is invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("run-start recovery record must be an object");
  }
  const record = value as Partial<RunStartRecord>;
  validateRunId(record.runId);
  if (record.runId !== expectedRunId
    || typeof record.lockKey !== "string"
    || !/^[0-9a-f]{64}$/.test(record.lockKey)
    || typeof record.canonicalCommonDir !== "string"
    || !path.isAbsolute(record.canonicalCommonDir)
    || (record.pid !== null
      && (record.pid === undefined || !Number.isSafeInteger(record.pid) || record.pid <= 1))
    || (record.processToken !== undefined
      && record.processToken !== null
      && typeof record.processToken !== "string")
    || typeof record.startedAt !== "string"
    || !Number.isFinite(Date.parse(record.startedAt))) {
    throw new RuntimeError("run-start recovery record is malformed");
  }
  const expectedLockKey = createHash("sha256")
    .update(record.canonicalCommonDir)
    .digest("hex");
  if (record.lockKey !== expectedLockKey) {
    throw new RuntimeError("run-start lock key does not match its canonical common directory");
  }
  return { ...record, processToken: record.processToken ?? null } as RunStartRecord;
}

function validateTerminalResult(result: unknown, runId: string): void {
  if (typeof result !== "object" || result === null) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
  const value = result as { resultVersion?: unknown; runId?: unknown; status?: unknown };
  if (value.resultVersion !== "1"
    || value.runId !== runId
    || typeof value.status !== "string"
    || !["unavailable", "failed", "cancelled", "verified-candidate"].includes(value.status)) {
    throw new RuntimeError("terminal attempt result is malformed during recovery");
  }
}

function runGitError(action: string, result: GitResult): RuntimeError {
  const diagnostic = (result.stderr || result.stdout).trim().slice(0, 2_000);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function validateGitCommonDir(commonDir: string): Promise<string> {
  const canonical = await realpath(commonDir);
  if (canonical !== commonDir) {
    throw new RuntimeError("recorded Git common directory is no longer canonical");
  }
  const result = await git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (result.exitCode !== 0) throw runGitError("validate Git common directory", result);
  const reported = await realpath(result.stdout.trim());
  if (reported !== canonical) {
    throw new RuntimeError("recorded Git common directory no longer identifies the repository");
  }
  return canonical;
}

async function validateRepositoryRoot(repoRoot: string): Promise<string> {
  if (!path.isAbsolute(repoRoot)) {
    throw new RuntimeError("cleanup journal repository root is not absolute");
  }
  const canonical = await realpath(repoRoot);
  if (canonical !== repoRoot) {
    throw new RuntimeError("cleanup journal repository root is no longer canonical");
  }
  const result = await git(canonical, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw runGitError("validate cleanup repository", result);
  if (await realpath(result.stdout.trim()) !== canonical) {
    throw new RuntimeError("cleanup journal repository root is not the repository top level");
  }
  return canonical;
}

async function readDirectRef(repoRoot: string, ref: string): Promise<string | null> {
  const symbolic = await git(repoRoot, ["symbolic-ref", "--quiet", ref]);
  if (symbolic.exitCode === 0) {
    throw new RuntimeError("recovery refuses to mutate a symbolic Git ref");
  }
  if (symbolic.exitCode !== 1) throw runGitError("inspect symbolic Git ref", symbolic);
  const direct = await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (direct.exitCode === 1) return null;
  if (direct.exitCode !== 0 || !OID.test(direct.stdout.trim())) {
    throw runGitError("inspect Git ref", direct);
  }
  return direct.stdout.trim();
}

async function deleteExactRef(repoRoot: string, ref: string, oid: string): Promise<void> {
  const result = await git(repoRoot, ["update-ref", "--no-deref", "-d", ref, oid]);
  if (result.exitCode !== 0) throw runGitError("delete recovery Git ref", result);
}

async function createExactRef(repoRoot: string, ref: string, oid: string): Promise<void> {
  const result = await git(repoRoot, [
    "update-ref",
    "--no-deref",
    ref,
    oid,
    "0".repeat(oid.length),
  ]);
  if (result.exitCode !== 0) throw runGitError("create recovery Git ref", result);
}

async function removeStaleCandidateAnchor(repoRoot: string, runId: string): Promise<void> {
  const ref = `${CANDIDATE_REF_PREFIX}${runId}`;
  const oid = await readDirectRef(repoRoot, ref);
  if (oid !== null) await deleteExactRef(repoRoot, ref, oid);
}

function parseCleanupRecord(line: string): CleanupRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new RuntimeError("cleanup journal contains invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("cleanup journal record must be an object");
  }
  const record = value as Partial<CleanupRecord>;
  validateRunId(record.runId);
  if (!(["prune-cleanup-intent", "prune-cleanup-complete", "prune-cleanup-rollback"] as const)
    .includes(record.event as CleanupRecord["event"])
    || !(["max-age", "max-bytes"] as const).includes(record.reason as PruneReason)
    || !(["pending", "not-applicable", "deleted", "already-absent"] as const)
      .includes(record.anchorCleanup as CleanupRecord["anchorCleanup"])
    || !Number.isSafeInteger(record.archiveBytes)
    || (record.archiveBytes ?? -1) < 0
    || typeof record.quarantineName !== "string"
    || record.quarantineName !== `.prune-${record.runId}-${record.quarantineName
      .slice(`.prune-${record.runId}-`.length)}`
    || !/^\.prune-[a-z0-9][a-z0-9._-]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      record.quarantineName,
    )
    || typeof record.recordedAt !== "string"
    || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new RuntimeError("cleanup journal record is malformed");
  }
  if (record.event === "prune-cleanup-intent" && record.anchorCleanup !== "pending") {
    throw new RuntimeError("cleanup intent must remain pending until reconciled");
  }
  if (record.event !== "prune-cleanup-intent" && record.anchorCleanup === "pending") {
    throw new RuntimeError("terminal cleanup journal record cannot remain pending");
  }

  const hasRepository = typeof record.repoRoot === "string"
    && typeof record.anchorRef === "string"
    && typeof record.candidateCommitOid === "string";
  const noRepository = record.repoRoot === null
    && record.anchorRef === null
    && record.backupRef === null
    && record.candidateCommitOid === null;
  if (!noRepository && (!hasRepository
    || record.anchorRef !== `${CANDIDATE_REF_PREFIX}${record.runId}`
    || !OID.test(record.candidateCommitOid as string)
    || (record.backupRef !== null
      && record.backupRef !== `${BACKUP_REF_PREFIX}${record.runId}`))) {
    throw new RuntimeError("cleanup journal Git metadata is malformed");
  }
  return record as CleanupRecord;
}

function cleanupOutcome(record: CleanupRecord): AnchorCleanup {
  if (record.repoRoot === null) return "not-applicable";
  return record.backupRef === null ? "already-absent" : "deleted";
}

async function appendCleanupRecord(runsRoot: string, record: CleanupRecord): Promise<void> {
  const identity = await plainDirectoryIdentity(runsRoot);
  if (identity === null) throw new RuntimeError("cleanup journal root disappeared");
  const filename = path.join(runsRoot, "cleanup.ndjson");
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
    0o600,
  );
  try {
    const metadata = await handle.stat();
    const currentRoot = await lstat(runsRoot);
    if (!metadata.isFile() || !isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, identity)) {
      throw new RuntimeError("cleanup journal identity changed during recovery");
    }
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const currentRoot = await lstat(runsRoot);
  if (!isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, identity)) {
    throw new RuntimeError("cleanup journal root changed after recovery append");
  }
}

async function reconcileCleanupRefs(
  record: CleanupRecord,
  action: "finish" | "rollback",
): Promise<AnchorCleanup> {
  const outcome = cleanupOutcome(record);
  if (outcome === "not-applicable") return outcome;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const anchorRef = record.anchorRef!;
  const candidateOid = record.candidateCommitOid!;
  let anchorOid = await readDirectRef(repoRoot, anchorRef);
  if (anchorOid !== null && anchorOid !== candidateOid) {
    throw new RuntimeError("candidate anchor moved during interrupted prune recovery");
  }
  if (outcome === "already-absent") {
    if (anchorOid !== null) {
      throw new RuntimeError("candidate anchor unexpectedly reappeared during prune recovery");
    }
    return outcome;
  }

  const backupRef = record.backupRef!;
  let backupOid = await readDirectRef(repoRoot, backupRef);
  if (backupOid !== null && backupOid !== candidateOid) {
    throw new RuntimeError("candidate prune backup moved during recovery");
  }
  if (action === "finish") {
    if (anchorOid !== null && backupOid === null) {
      await createExactRef(repoRoot, backupRef, candidateOid);
      backupOid = candidateOid;
    }
    if (anchorOid !== null) {
      await deleteExactRef(repoRoot, anchorRef, candidateOid);
      anchorOid = null;
    }
    return outcome;
  }

  if (anchorOid === null) {
    if (backupOid === null) {
      throw new RuntimeError("cannot restore candidate anchor without its prune backup");
    }
    await createExactRef(repoRoot, anchorRef, candidateOid);
    anchorOid = candidateOid;
  }
  if (backupOid !== null) await deleteExactRef(repoRoot, backupRef, candidateOid);
  return outcome;
}

async function commitCleanupRefs(record: CleanupRecord): Promise<void> {
  if (cleanupOutcome(record) !== "deleted") return;
  const repoRoot = await validateRepositoryRoot(record.repoRoot!);
  const backupOid = await readDirectRef(repoRoot, record.backupRef!);
  if (backupOid === null) return;
  if (backupOid !== record.candidateCommitOid) {
    throw new RuntimeError("candidate prune backup moved before cleanup commit");
  }
  await deleteExactRef(repoRoot, record.backupRef!, backupOid);
}

async function replayInterruptedPrunes(runsRoot: string): Promise<void> {
  const text = await readCleanupJournal(path.join(runsRoot, "cleanup.ndjson"));
  if (text === null || text.trim() === "") return;
  const pending = new Map<string, CleanupRecord>();
  for (const line of text.trimEnd().split("\n")) {
    if (line.trim() === "") throw new RuntimeError("cleanup journal contains a blank record");
    const record = parseCleanupRecord(line);
    if (record.event === "prune-cleanup-intent") pending.set(record.runId, record);
    else pending.delete(record.runId);
  }

  for (const record of [...pending.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId))) {
    const runDirectory = path.join(runsRoot, record.runId);
    const quarantinePath = path.join(runsRoot, record.quarantineName);
    const runIdentity = await plainDirectoryIdentity(runDirectory);
    const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
    if (runIdentity !== null && quarantineIdentity !== null) {
      throw new RuntimeError("both retained and quarantined run archives exist during recovery");
    }
    const action = runIdentity !== null ? "rollback" : "finish";
    const outcome = await reconcileCleanupRefs(record, action);
    if (action === "finish") {
      if (quarantineIdentity !== null) {
        await removePlainDirectory(quarantinePath, quarantineIdentity);
      }
      await commitCleanupRefs(record);
    }
    await appendCleanupRecord(runsRoot, {
      ...record,
      event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
      anchorCleanup: outcome,
      recordedAt: new Date().toISOString(),
    });
  }
}

async function recoverRun(
  record: RunStartRecord,
  root: string,
  ps: Pick<PlatformServices, "os" | "getProcessStartToken" | "terminateProcessTreeByPid">,
  isProcessAlive: (pid: number) => boolean,
  requestCooperativeTermination: (pid: number) => void | Promise<void>,
  delayMs: (ms: number) => Promise<void>,
  graceMs: number,
): Promise<void> {
  let escalation: "cooperative" | "forced" | undefined;
  if (record.pid !== null && isProcessAlive(record.pid)) {
    const liveToken = record.processToken === null
      ? null
      : await ps.getProcessStartToken(record.pid);
    if (record.processToken === null || liveToken === record.processToken) {
      await requestCooperativeTermination(record.pid);
      await delayMs(graceMs);
      if (isProcessAlive(record.pid)) {
        await ps.terminateProcessTreeByPid(record.pid, record.processToken);
        escalation = "forced";
      } else {
        escalation = "cooperative";
      }
    }
  }
  const commonDir = await validateGitCommonDir(record.canonicalCommonDir);
  const store = new ArtifactStore(record.runId);
  const logsRef = await store.writeLog(
    "recovery",
    "startup recovery reclaimed unfinished run\n",
  );
  for (const managedId of [
    record.runId,
    `baseline-${record.runId}`,
    `verify-${record.runId}`,
    `${record.runId}-pipeline`,
    `${record.runId}-verify`,
  ]) {
    const worktreePath = path.join(root, "worktrees", managedId);
    const worktreeIdentity = await plainDirectoryIdentity(worktreePath);
    if (worktreeIdentity !== null) {
      await new WorktreeManager(commonDir, managedId, ps).remove(worktreePath);
    }
  }
  await removeStaleCandidateAnchor(commonDir, record.runId);
  await store.writeResult({
    resultVersion: "1",
    runId: record.runId,
    status: "cancelled",
    failure: "cancelled",
    summary: "Interrupted attempt was cancelled during startup recovery.",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: ["attempt-interrupted-before-terminal-result"],
    evidence: {
      recovery: "startup-stale-run",
      originalStartedAt: record.startedAt,
      ...(escalation === undefined ? {} : { escalation }),
    },
    logsRef,
    producerId: null,
    producerVersion: null,
    producerModel: null,
    durationMs: Math.max(0, Date.now() - Date.parse(record.startedAt)),
    sessionId: null,
  });
}

function defaultRequestCooperativeTermination(pid: number): void {
  try { nodeProcess.kill(pid, "SIGTERM"); }
  catch { /* process already exited */ }
}

function defaultDelayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseLockOwner(contents: string): LockOwner | null {
  const trimmed = contents.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 1 ? { pid, processToken: null } : null;
  }
  let value: unknown;
  try { value = JSON.parse(trimmed); }
  catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const owner = value as { pid?: unknown; processToken?: unknown };
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
    || (owner.processToken !== null && typeof owner.processToken !== "string")) return null;
  return { pid: owner.pid, processToken: owner.processToken };
}

async function lockOwnerIsLive(
  owner: LockOwner | null,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  if (owner === null || !isProcessAlive(owner.pid)) return false;
  return owner.processToken === null
    || await getProcessStartToken(owner.pid) === owner.processToken;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    nodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "EPERM") return true;
    if (errorCode(error) === "ESRCH") return false;
    throw error;
  }
}

async function reclaimLocks(
  locksRoot: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<void> {
  let entries;
  try {
    const rootIdentity = await plainDirectoryIdentity(locksRoot);
    if (rootIdentity === null) return;
    entries = await readdir(locksRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const match = LOCK_NAME.exec(entry.name);
    if (match === null) continue;
    const lockPath = path.join(locksRoot, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new RuntimeError("checkout lock must be a regular file during recovery");
    }
    const contents = await readBoundedRegularFile(lockPath);
    if (contents === null) continue;
    if (await lockOwnerIsLive(parseLockOwner(contents), isProcessAlive, getProcessStartToken)) continue;
    const identity = await lstat(lockPath);
    if (!identity.isFile() || identity.isSymbolicLink()) {
      throw new RuntimeError("checkout lock identity changed during recovery");
    }
    await rm(lockPath, { force: false });
  }
}

async function lockIsOwnedByLiveProcess(
  locksRoot: string,
  lockKey: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const contents = await readBoundedRegularFile(path.join(locksRoot, `${lockKey}.lock`));
  if (contents === null) return false;
  return lockOwnerIsLive(parseLockOwner(contents), isProcessAlive, getProcessStartToken);
}

export async function recoverStaleRuns(
  dependencies: RecoveryDependencies = {},
): Promise<{ recovered: string[] }> {
  const root = await stateRoot();
  if (root === null) return { recovered: [] };
  const runsRoot = path.join(root, "runs");
  const runsIdentity = await plainDirectoryIdentity(runsRoot);
  if (runsIdentity !== null) await replayInterruptedPrunes(runsRoot);

  const ps = dependencies.platformServices ?? getPlatformServices();
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const requestCooperativeTermination = dependencies.requestCooperativeTermination
    ?? defaultRequestCooperativeTermination;
  const delayMs = dependencies.delayMs ?? defaultDelayMs;
  const graceMs = dependencies.graceMs ?? 3000;
  const locksRoot = path.join(root, "locks");
  const stale: RunStartRecord[] = [];
  if (runsIdentity !== null) {
    const runEntries = await readdir(runsRoot, { withFileTypes: true });
    for (const entry of runEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_RUN_ID.test(entry.name)) continue;
      const runDirectory = path.join(runsRoot, entry.name);
      const runStartText = await readBoundedRegularFile(path.join(runDirectory, "run-start.json"));
      if (runStartText === null) continue;
      const record = parseRunStart(runStartText, entry.name);
      const store = new ArtifactStore(entry.name);
      const result = await store.readResult(entry.name);
      if (result !== null) {
        validateTerminalResult(result, entry.name);
        const marker = await store.readPipelineActiveMarker(entry.name);
        if (marker !== null && !await lockOwnerIsLive(
          { pid: marker.pid, processToken: marker.processToken },
          isProcessAlive,
          pid => ps.getProcessStartToken(pid),
        )) {
          const commonDir = await validateGitCommonDir(record.canonicalCommonDir);
          for (const managedId of [
            `${entry.name}-pipeline`,
            `${entry.name}-verify`,
          ]) {
            const worktreePath = path.join(root, "worktrees", managedId);
            if (await plainDirectoryIdentity(worktreePath) !== null) {
              await new WorktreeManager(commonDir, managedId, ps).remove(worktreePath);
            }
          }
          await store.clearPipelineActiveMarker();
        }
        continue;
      }
      if (await lockIsOwnedByLiveProcess(
        locksRoot,
        record.lockKey,
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      )) continue;
      stale.push(record);
    }
  }

  const recovered: string[] = [];
  for (const record of stale) {
    await recoverRun(
      record,
      root,
      ps,
      isProcessAlive,
      requestCooperativeTermination,
      delayMs,
      graceMs,
    );
    recovered.push(record.runId);
  }
  await reclaimLocks(
    locksRoot,
    isProcessAlive,
    pid => ps.getProcessStartToken(pid),
  );
  return { recovered };
}
