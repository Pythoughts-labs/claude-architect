import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import nodeProcess from "node:process";
import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { RuntimeError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { ArtifactStore } from "./artifact-store.js";
import { redact } from "./redaction.js";
import { resolveStateDir } from "./state-dir.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_STATE_FILE_BYTES = 8_000_000;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]*$/;
const LOCK_NAME = /^([0-9a-f]{64})\.lock$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";
const MAX_QUARANTINE_REASON_BYTES = 2_000;
const MAX_QUARANTINE_RECORD_BYTES = 4_096;

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

interface CleanupJournalRead {
  text: string | null;
  tornTail: boolean;
}

interface RecoveryQuarantineRecord {
  event: "recovery-quarantine";
  runId: string;
  reason: string;
  recordedAt: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface RecoveryQuarantineSnapshot {
  bytes: Buffer;
  runIds: Set<string>;
  rootIdentity: DirectoryIdentity;
  journalIdentity: DirectoryIdentity | null;
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

interface AcquiredLock {
  lockPath: string;
  identity: DirectoryIdentity;
  contents: Buffer;
}

type DeadLockReclaimResult = "reclaimed" | "live" | "contended";

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

async function readCleanupJournal(filename: string): Promise<CleanupJournalRead> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return { text: null, tornTail: false };
    throw error;
  }

  let result: CleanupJournalRead | undefined;
  let primaryError: unknown;
  try {
    const metadata = await handle.stat();
    const namedMetadata = await lstat(filename);
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size > MAX_STATE_FILE_BYTES
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || namedMetadata.size !== metadata.size) {
      throw new RuntimeError("cleanup journal must be a bounded regular single-link file");
    }
    const bytes = await readHandleBytes(handle, metadata.size);
    const repeatedBytes = await readHandleBytes(handle, metadata.size);
    const settledMetadata = await handle.stat();
    const settledNamedMetadata = await lstat(filename);
    if (bytes.byteLength > MAX_STATE_FILE_BYTES
      || settledMetadata.size > MAX_STATE_FILE_BYTES) {
      throw new RuntimeError("cleanup journal exceeds its size limit during read");
    }
    if (!settledMetadata.isFile()
      || settledMetadata.nlink !== 1
      || settledMetadata.dev !== metadata.dev
      || settledMetadata.ino !== metadata.ino
      || settledMetadata.size !== metadata.size
      || settledMetadata.mtimeMs !== metadata.mtimeMs
      || settledMetadata.ctimeMs !== metadata.ctimeMs
      || !settledNamedMetadata.isFile()
      || settledNamedMetadata.isSymbolicLink()
      || settledNamedMetadata.nlink !== 1
      || settledNamedMetadata.dev !== metadata.dev
      || settledNamedMetadata.ino !== metadata.ino
      || settledNamedMetadata.size !== metadata.size
      || bytes.byteLength !== metadata.size
      || !repeatedBytes.equals(bytes)) {
      throw new RuntimeError("cleanup journal changed during read");
    }
    const text = bytes.toString("utf8");
    if (text === "" || text.endsWith("\n")) {
      result = { text, tornTail: false };
    } else {
      const finalNewline = text.lastIndexOf("\n");
      const completePrefix = finalNewline === -1 ? "" : text.slice(0, finalNewline + 1);
      result = { text: completePrefix, tornTail: true };
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "cleanup journal read failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  if (result === undefined) throw new RuntimeError("cleanup journal read produced no result");
  return result;
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

function boundedQuarantineReason(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sanitized = redact(raw)
    .replace(/\\\\[^'"\r\n]*/g, "[path]")
    .replace(/[A-Za-z]:[\\/][^'"\r\n]*/g, "[path]")
    .replace(/\\[^'"\r\n]*/g, "[path]")
    .replace(/\/[^'"\r\n]*/g, "[path]");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= MAX_QUARANTINE_REASON_BYTES) return sanitized;
  let end = MAX_QUARANTINE_REASON_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function parseRecoveryQuarantineRecord(line: string): RecoveryQuarantineRecord {
  if (Buffer.byteLength(`${line}\n`, "utf8") > MAX_QUARANTINE_RECORD_BYTES) {
    throw new RuntimeError("recovery quarantine journal record exceeds its size limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new RuntimeError("recovery quarantine journal contains invalid JSON", { cause });
  }
  if (typeof value !== "object" || value === null) {
    throw new RuntimeError("recovery quarantine journal record must be an object");
  }
  const record = value as Partial<RecoveryQuarantineRecord>;
  validateRunId(record.runId);
  if (Object.keys(value).sort().join(",") !== "event,reason,recordedAt,runId"
    || record.event !== "recovery-quarantine"
    || typeof record.reason !== "string"
    || Buffer.byteLength(record.reason, "utf8") > MAX_QUARANTINE_REASON_BYTES
    || typeof record.recordedAt !== "string"
    || !Number.isFinite(Date.parse(record.recordedAt))) {
    throw new RuntimeError("recovery quarantine journal record is malformed");
  }
  return record as RecoveryQuarantineRecord;
}

function parseRecoveryQuarantineJournal(bytes: Buffer): Set<string> {
  const text = bytes.toString("utf8");
  const runIds = new Set<string>();
  if (text === "") return runIds;
  if (!text.endsWith("\n")) {
    throw new RuntimeError("recovery quarantine journal has a torn final record");
  }
  for (const line of text.slice(0, -1).split("\n")) {
    if (line === "") throw new RuntimeError("recovery quarantine journal contains a blank record");
    const record = parseRecoveryQuarantineRecord(line);
    if (runIds.has(record.runId)) {
      throw new RuntimeError("duplicate recovery quarantine runId");
    }
    runIds.add(record.runId);
  }
  return runIds;
}

async function readRecoveryQuarantineJournal(
  runsRoot: string,
): Promise<RecoveryQuarantineSnapshot> {
  const rootIdentity = await plainDirectoryIdentity(runsRoot);
  if (rootIdentity === null) {
    throw new RuntimeError("recovery quarantine journal root disappeared");
  }
  const filename = path.join(runsRoot, "recovery-quarantine.ndjson");
  let expectedMetadata;
  try {
    expectedMetadata = await lstat(filename);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const currentRoot = await lstat(runsRoot);
    if (!isPlainDirectory(currentRoot) || !sameIdentity(currentRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal root changed during missing read");
    }
    return {
      bytes: Buffer.alloc(0),
      runIds: new Set<string>(),
      rootIdentity,
      journalIdentity: null,
    };
  }
  if (!expectedMetadata.isFile()
    || expectedMetadata.isSymbolicLink()
    || expectedMetadata.nlink !== 1
    || expectedMetadata.size > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("recovery quarantine journal is not a bounded regular file");
  }
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      await lstat(filename);
    } catch (namedError) {
      if (isMissing(namedError)) {
        const currentRoot = await lstat(runsRoot);
        if (isPlainDirectory(currentRoot) && sameIdentity(currentRoot, rootIdentity)) {
          return {
            bytes: Buffer.alloc(0),
            runIds: new Set<string>(),
            rootIdentity,
            journalIdentity: null,
          };
        }
      }
    }
    throw new RuntimeError("recovery quarantine journal changed before read", { cause: error });
  }
  let bytes: Buffer | undefined;
  let journalIdentity: DirectoryIdentity | undefined;
  let primaryError: unknown;
  try {
    const metadata = await handle.stat();
    const namedMetadata = await lstat(filename);
    const currentRoot = await lstat(runsRoot);
    if (!metadata.isFile()
      || metadata.size > MAX_STATE_FILE_BYTES
      || metadata.size !== expectedMetadata.size
      || metadata.nlink !== 1
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1
      || namedMetadata.size !== metadata.size
      || namedMetadata.dev !== expectedMetadata.dev
      || namedMetadata.ino !== expectedMetadata.ino
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || !isPlainDirectory(currentRoot)
      || !sameIdentity(currentRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal changed during read");
    }
    journalIdentity = { dev: metadata.dev, ino: metadata.ino };
    bytes = await handle.readFile();
    const settledMetadata = await lstat(filename);
    const settledRoot = await lstat(runsRoot);
    if (!settledMetadata.isFile()
      || settledMetadata.isSymbolicLink()
      || settledMetadata.nlink !== 1
      || settledMetadata.size !== bytes.byteLength
      || settledMetadata.dev !== metadata.dev
      || settledMetadata.ino !== metadata.ino
      || !isPlainDirectory(settledRoot)
      || !sameIdentity(settledRoot, rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal changed after read");
    }
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "recovery quarantine journal read failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  if (bytes === undefined || journalIdentity === undefined) {
    throw new RuntimeError("recovery quarantine journal read produced no content");
  }
  return {
    bytes,
    runIds: parseRecoveryQuarantineJournal(bytes),
    rootIdentity,
    journalIdentity,
  };
}

async function syncRecoveryDirectory(directory: string): Promise<void> {
  let handle;
  let primaryError: unknown;
  try {
    handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = nodeProcess.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "");
    if (!unsupportedOnWindows) primaryError = error;
  }

  try {
    await handle?.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "recovery directory sync failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
}

async function publishRecoveryQuarantineJournal(
  runsRoot: string,
  filename: string,
  snapshot: RecoveryQuarantineSnapshot,
  nextBytes: Buffer,
): Promise<void> {
  const temporaryPath = path.join(
    runsRoot,
    `.recovery-quarantine-journal-${randomUUID()}.tmp`,
  );
  let handle;
  let temporaryCreated = false;
  let temporaryConsumed = false;
  let linkedPublication = false;
  let temporaryIdentity: DirectoryIdentity | undefined;
  let primaryError: unknown;
  try {
    handle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryCreated = true;
    const metadata = await handle.stat();
    temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
    const namedMetadata = await lstat(temporaryPath);
    const currentRoot = await lstat(runsRoot);
    if (!metadata.isFile()
      || metadata.nlink !== 1
      || !namedMetadata.isFile()
      || namedMetadata.isSymbolicLink()
      || namedMetadata.nlink !== 1
      || namedMetadata.dev !== metadata.dev
      || namedMetadata.ino !== metadata.ino
      || metadata.size > MAX_STATE_FILE_BYTES
      || !isPlainDirectory(currentRoot)
      || !sameIdentity(currentRoot, snapshot.rootIdentity)) {
      throw new RuntimeError("recovery quarantine journal temp changed during creation");
    }
    await handle.writeFile(nextBytes);
    await handle.sync();
    await validateOwnedLockState(
      handle,
      [temporaryPath],
      temporaryIdentity,
      nextBytes,
      1,
      runsRoot,
      snapshot.rootIdentity,
    );
  } catch (error) {
    primaryError = error;
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        primaryError = new AggregateError(
          [primaryError, closeError],
          "recovery quarantine journal temp failed and its handle could not be closed",
        );
      } else {
        primaryError = closeError;
      }
    }
  }
  if (primaryError === undefined) {
    try {
      if (temporaryIdentity === undefined) {
        throw new RuntimeError("recovery quarantine journal temp identity is unavailable");
      }
      await validatePublishedLock(
        temporaryPath,
        temporaryIdentity,
        nextBytes,
        runsRoot,
        snapshot.rootIdentity,
      );
      const currentSnapshot = await readRecoveryQuarantineJournal(runsRoot);
      const sameJournalIdentity = snapshot.journalIdentity === null
        ? currentSnapshot.journalIdentity === null
        : currentSnapshot.journalIdentity !== null
          && currentSnapshot.journalIdentity.dev === snapshot.journalIdentity.dev
          && currentSnapshot.journalIdentity.ino === snapshot.journalIdentity.ino;
      if (currentSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
        || currentSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
        || !sameJournalIdentity
        || !currentSnapshot.bytes.equals(snapshot.bytes)) {
        throw new RuntimeError("recovery quarantine journal changed before publication");
      }
      if (snapshot.journalIdentity === null) {
        await link(temporaryPath, filename);
        linkedPublication = true;
        await validatePublishedLock(
          temporaryPath,
          temporaryIdentity,
          nextBytes,
          runsRoot,
          snapshot.rootIdentity,
          2,
          [temporaryPath, filename],
        );
        const removal = await removeExpectedLockPath(
          temporaryPath,
          temporaryIdentity,
          nextBytes,
          2,
        );
        if (removal === "changed") {
          throw new RuntimeError("recovery quarantine journal temp changed before unlink");
        }
        temporaryConsumed = true;
      } else {
        await rename(temporaryPath, filename);
        temporaryConsumed = true;
      }
    } catch (error) {
      primaryError = error;
    }
  }
  const cleanupErrors: unknown[] = [];
  if (temporaryCreated && !temporaryConsumed) {
    if (temporaryIdentity === undefined) {
      cleanupErrors.push(new RuntimeError(
        "recovery quarantine journal temp identity is unavailable for cleanup",
      ));
    } else {
      cleanupErrors.push(...await cleanupOwnedLockPaths(
        runsRoot,
        snapshot.rootIdentity,
        temporaryPath,
        filename,
        temporaryIdentity,
        nextBytes,
        linkedPublication,
      ));
    }
  }
  if (primaryError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "recovery quarantine journal publication and temp cleanup failed",
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "recovery quarantine journal temp cleanup failed");
  }

  const publishedSnapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (temporaryIdentity === undefined
    || publishedSnapshot.journalIdentity === null
    || publishedSnapshot.journalIdentity.dev !== temporaryIdentity.dev
    || publishedSnapshot.journalIdentity.ino !== temporaryIdentity.ino
    || publishedSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
    || publishedSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
    || !publishedSnapshot.bytes.equals(nextBytes)) {
    throw new RuntimeError("recovery quarantine journal changed after publication");
  }
  await syncRecoveryDirectory(runsRoot);
}

async function appendRecoveryQuarantineRecord(
  runsRoot: string,
  record: RecoveryQuarantineRecord,
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  if (lineBytes > MAX_QUARANTINE_RECORD_BYTES) {
    throw new RuntimeError("recovery quarantine record exceeds its size limit");
  }
  const filename = path.join(runsRoot, "recovery-quarantine.ndjson");
  const snapshot = await readRecoveryQuarantineJournal(runsRoot);
  if (snapshot.runIds.has(record.runId)) {
    await syncRecoveryDirectory(runsRoot);
    const settledSnapshot = await readRecoveryQuarantineJournal(runsRoot);
    if (settledSnapshot.rootIdentity.dev !== snapshot.rootIdentity.dev
      || settledSnapshot.rootIdentity.ino !== snapshot.rootIdentity.ino
      || settledSnapshot.journalIdentity === null
      || snapshot.journalIdentity === null
      || settledSnapshot.journalIdentity.dev !== snapshot.journalIdentity.dev
      || settledSnapshot.journalIdentity.ino !== snapshot.journalIdentity.ino
      || !settledSnapshot.bytes.equals(snapshot.bytes)) {
      throw new RuntimeError("recovery quarantine journal changed after retry sync");
    }
    return;
  }
  const nextBytes = Buffer.concat([snapshot.bytes, Buffer.from(line, "utf8")]);
  if (nextBytes.byteLength > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("recovery quarantine journal exceeds its size limit");
  }
  await publishRecoveryQuarantineJournal(runsRoot, filename, snapshot, nextBytes);
}

async function quarantineRun(
  runsRoot: string,
  runId: string,
  error: unknown,
): Promise<void> {
  const runDirectory = path.join(runsRoot, runId);
  const quarantinePath = path.join(runsRoot, `.poisoned-${runId}`);
  const runsIdentity = await plainDirectoryIdentity(runsRoot);
  if (runsIdentity === null) throw new RuntimeError("recovery runs root disappeared");
  let runIdentity: DirectoryIdentity | null = null;
  let renamed = false;
  let journaled = false;
  try {
    runIdentity = await plainDirectoryIdentity(runDirectory);
    if (runIdentity === null) throw new RuntimeError("poisoned recovery run disappeared");
    if (await plainDirectoryIdentity(quarantinePath) !== null) {
      throw new RuntimeError("poisoned recovery quarantine already exists");
    }
    await rename(runDirectory, quarantinePath);
    renamed = true;
    const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
    const currentRoot = await lstat(runsRoot);
    if (quarantineIdentity === null
      || quarantineIdentity.dev !== runIdentity.dev
      || quarantineIdentity.ino !== runIdentity.ino
      || !isPlainDirectory(currentRoot)
      || !sameIdentity(currentRoot, runsIdentity)) {
      throw new RuntimeError("poisoned recovery run identity changed during quarantine");
    }
    const record: RecoveryQuarantineRecord = {
      event: "recovery-quarantine",
      runId,
      reason: boundedQuarantineReason(error),
      recordedAt: new Date().toISOString(),
    };
    await appendRecoveryQuarantineRecord(runsRoot, record);
    journaled = true;
    logger.warn("startup recovery quarantined poisoned run", {
      runId,
      reason: record.reason,
    });
  } catch (quarantineError) {
    const errors = [error, quarantineError];
    if (renamed && !journaled && runIdentity !== null) {
      try {
        const quarantineMetadata = await lstat(quarantinePath);
        const currentRoot = await lstat(runsRoot);
        if (!isPlainDirectory(quarantineMetadata)
          || !sameIdentity(quarantineMetadata, runIdentity)
          || await plainDirectoryIdentity(runDirectory) !== null
          || !isPlainDirectory(currentRoot)
          || !sameIdentity(currentRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity or destination is unsafe");
        }
        await rename(quarantinePath, runDirectory);
        const restoredMetadata = await lstat(runDirectory);
        const restoredRoot = await lstat(runsRoot);
        if (!isPlainDirectory(restoredMetadata)
          || !sameIdentity(restoredMetadata, runIdentity)
          || !isPlainDirectory(restoredRoot)
          || !sameIdentity(restoredRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback identity changed");
        }
        await syncRecoveryDirectory(runsRoot);
        const settledMetadata = await lstat(runDirectory);
        const settledRoot = await lstat(runsRoot);
        if (!isPlainDirectory(settledMetadata)
          || !sameIdentity(settledMetadata, runIdentity)
          || !isPlainDirectory(settledRoot)
          || !sameIdentity(settledRoot, runsIdentity)) {
          throw new RuntimeError("poisoned recovery rollback changed after directory sync");
        }
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    throw new AggregateError(errors, "run recovery failed and quarantine did not complete");
  }
}

async function readPendingCleanupRecords(
  runsRoot: string,
): Promise<{ pending: Map<string, CleanupRecord>; tornTail: boolean }> {
  const { text, tornTail } = await readCleanupJournal(path.join(runsRoot, "cleanup.ndjson"));
  const pending = new Map<string, CleanupRecord>();
  if (text === null || text === "") return { pending, tornTail };
  const completeText = text.endsWith("\n") ? text.slice(0, -1) : text;
  for (const line of completeText.split("\n")) {
    if (line.trim() === "") throw new RuntimeError("cleanup journal contains a blank record");
    const record = parseCleanupRecord(line);
    if (record.event === "prune-cleanup-intent") pending.set(record.runId, record);
    else pending.delete(record.runId);
  }
  return { pending, tornTail };
}

async function replayInterruptedPrunes(
  runsRoot: string,
): Promise<Set<string>> {
  const { pending, tornTail } = await readPendingCleanupRecords(runsRoot);
  if (tornTail || pending.size > 0) {
    logger.warn("startup recovery deferred interrupted prune replay for the shared cleanup journal");
  }
  return new Set(pending.keys());
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
  let unverifiedLivePid: number | undefined;
  if (record.pid !== null && isProcessAlive(record.pid)) {
    if (record.processToken === null) {
      unverifiedLivePid = record.pid;
    } else if (await ps.getProcessStartToken(record.pid) === record.processToken) {
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
      ...(unverifiedLivePid === undefined ? {} : { unverifiedLivePid }),
    },
    logsRef,
    producerId: null,
    producerVersion: null,
    producerModel: null,
    durationMs: 0,
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
  if (owner.processToken === null) return true;
  const currentToken = await getProcessStartToken(owner.pid);
  return currentToken === null || currentToken === owner.processToken;
}

async function readHandleBytes(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const contents = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(
      contents,
      offset,
      size - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return contents.subarray(0, offset);
}

async function removeLockIfUnchanged(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks = 1,
): Promise<boolean> {
  const expectedSize = expectedContents.byteLength;
  const handleMetadata = await handle.stat();
  if (!isExpectedLockMetadata(
    handleMetadata,
    expectedIdentity,
    expectedSize,
    expectedLinks,
  )) return false;
  const currentContents = await readHandleBytes(handle, handleMetadata.size);
  if (!currentContents.equals(expectedContents)) return false;

  let pathMetadata;
  try {
    pathMetadata = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!isExpectedLockMetadata(
    pathMetadata,
    expectedIdentity,
    expectedSize,
    expectedLinks,
  )) return false;

  const settledHandleMetadata = await handle.stat();
  if (!isExpectedLockMetadata(
    settledHandleMetadata,
    expectedIdentity,
    expectedSize,
    expectedLinks,
  )) return false;
  const settledContents = await readHandleBytes(handle, settledHandleMetadata.size);
  if (!settledContents.equals(expectedContents)) return false;

  let settledPathMetadata;
  try {
    settledPathMetadata = await lstat(lockPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!isExpectedLockMetadata(
    settledPathMetadata,
    expectedIdentity,
    expectedSize,
    expectedLinks,
  )) return false;
  try {
    await rm(lockPath, { force: false });
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function reclaimDeadLock(
  lockPath: string,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<DeadLockReclaimResult> {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return "contended";
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATE_FILE_BYTES) {
      throw new RuntimeError("recovery lock must be a bounded regular file");
    }
    const contents = await readHandleBytes(handle, metadata.size);
    if (contents.byteLength !== metadata.size) return "contended";
    const owner = parseLockOwner(contents.toString("utf8"));
    if (owner === null) return "contended";
    if (await lockOwnerIsLive(
      owner,
      isProcessAlive,
      getProcessStartToken,
    )) return "live";
    return await removeLockIfUnchanged(
      lockPath,
      handle,
      { dev: metadata.dev, ino: metadata.ino },
      contents,
    ) ? "reclaimed" : "contended";
  } finally {
    await handle.close();
  }
}

async function validateLockParentIdentity(
  parentPath: string,
  expectedIdentity: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(parentPath);
  if (!isPlainDirectory(metadata) || !sameIdentity(metadata, expectedIdentity)) {
    throw new RuntimeError("recovery lock parent identity changed");
  }
}

function isExpectedLockMetadata(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expectedIdentity: DirectoryIdentity,
  expectedSize: number,
  expectedLinks: number,
): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === expectedLinks
    && sameIdentity(metadata, expectedIdentity)
    && metadata.size === expectedSize
    && metadata.size <= MAX_STATE_FILE_BYTES;
}

async function validateOwnedLockState(
  handle: Awaited<ReturnType<typeof open>>,
  namedPaths: readonly string[],
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks: number,
  parentPath: string,
  parentIdentity: DirectoryIdentity,
): Promise<void> {
  const validateHandle = async () => {
    const metadata = await handle.stat();
    if (!isExpectedLockMetadata(
      metadata,
      expectedIdentity,
      expectedContents.byteLength,
      expectedLinks,
    ) || !(await readHandleBytes(handle, metadata.size)).equals(expectedContents)) {
      throw new RuntimeError("recovery lock handle or contents changed");
    }
  };

  await validateLockParentIdentity(parentPath, parentIdentity);
  await validateHandle();
  for (const namedPath of namedPaths) {
    const metadata = await lstat(namedPath);
    if (!isExpectedLockMetadata(
      metadata,
      expectedIdentity,
      expectedContents.byteLength,
      expectedLinks,
    )) throw new RuntimeError("recovery lock path changed");
  }
  await validateHandle();
  await validateLockParentIdentity(parentPath, parentIdentity);
}

type ExpectedLockRemoval = "removed" | "absent" | "changed";

async function removeExpectedLockPath(
  filename: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  expectedLinks: number,
): Promise<ExpectedLockRemoval> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw error;
  }
  let primaryError: unknown;
  let removed = false;
  try {
    removed = await removeLockIfUnchanged(
      filename,
      handle,
      expectedIdentity,
      expectedContents,
      expectedLinks,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "recovery lock cleanup failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
  return removed ? "removed" : "changed";
}

async function pathNamesLockIdentity(
  filename: string,
  expectedIdentity: DirectoryIdentity,
): Promise<boolean> {
  try {
    const metadata = await lstat(filename);
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && sameIdentity(metadata, expectedIdentity);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function validatePublishedLock(
  lockPath: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  parentPath: string,
  parentIdentity: DirectoryIdentity,
  expectedLinks = 1,
  namedPaths: readonly string[] = [lockPath],
): Promise<void> {
  const handle = await open(lockPath, constants.O_RDONLY | NO_FOLLOW);
  let primaryError: unknown;
  try {
    await validateOwnedLockState(
      handle,
      namedPaths,
      expectedIdentity,
      expectedContents,
      expectedLinks,
      parentPath,
      parentIdentity,
    );
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      throw new AggregateError(
        [primaryError, closeError],
        "published recovery lock validation failed and its handle could not be closed",
      );
    }
    throw closeError;
  }
  if (primaryError !== undefined) throw primaryError;
}

function throwLockAcquisitionErrors(errors: unknown[]): never {
  if (errors.length === 1) throw errors[0]!;
  throw new AggregateError(errors, "recovery lock acquisition and safe cleanup failed");
}

async function cleanupOwnedLockPaths(
  parentPath: string,
  parentIdentity: DirectoryIdentity,
  temporaryPath: string,
  lockPath: string,
  expectedIdentity: DirectoryIdentity,
  expectedContents: Buffer,
  published: boolean,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await validateLockParentIdentity(parentPath, parentIdentity);
  } catch (error) {
    return [error];
  }

  if (published) {
    try {
      const temporaryExists = await pathNamesLockIdentity(temporaryPath, expectedIdentity);
      const result = await removeExpectedLockPath(
        lockPath,
        expectedIdentity,
        expectedContents,
        temporaryExists ? 2 : 1,
      );
      if (result === "changed") {
        errors.push(new RuntimeError("published recovery lock changed before safe cleanup"));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    const result = await removeExpectedLockPath(
      temporaryPath,
      expectedIdentity,
      expectedContents,
      1,
    );
    if (result === "changed") {
      errors.push(new RuntimeError("temporary recovery lock changed before safe cleanup"));
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await validateLockParentIdentity(parentPath, parentIdentity);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function createOwnedLock(
  lockPath: string,
  contents: Buffer,
): Promise<AcquiredLock | null> {
  if (contents.byteLength > MAX_STATE_FILE_BYTES) {
    throw new RuntimeError("new recovery lock exceeds its size limit");
  }
  const parentPath = path.dirname(lockPath);
  const parentIdentity = await plainDirectoryIdentity(parentPath);
  if (parentIdentity === null) {
    throw new RuntimeError("recovery lock parent must remain a plain directory");
  }
  const temporaryPath = path.join(parentPath, `.recovery-lock-${randomUUID()}.tmp`);
  let handle;
  let temporaryIdentity: DirectoryIdentity | undefined;
  let temporaryCreated = false;
  let published = false;
  let contended = false;
  const errors: unknown[] = [];

  try {
    handle = await open(
      temporaryPath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    temporaryCreated = true;
    const metadata = await handle.stat();
    temporaryIdentity = { dev: metadata.dev, ino: metadata.ino };
    await handle.writeFile(contents);
    await handle.sync();
    await validateOwnedLockState(
      handle,
      [temporaryPath],
      temporaryIdentity,
      contents,
      1,
      parentPath,
      parentIdentity,
    );
    try {
      await link(temporaryPath, lockPath);
      published = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") contended = true;
      else throw error;
    }
    if (published) {
      await validateOwnedLockState(
        handle,
        [temporaryPath, lockPath],
        temporaryIdentity,
        contents,
        2,
        parentPath,
        parentIdentity,
      );
    }
  } catch (error) {
    errors.push(error);
  }
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (temporaryCreated && temporaryIdentity === undefined) {
    errors.push(new RuntimeError("temporary recovery lock identity is unavailable for cleanup"));
  }
  if (temporaryIdentity === undefined) throwLockAcquisitionErrors(errors);

  if (contended) {
    errors.push(...await cleanupOwnedLockPaths(
      parentPath,
      parentIdentity,
      temporaryPath,
      lockPath,
      temporaryIdentity,
      contents,
      false,
    ));
    if (errors.length === 0) return null;
    throwLockAcquisitionErrors(errors);
  }

  if (!published) {
    if (temporaryCreated) {
      errors.push(...await cleanupOwnedLockPaths(
        parentPath,
        parentIdentity,
        temporaryPath,
        lockPath,
        temporaryIdentity,
        contents,
        false,
      ));
    }
    throwLockAcquisitionErrors(errors);
  }

  if (errors.length === 0) {
    try {
      await validateLockParentIdentity(parentPath, parentIdentity);
      const result = await removeExpectedLockPath(
        temporaryPath,
        temporaryIdentity,
        contents,
        2,
      );
      if (result === "changed") {
        throw new RuntimeError("temporary recovery lock changed before unlink");
      }
      await validatePublishedLock(
        lockPath,
        temporaryIdentity,
        contents,
        parentPath,
        parentIdentity,
      );
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 0) {
    return { lockPath, identity: temporaryIdentity, contents };
  }
  errors.push(...await cleanupOwnedLockPaths(
    parentPath,
    parentIdentity,
    temporaryPath,
    lockPath,
    temporaryIdentity,
    contents,
    true,
  ));
  throwLockAcquisitionErrors(errors);
}

async function acquireOwnedLock(
  lockPath: string,
  contents: Buffer,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<AcquiredLock | null> {
  const created = await createOwnedLock(lockPath, contents);
  if (created !== null) return created;
  if (await reclaimDeadLock(lockPath, isProcessAlive, getProcessStartToken) !== "reclaimed") {
    return null;
  }
  return createOwnedLock(lockPath, contents);
}

async function releaseOwnedLock(lock: AcquiredLock): Promise<void> {
  let handle;
  try {
    handle = await open(lock.lockPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  try {
    await removeLockIfUnchanged(lock.lockPath, handle, lock.identity, lock.contents);
  } finally {
    await handle.close();
  }
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
    await reclaimDeadLock(lockPath, isProcessAlive, getProcessStartToken);
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
): Promise<{ recovered: string[]; quarantined: string[] }> {
  const root = await stateRoot();
  const ps = dependencies.platformServices ?? getPlatformServices();
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const requestCooperativeTermination = dependencies.requestCooperativeTermination
    ?? defaultRequestCooperativeTermination;
  const delayMs = dependencies.delayMs ?? defaultDelayMs;
  const graceMs = dependencies.graceMs ?? 3000;
  if (root === null) return { recovered: [], quarantined: [] };

  const locksRoot = path.join(root, "locks");
  await mkdir(locksRoot, { recursive: true });
  if (await plainDirectoryIdentity(locksRoot) === null) {
    throw new RuntimeError("recovery locks directory disappeared");
  }
  const ownerContents = Buffer.from(JSON.stringify({
    pid: nodeProcess.pid,
    processToken: await ps.getProcessStartToken(nodeProcess.pid),
  }));
  const recoveryLock = await acquireOwnedLock(
    path.join(locksRoot, "recovery.lock"),
    ownerContents,
    isProcessAlive,
    pid => ps.getProcessStartToken(pid),
  );
  if (recoveryLock === null) return { recovered: [], quarantined: [] };

  let primaryError: unknown;
  try {
    const runsRoot = path.join(root, "runs");
    const runsIdentity = await plainDirectoryIdentity(runsRoot);
    const deferredPruneRunIds = runsIdentity === null
      ? new Set<string>()
      : await replayInterruptedPrunes(runsRoot);
    const journaledQuarantines = runsIdentity === null
      ? new Set<string>()
      : (await readRecoveryQuarantineJournal(runsRoot)).runIds;

    const stale: Array<{ record: RunStartRecord; runStartText: string }> = [];
    const recovered: string[] = [];
    const quarantined: string[] = [];
    if (runsIdentity !== null) {
      const runEntries = await readdir(runsRoot, { withFileTypes: true });
      for (const entry of runEntries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(".poisoned-")) {
          const runId = entry.name.slice(".poisoned-".length);
          validateRunId(runId);
          if (!journaledQuarantines.has(runId)) {
            throw new RuntimeError(`unjournaled poisoned run detected: ${runId}`);
          }
          continue;
        }
        if (deferredPruneRunIds.has(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_RUN_ID.test(entry.name)) continue;
        try {
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
              const checkoutLock = await acquireOwnedLock(
                path.join(locksRoot, `${record.lockKey}.lock`),
                ownerContents,
                isProcessAlive,
                pid => ps.getProcessStartToken(pid),
              );
              if (checkoutLock === null) continue;
              let cleanupError: unknown;
              let cleanupFailed = false;
              try {
                const lockedRunStartText = await readBoundedRegularFile(
                  path.join(runDirectory, "run-start.json"),
                );
                if (lockedRunStartText === null) {
                  throw new RuntimeError("run-start recovery record disappeared during recovery");
                }
                const lockedRecord = parseRunStart(lockedRunStartText, entry.name);
                if (lockedRunStartText !== runStartText
                  || lockedRecord.runId !== record.runId
                  || lockedRecord.lockKey !== record.lockKey
                  || lockedRecord.canonicalCommonDir !== record.canonicalCommonDir
                  || lockedRecord.pid !== record.pid
                  || lockedRecord.processToken !== record.processToken
                  || lockedRecord.startedAt !== record.startedAt) {
                  throw new RuntimeError("run-start recovery record changed during recovery");
                }
                const lockedResult = await store.readResult(entry.name);
                if (lockedResult === null) {
                  throw new RuntimeError("terminal attempt result disappeared during recovery");
                }
                validateTerminalResult(lockedResult, entry.name);
                const lockedMarker = await store.readPipelineActiveMarker(entry.name);
                if (lockedMarker !== null && !await lockOwnerIsLive(
                  { pid: lockedMarker.pid, processToken: lockedMarker.processToken },
                  isProcessAlive,
                  pid => ps.getProcessStartToken(pid),
                )) {
                  const commonDir = await validateGitCommonDir(lockedRecord.canonicalCommonDir);
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
              } catch (error) {
                cleanupError = error;
                cleanupFailed = true;
              } finally {
                try {
                  await releaseOwnedLock(checkoutLock);
                } catch (releaseError) {
                  if (!cleanupFailed) throw releaseError;
                  throw new AggregateError(
                    [cleanupError, releaseError],
                    "terminal pipeline cleanup failed and its checkout lock could not be released",
                  );
                }
              }
              if (cleanupFailed) throw cleanupError;
            }
            continue;
          }
          if (await lockIsOwnedByLiveProcess(
            locksRoot,
            record.lockKey,
            isProcessAlive,
            pid => ps.getProcessStartToken(pid),
          )) continue;
          stale.push({ record, runStartText });
        } catch (error) {
          await quarantineRun(runsRoot, entry.name, error);
          quarantined.push(entry.name);
        }
      }
    }

    for (const { record, runStartText } of stale) {
      const checkoutLock = await acquireOwnedLock(
        path.join(locksRoot, `${record.lockKey}.lock`),
        ownerContents,
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      if (checkoutLock === null) continue;
      let recoveryError: unknown;
      let recoveryFailed = false;
      let becameTerminal = false;
      try {
        const lockedRunStartText = await readBoundedRegularFile(
          path.join(runsRoot, record.runId, "run-start.json"),
        );
        if (lockedRunStartText === null) {
          throw new RuntimeError("run-start recovery record disappeared before stale recovery");
        }
        const lockedRecord = parseRunStart(lockedRunStartText, record.runId);
        if (lockedRunStartText !== runStartText) {
          throw new RuntimeError("run-start recovery record changed before stale recovery");
        }
        const lockedResult = await new ArtifactStore(record.runId).readResult(record.runId);
        if (lockedResult !== null) {
          validateTerminalResult(lockedResult, record.runId);
          becameTerminal = true;
        } else {
          await recoverRun(
            lockedRecord,
            root,
            ps,
            isProcessAlive,
            requestCooperativeTermination,
            delayMs,
            graceMs,
          );
        }
      } catch (error) {
        recoveryError = error;
        recoveryFailed = true;
      } finally {
        try {
          await releaseOwnedLock(checkoutLock);
        } catch (cleanupError) {
          if (!recoveryFailed) throw cleanupError;
          throw new AggregateError(
            [recoveryError, cleanupError],
            "stale-run recovery failed and its checkout lock could not be released",
          );
        }
      }
      if (recoveryFailed) {
        await quarantineRun(runsRoot, record.runId, recoveryError);
        quarantined.push(record.runId);
        continue;
      }
      if (becameTerminal) continue;
      recovered.push(record.runId);
    }
    await reclaimLocks(
      locksRoot,
      isProcessAlive,
      pid => ps.getProcessStartToken(pid),
    );
    return { recovered, quarantined };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseOwnedLock(recoveryLock);
    } catch (cleanupError) {
      if (primaryError === undefined) throw cleanupError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "startup recovery failed and its recovery lock could not be released",
      );
    }
  }
}
