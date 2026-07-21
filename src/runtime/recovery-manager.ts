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
import {
  WorkflowBranchManager,
  type WorkflowBranchIdentity,
  type WorkflowBranchBootstrapOwnerRecord,
} from "../autopilot/branch-manager.js";
import type { AutopilotWorkflowState } from "../autopilot/types.js";
import {
  WorkflowStore,
  type WorkflowIntentJournal,
  type WorkflowOwnerRecord,
} from "../autopilot/workflow-store.js";
import { git, type GitResult } from "../git/git-exec.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { CLEANUP_JOURNAL_LOCK_KEY } from "../platform/posix-platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { AttemptResult } from "../protocol/attempt-result.js";
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
const SLICE_REF_PREFIX = "refs/claude-architect/slices/";
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
  platformServices?: Pick<PlatformServices, "os" | "getProcessStartToken" | "terminateProcessTreeByPid">
    & Partial<Pick<PlatformServices, "acquireCheckoutLock">>;
  isProcessAlive?: (pid: number) => boolean;
  requestCooperativeTermination?: (pid: number) => void | Promise<void>;
  delayMs?: (ms: number) => Promise<void>;
  graceMs?: number;
  git?: typeof git;
}

export type AutopilotRecoveryDisposition =
  | "live-preserve"
  | "resume"
  | "finalize"
  | "dispose"
  | "human-decision-required";

export interface AutopilotRecoveryResult {
  workflowId: string;
  disposition: AutopilotRecoveryDisposition;
}

export interface RecoveryResult {
  recovered: string[];
  quarantined: string[];
  workflows?: AutopilotRecoveryResult[];
}

interface LockOwner {
  pid: number;
  processToken: string;
}

interface AcquiredLock {
  lockPath: string;
  identity: DirectoryIdentity;
  contents: Buffer;
}

type LockOwnerStatus = "dead" | "live" | "unverifiable";

type DeadLockReclaimResult =
  | "reclaimed"
  | "live"
  | "contended"
  | "malformed"
  | "unverifiable";

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

async function readDirectRef(
  repoRoot: string,
  ref: string,
  runGit: typeof git = git,
): Promise<string | null> {
  const symbolic = await runGit(repoRoot, ["symbolic-ref", "--quiet", ref]);
  if (symbolic.exitCode === 0) {
    throw new RuntimeError("recovery refuses to mutate a symbolic Git ref");
  }
  if (symbolic.exitCode !== 1) throw runGitError("inspect symbolic Git ref", symbolic);
  const direct = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (direct.exitCode === 1) return null;
  if (direct.exitCode !== 0 || !OID.test(direct.stdout.trim())) {
    throw runGitError("inspect Git ref", direct);
  }
  return direct.stdout.trim();
}

async function deleteExactRef(
  repoRoot: string,
  ref: string,
  oid: string,
  runGit: typeof git = git,
): Promise<void> {
  const result = await runGit(repoRoot, ["update-ref", "--no-deref", "-d", ref, oid]);
  if (result.exitCode !== 0) throw runGitError("delete recovery Git ref", result);
}

async function removeStaleCandidateAnchor(repoRoot: string, runId: string): Promise<void> {
  const ref = `${CANDIDATE_REF_PREFIX}${runId}`;
  const oid = await readDirectRef(repoRoot, ref);
  if (oid !== null) await deleteExactRef(repoRoot, ref, oid);
}

async function archiveInterruptedPipeline(
  store: ArtifactStore,
  result: AttemptResult,
): Promise<void> {
  if (result.status !== "verified-candidate") return;
  const manifest = await store.readManifest(result.runId);
  if (manifest === null) {
    throw new RuntimeError("run manifest is missing while recovering interrupted pipeline");
  }
  const failed: AttemptResult = {
    ...result,
    status: "failed",
    failure: "verification-failure",
    summary: "Delegation pipeline was interrupted before trusted gates completed.",
    unresolvedIssues: [
      ...result.unresolvedIssues,
      "pipeline-interrupted-before-terminal-cleanup",
    ],
    evidence: {
      ...result.evidence,
      pipelineRecovery: "interrupted-before-terminal-cleanup",
    },
  };
  await store.promoteTerminalArtifacts({ result: failed, manifest });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isManagedWorktreeId(runId: string, managedId: string): boolean {
  if (new Set([
    runId,
    `baseline-${runId}`,
    `verify-${runId}`,
    `${runId}-pipeline`,
    `${runId}-verify`,
    `verify-${runId}-pipeline`,
    `${runId}-composed-review`,
    `${runId}-final-verify`,
    `verify-${runId}-final-pipeline`,
  ]).has(managedId)) return true;
  const escapedRunId = escapeRegex(runId);
  const index = "[1-9][0-9]*";
  const attempt = "(?:0|[1-9][0-9]*)";
  return new RegExp(
    `^${escapedRunId}-slice-${index}-attempt-${attempt}(?:-review|-verify)?$`,
  ).test(managedId)
    || new RegExp(
      `^verify-${escapedRunId}-slice-${index}-attempt-${attempt}-pipeline$`,
    ).test(managedId);
}

async function managedWorktreeIds(root: string, runId: string): Promise<string[]> {
  const worktreesRoot = path.join(root, "worktrees");
  if (await plainDirectoryIdentity(worktreesRoot) === null) return [];
  const entries = await readdir(worktreesRoot, { withFileTypes: true });
  return entries
    .map(entry => entry.name)
    .filter(managedId => isManagedWorktreeId(runId, managedId))
    .sort((left, right) => left.localeCompare(right));
}

async function cleanupManagedWorktrees(
  commonDir: string,
  root: string,
  runId: string,
  ps: Pick<PlatformServices, "os">,
): Promise<void> {
  for (const managedId of await managedWorktreeIds(root, runId)) {
    const worktreePath = path.join(root, "worktrees", managedId);
    if (await plainDirectoryIdentity(worktreePath) !== null) {
      await new WorktreeManager(commonDir, managedId, ps).remove(worktreePath);
    }
  }
}

interface TemporarySliceRef {
  ref: string;
  oid: string;
}

async function temporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<TemporarySliceRef[]> {
  const prefix = `${SLICE_REF_PREFIX}${runId}/`;
  const listed = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    prefix,
  ]);
  if (listed.exitCode !== 0) throw runGitError("enumerate temporary slice refs", listed);
  const expectedName = new RegExp(
    `^${escapeRegex(prefix)}slice-[1-9][0-9]*-attempt-(?:0|[1-9][0-9]*)$`,
  );
  const refs: TemporarySliceRef[] = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    if (fields.length !== 2 || fields[0] === undefined || !expectedName.test(fields[0])) {
      throw new RuntimeError("temporary slice ref name is malformed during recovery");
    }
    if (fields[1] === undefined || !OID.test(fields[1])) {
      throw new RuntimeError("temporary slice ref OID is malformed during recovery");
    }
    const object = await runGit(repoRoot, ["cat-file", "-t", fields[1]], {
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    if (object.exitCode !== 0 || object.stdout.trim() !== "commit") {
      throw new RuntimeError("temporary slice ref does not identify a commit during recovery");
    }
    refs.push({ ref: fields[0], oid: fields[1] });
  }
  for (const temporaryRef of refs) {
    const current = await readDirectRef(repoRoot, temporaryRef.ref, runGit);
    if (current !== temporaryRef.oid) {
      throw new RuntimeError("temporary slice ref moved during recovery");
    }
  }
  return refs;
}

async function cleanupTemporarySliceRefs(
  repoRoot: string,
  runId: string,
  runGit: typeof git,
): Promise<void> {
  const refs = await temporarySliceRefs(repoRoot, runId, runGit);
  for (const temporaryRef of refs) {
    await deleteExactRef(repoRoot, temporaryRef.ref, temporaryRef.oid, runGit);
  }
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
  // A candidate-null prune records the repository root for lease serialization
  // but has no anchor to reconcile: repoRoot set, every Git ref field null.
  const repositoryOnly = typeof record.repoRoot === "string"
    && record.anchorRef === null
    && record.backupRef === null
    && record.candidateCommitOid === null;
  const noRepository = record.repoRoot === null
    && record.anchorRef === null
    && record.backupRef === null
    && record.candidateCommitOid === null;
  if (!noRepository && !repositoryOnly && (!hasRepository
    || record.anchorRef !== `${CANDIDATE_REF_PREFIX}${record.runId}`
    || !OID.test(record.candidateCommitOid as string)
    || (record.backupRef !== null
      && record.backupRef !== `${BACKUP_REF_PREFIX}${record.runId}`))) {
    throw new RuntimeError("cleanup journal Git metadata is malformed");
  }
  return record as CleanupRecord;
}

function cleanupOutcome(record: CleanupRecord): AnchorCleanup {
  if (record.repoRoot === null || record.anchorRef === null) return "not-applicable";
  return record.backupRef === null ? "already-absent" : "deleted";
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

async function appendCleanupRecord(runsRoot: string, record: CleanupRecord): Promise<void> {
  // Same shared-journal mutex the prune writer holds: a completion/rollback append
  // can never interleave with a concurrent intent append or a torn-tail truncation.
  const journalLock = await getPlatformServices().acquireCleanupJournalLock();
  try {
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
  } finally {
    await journalLock.release();
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

// A torn trailing record is an intent whose durable write was interrupted before
// any Git ref was mutated (the prune writer journals intent, fsyncs, then mutates),
// so the fragment is safe to discard. The reader validates read-only and reports the
// torn tail; the completing replay removes it here before appending, so a completion
// record can never concatenate onto the fragment and corrupt the journal.
async function truncateCleanupTornTail(filename: string): Promise<void> {
  let handle;
  try {
    handle = await open(filename, constants.O_RDWR | NO_FOLLOW);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
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
      || namedMetadata.ino !== metadata.ino) {
      throw new RuntimeError("cleanup journal must be a bounded regular single-link file");
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (text === "" || text.endsWith("\n")) return;
    // A concurrent live prune may append+fsync a fresh intent between the reader's
    // scan and this truncate. Re-validate that we read exactly the stat'd bytes and
    // that the journal has not grown or changed since, and fail closed rather than
    // truncate away a durably-journaled intent (matches the reader's stability gate).
    const settled = await handle.stat();
    if (Buffer.byteLength(text, "utf8") !== metadata.size
      || settled.size !== metadata.size
      || settled.mtimeMs !== metadata.mtimeMs
      || settled.ctimeMs !== metadata.ctimeMs) {
      throw new RuntimeError("cleanup journal changed during torn-tail repair");
    }
    const finalNewline = text.lastIndexOf("\n");
    const completePrefix = finalNewline === -1 ? "" : text.slice(0, finalNewline + 1);
    await handle.truncate(Buffer.byteLength(completePrefix, "utf8"));
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function repositoryRootExists(repoRoot: string): Promise<boolean> {
  // A non-absolute repoRoot is a malformed record, not a deleted repository: realpath
  // would resolve it against the process CWD and could report a corrupt record as "gone",
  // fail-open routing it into the repo-absent reconcile path. Report it present so it falls
  // through to validateRepositoryRoot's absoluteness rejection and stays fail-closed,
  // matching how every other anomalous cleanup record halts recovery for investigation.
  if (!path.isAbsolute(repoRoot)) return true;
  try {
    await realpath(repoRoot);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

// Complete an interrupted prune whose repository was deleted after the intent was
// written. The candidate anchor and prune-backup refs died with the repository, so
// there is nothing to reconcile in Git; only the archive must converge. The checkout
// lease is intentionally skipped: it serializes Git-ref reconciliation, and this path
// performs none — a vanished repository cannot host a racing integration, and recovery
// already holds the global recovery lock.
//
// Limit of the lease-skip: the normal path's per-repo checkout lease also guarantees at
// most one pending intent per run, so a shadowed quarantine can never be orphaned. This
// path drops that lease, so IF prune were ever wired to run concurrently across processes
// (it has no such caller today — the checkout lease is prune's only cross-process guard),
// two repo-gone intents for one run could interleave and a crash after the losing rename
// could strand a quarantine dir that no surviving pending intent references. That is a
// disk-only leak, never a double-free (rename is atomic) or fail-open. Closing it needs a
// recovery sweep of `.prune-*` dirs unmatched by any pending intent; do that before wiring
// concurrent multi-process prune, not before.
async function reconcileRepoAbsentPrune(
  runsRoot: string,
  record: CleanupRecord,
): Promise<void> {
  const runDirectory = path.join(runsRoot, record.runId);
  const quarantinePath = path.join(runsRoot, record.quarantineName);
  const runIdentity = await plainDirectoryIdentity(runDirectory);
  const quarantineIdentity = await plainDirectoryIdentity(quarantinePath);
  if (runIdentity !== null && quarantineIdentity !== null) {
    throw new RuntimeError("both retained and quarantined run archives exist during recovery");
  }
  // Same discriminator as the normal path: a retained run rolls back (nothing was
  // removed), a quarantined run finishes (remove the archive that was moved aside).
  const action = runIdentity !== null ? "rollback" : "finish";
  if (action === "finish" && quarantineIdentity !== null) {
    await removePlainDirectory(quarantinePath, quarantineIdentity);
  }
  await appendCleanupRecord(runsRoot, {
    ...record,
    event: action === "finish" ? "prune-cleanup-complete" : "prune-cleanup-rollback",
    anchorCleanup: "already-absent",
    recordedAt: new Date().toISOString(),
  });
}

async function replayInterruptedPrunes(
  runsRoot: string,
  ps: Pick<PlatformServices, "acquireCheckoutLock">,
): Promise<void> {
  // Read the journal and repair a torn tail as one critical section under the shared
  // journal mutex, so no concurrent append can land between the read and the truncate
  // (which would otherwise be erased). Completion appends below re-take the same lock.
  let pending: Map<string, CleanupRecord>;
  const journalLock = await getPlatformServices().acquireCleanupJournalLock();
  try {
    const read = await readPendingCleanupRecords(runsRoot);
    if (read.tornTail) await truncateCleanupTornTail(path.join(runsRoot, "cleanup.ndjson"));
    pending = read.pending;
  } finally {
    await journalLock.release();
  }
  for (const record of [...pending.values()].sort((left, right) =>
    left.runId.localeCompare(right.runId))) {
    // A repoRoot-less legacy intent has neither anchor nor repository to lock.
    if (record.repoRoot === null) continue;
    // A crash can strand a pending intent whose repository was deleted afterward.
    // Reconcile its archive without Git and move on; otherwise validateRepositoryRoot
    // below throws and aborts the entire recovery pass — a permanent block, because
    // replayInterruptedPrunes runs before every other recovery step.
    //
    // The boundary is deliberately filesystem-definitive absence (realpath ENOENT), the
    // expected "the user deleted their repo" lifecycle event. A repoRoot that still
    // exists but is no longer the canonical repository (its .git removed, replaced by a
    // file, moved so it is non-canonical, or a transient git error) is NOT treated as
    // gone: it stays fail-closed through validateRepositoryRoot below, matching how every
    // other anomalous cleanup record halts recovery for investigation. Widening this to
    // "any validation failure" would fail open — a transient git hiccup would wrongly
    // reclaim the archive and orphan a real repository's refs.
    if (!(await repositoryRootExists(record.repoRoot))) {
      await reconcileRepoAbsentPrune(runsRoot, record);
      continue;
    }
    // Serialize the archive/anchor reconciliation against the checkout
    // lifecycle: hold the repository's checkout lease exactly as prune did.
    const repoRoot = await validateRepositoryRoot(record.repoRoot);
    const commonResult = await git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0) {
      throw runGitError("resolve cleanup repository identity", commonResult);
    }
    const repositoryIdentity = await realpath(commonResult.stdout.trim());
    const lease = await ps.acquireCheckoutLock(repoRoot);
    let primaryError: unknown;
    try {
      if (lease.repositoryIdentity !== repositoryIdentity) {
        throw new RuntimeError("checkout lease repository identity changed during prune recovery");
      }
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
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await lease.release();
      } catch (releaseError) {
        if (primaryError !== undefined) {
          throw new AggregateError(
            [primaryError, releaseError],
            "prune recovery failed and its checkout lease could not be released",
          );
        }
        throw releaseError;
      }
    }
    if (primaryError !== undefined) throw primaryError;
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
  runGit: typeof git = git,
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
  await cleanupManagedWorktrees(commonDir, root, record.runId, ps);
  await cleanupTemporarySliceRefs(commonDir, record.runId, runGit);
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
  let value: unknown;
  try { value = JSON.parse(trimmed); }
  catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const owner = value as { pid?: unknown; processToken?: unknown };
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
    || typeof owner.processToken !== "string" || owner.processToken.length === 0) return null;
  return { pid: owner.pid, processToken: owner.processToken };
}

async function lockOwnerStatus(
  owner: { pid: number; processToken: string | null } | null,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<LockOwnerStatus> {
  if (owner === null || !isProcessAlive(owner.pid)) return "dead";
  if (owner.processToken === null) return "unverifiable";
  const currentToken = await getProcessStartToken(owner.pid);
  if (currentToken === null) return "unverifiable";
  return currentToken === owner.processToken ? "live" : "dead";
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
    if (owner === null) {
      logger.warn("startup recovery preserved malformed lock", {
        event: "recovery-malformed-lock",
        lockName: path.basename(lockPath),
        reason: "invalid-owner-record",
      });
      return "malformed";
    }
    const ownerStatus = await lockOwnerStatus(
      owner,
      isProcessAlive,
      getProcessStartToken,
    );
    if (ownerStatus === "live") return "live";
    if (ownerStatus === "unverifiable") {
      logger.warn("startup recovery preserved unverifiable lock", {
        event: "recovery-unverifiable-lock",
        lockName: path.basename(lockPath),
        reason: "process-token-unavailable",
      });
      return "unverifiable";
    }
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
  const owner = parseLockOwner(contents);
  if (owner === null) return true;
  return await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken) !== "dead";
}

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TERMINAL_WORKFLOW_PHASES = new Set([
  "ready-for-human-review",
  "human-decision-required",
  "failed",
  "cancelled",
]);

type OwnerObservation =
  | { presence: "absent" }
  | { presence: "present"; status: LockOwnerStatus };

interface BranchObservation {
  presence: "absent" | "present" | "ambiguous";
  identity: WorkflowBranchIdentity | null;
  owner: WorkflowBranchBootstrapOwnerRecord | null;
  ownerStatus: LockOwnerStatus | null;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseWorkflowLease(text: string, workflowId: string): WorkflowOwnerRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, ["workflowId", "pid", "processToken", "acquiredAt"])
    || record.workflowId !== workflowId
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.processToken !== null
      && (typeof record.processToken !== "string"
        || record.processToken.length < 1
        || record.processToken.length > 256))
    || typeof record.acquiredAt !== "string"
    || Number.isNaN(Date.parse(record.acquiredAt))) return null;
  return record as unknown as WorkflowOwnerRecord;
}

async function observeWorkflowLease(
  store: WorkflowStore,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<OwnerObservation> {
  const text = await readBoundedRegularFile(store.ownerPath).catch(() => undefined);
  if (text === undefined) return { presence: "present", status: "unverifiable" };
  if (text === null) return { presence: "absent" };
  const record = parseWorkflowLease(text, store.workflowId);
  if (record === null) return { presence: "present", status: "unverifiable" };
  return {
    presence: "present",
    status: await lockOwnerStatus(record, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function branchOwnershipPath(root: string, workflowId: string): string {
  const name = createHash("sha256").update(workflowId).digest("hex");
  return path.join(root, "autopilot-branches", `${name}.json`);
}

async function observeWorkflowBranch(
  root: string,
  workflowId: string,
  manager: WorkflowBranchManager,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<BranchObservation> {
  const registration = await readBoundedRegularFile(branchOwnershipPath(root, workflowId))
    .catch(() => undefined);
  if (registration === undefined) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  if (registration === null) {
    return { presence: "absent", identity: null, owner: null, ownerStatus: null };
  }
  const [identity, owner] = await Promise.all([
    manager.load(workflowId),
    manager.readBootstrapOwner(workflowId),
  ]).catch(() => [null, null] as const);
  if (identity === null || owner === null) {
    return { presence: "ambiguous", identity: null, owner: null, ownerStatus: null };
  }
  return {
    presence: "present",
    identity,
    owner,
    ownerStatus: await lockOwnerStatus(owner, isProcessAlive, getProcessStartToken)
      .catch((): LockOwnerStatus => "unverifiable"),
  };
}

function isWorkflowBranchIdentity(value: unknown): value is WorkflowBranchIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Partial<WorkflowBranchIdentity>;
  return identity.ownershipVersion === "1"
    && typeof identity.workflowId === "string"
    && WORKFLOW_ID.test(identity.workflowId)
    && typeof identity.checkoutPath === "string"
    && typeof identity.gitCommonDir === "string"
    && typeof identity.repositoryIdentity === "string"
    && typeof identity.worktreePath === "string"
    && typeof identity.worktreeGitDir === "string"
    && typeof identity.branch === "string"
    && identity.branchRef === `refs/heads/${identity.branch}`
    && identity.baseRef === `refs/claude-architect/autopilot/${identity.workflowId}/base`
    && typeof identity.baseBranch === "string"
    && typeof identity.baseCommitOid === "string"
    && OID.test(identity.baseCommitOid)
    && identity.remote === "origin"
    && typeof identity.remoteUrl === "string"
    && typeof identity.ownerRepo === "string";
}

function branchMatchesWorkflowState(
  branch: WorkflowBranchIdentity,
  state: AutopilotWorkflowState,
): boolean {
  return branch.workflowId === state.workflowId
    && branch.repositoryIdentity === state.repositoryIdentity
    && branch.baseCommitOid === state.baseCommitOid
    && branch.branchRef === state.workflowRef
    && branch.worktreePath === state.worktreePath
    && branch.branch === state.shipping.branch;
}

function sameWorkflowBranch(
  left: WorkflowBranchIdentity,
  right: WorkflowBranchIdentity,
): boolean {
  return left.ownershipVersion === right.ownershipVersion
    && left.workflowId === right.workflowId
    && left.checkoutPath === right.checkoutPath
    && left.gitCommonDir === right.gitCommonDir
    && left.repositoryIdentity === right.repositoryIdentity
    && left.worktreePath === right.worktreePath
    && left.worktreeGitDir === right.worktreeGitDir
    && left.branch === right.branch
    && left.branchRef === right.branchRef
    && left.baseRef === right.baseRef
    && left.baseBranch === right.baseBranch
    && left.baseCommitOid === right.baseCommitOid
    && left.remote === right.remote
    && left.remoteUrl === right.remoteUrl
    && left.ownerRepo === right.ownerRepo;
}

function canonicalGithubRemote(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.includes("%")
    || parsed.pathname.endsWith("/")
    || parsed.pathname.includes("//")) return null;
  const components = parsed.pathname.slice(1).split("/");
  if (components.length !== 2) return null;
  const owner = components[0]!;
  const repository = components[1]!.endsWith(".git")
    ? components[1]!.slice(0, -4)
    : components[1]!;
  const component = /^[A-Za-z0-9_.-]+$/u;
  if (!component.test(owner)
    || !component.test(repository)
    || owner === "."
    || owner === ".."
    || repository === "."
    || repository === "..") return null;
  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}.git`;
}

function recordedBranch(
  journal: WorkflowIntentJournal,
  state: AutopilotWorkflowState,
): WorkflowBranchIdentity | null {
  const recorded = journal.intents.find(status =>
    status.intent.operation === "record-workflow-spec"
    && status.intent.idempotencyKey === "workflow-spec");
  const completion = recorded?.completion?.completion;
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    return null;
  }
  const branch = (completion as { branch?: unknown }).branch;
  return isWorkflowBranchIdentity(branch) && branchMatchesWorkflowState(branch, state)
    ? branch
    : null;
}

function expectedWorkflowHead(state: AutopilotWorkflowState): string | null {
  const head = state.tasks
    .slice(0, state.currentTaskIndex + 1)
    .reduce((current, task) => task.promotionCommitOid ?? current, state.baseCommitOid);
  return OID.test(head) ? head : null;
}

function cleanupIntent(
  journal: WorkflowIntentJournal,
  expectedHead: string,
) {
  const key = `cleanup:${expectedHead}`;
  const intent = journal.intents.find(status =>
    status.intent.operation === "cleanup-workflow-branch"
    && status.intent.idempotencyKey === key);
  if (intent === undefined
    || intent.intent.expectedIdentities.headCommitOid !== expectedHead
    || intent.completion?.failure !== null && intent.completion !== null) return null;
  if (intent.completion !== null) {
    const completion = intent.completion.completion;
    if (typeof completion !== "object"
      || completion === null
      || Array.isArray(completion)
      || (completion as { worktreeRemoved?: unknown }).worktreeRemoved !== true
      || (completion as { refsRemoved?: unknown }).refsRemoved !== true) return null;
  }
  return intent;
}

async function isAbsent(filename: string): Promise<boolean | null> {
  try {
    await lstat(filename);
    return false;
  } catch (error) {
    return isMissing(error) ? true : null;
  }
}

async function cleanupIsDirectlyObserved(
  branch: WorkflowBranchIdentity,
  runGit: typeof git,
): Promise<boolean> {
  if (await isAbsent(branch.worktreePath) !== true) return false;
  let canonicalCheckout: string;
  let canonicalCommonDir: string;
  try {
    canonicalCheckout = await realpath(branch.checkoutPath);
    canonicalCommonDir = await realpath(branch.gitCommonDir);
  } catch {
    return false;
  }
  if (canonicalCheckout !== branch.checkoutPath || canonicalCommonDir !== branch.gitCommonDir) {
    return false;
  }
  const [commonDir, worktrees, branchRef, baseRef] = await Promise.all([
    runGit(branch.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(branch.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
    runGit(branch.checkoutPath, ["show-ref", "--verify", "--quiet", branch.branchRef]),
    runGit(branch.checkoutPath, ["show-ref", "--verify", "--quiet", branch.baseRef]),
  ]);
  if (commonDir.exitCode !== 0 || worktrees.exitCode !== 0
    || branchRef.exitCode !== 1 || baseRef.exitCode !== 1) return false;
  let observedCommonDir: string;
  try {
    observedCommonDir = await realpath(commonDir.stdout.trim());
  } catch {
    return false;
  }
  if (observedCommonDir !== branch.gitCommonDir) return false;
  return !worktrees.stdout.split("\0").some(field =>
    field === `worktree ${branch.worktreePath}`);
}

async function activeBranchIsDirectlyObserved(
  branch: WorkflowBranchIdentity,
  expectedHead: string,
  runGit: typeof git,
): Promise<boolean> {
  let canonicalCheckout: string;
  let canonicalWorktree: string;
  let canonicalCommonDir: string;
  try {
    [canonicalCheckout, canonicalWorktree, canonicalCommonDir] = await Promise.all([
      realpath(branch.checkoutPath),
      realpath(branch.worktreePath),
      realpath(branch.gitCommonDir),
    ]);
  } catch {
    return false;
  }
  if (canonicalCheckout !== branch.checkoutPath
    || canonicalWorktree !== branch.worktreePath
    || canonicalCommonDir !== branch.gitCommonDir) return false;

  const [commonDir, worktrees, symbolic, head, base, status, remote] = await Promise.all([
    runGit(branch.checkoutPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(branch.checkoutPath, ["worktree", "list", "--porcelain", "-z"]),
    runGit(branch.worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(branch.worktreePath, ["rev-parse", "--verify", "HEAD"]),
    runGit(branch.checkoutPath, ["rev-parse", "--verify", branch.baseRef]),
    runGit(branch.worktreePath, [
      "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none",
    ]),
    runGit(branch.checkoutPath, ["config", "--get", "remote.origin.url"]),
  ]);
  if (commonDir.exitCode !== 0
    || worktrees.exitCode !== 0
    || symbolic.exitCode !== 0
    || head.exitCode !== 0
    || base.exitCode !== 0
    || status.exitCode !== 0
    || remote.exitCode !== 0) return false;
  let observedCommonDir: string;
  try {
    observedCommonDir = await realpath(commonDir.stdout.trim());
  } catch {
    return false;
  }
  if (observedCommonDir !== branch.gitCommonDir
    || symbolic.stdout.trim() !== branch.branch
    || head.stdout.trim() !== expectedHead
    || base.stdout.trim() !== branch.baseCommitOid
    || status.stdout !== ""
    || canonicalGithubRemote(remote.stdout.trim()) !== branch.remoteUrl) return false;

  const fields = worktrees.stdout.split("\0");
  const registrationIndex = fields.indexOf(`worktree ${branch.worktreePath}`);
  if (registrationIndex === -1) return false;
  const nextRegistration = fields.findIndex((field, index) =>
    index > registrationIndex && field.startsWith("worktree "));
  const registration = fields.slice(
    registrationIndex + 1,
    nextRegistration === -1 ? undefined : nextRegistration,
  );
  return registration.includes(`HEAD ${expectedHead}`)
    && registration.includes(`branch ${branch.branchRef}`);
}

async function workflowIds(root: string): Promise<string[]> {
  const ids = new Set<string>();
  const workflowsRoot = path.join(root, "workflows");
  const workflowsIdentity = await plainDirectoryIdentity(workflowsRoot);
  const workflowEntries = workflowsIdentity === null
    ? []
    : await readdir(workflowsRoot, { withFileTypes: true });
  for (const entry of workflowEntries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && WORKFLOW_ID.test(entry.name)) {
      ids.add(entry.name);
    }
  }

  const branchesRoot = path.join(root, "autopilot-branches");
  const branchesIdentity = await plainDirectoryIdentity(branchesRoot);
  const branchEntries = branchesIdentity === null
    ? []
    : await readdir(branchesRoot, { withFileTypes: true });
  for (const entry of branchEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      continue;
    }
    const text = await readBoundedRegularFile(path.join(branchesRoot, entry.name));
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const workflowId = (value as { workflowId?: unknown }).workflowId;
    if (typeof workflowId === "string"
      && WORKFLOW_ID.test(workflowId)
      && entry.name === path.basename(branchOwnershipPath(root, workflowId))) {
      ids.add(workflowId);
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

async function finalizeObservedWorkflow(
  store: WorkflowStore,
  state: AutopilotWorkflowState,
  expectedHead: string,
): Promise<void> {
  await store.adoptLease();
  let primaryError: unknown;
  try {
    await store.completeIntent({
      expectedRevision: state.revision,
      idempotencyKey: `cleanup:${expectedHead}`,
      completion: { worktreeRemoved: true, refsRemoved: true },
    });
    const completedAt = new Date().toISOString();
    await store.transition({
      expectedRevision: state.revision,
      to: "ready-for-human-review",
      update(draft) {
        draft.cleanup = {
          status: "succeeded",
          worktreeRemoved: true,
          lockReleased: true,
          error: null,
          completedAt,
        };
        draft.terminal = {
          classification: "ready-for-human-review",
          reason: null,
          evidenceRefs: draft.finalGate === null ? [] : [draft.finalGate.reportRef],
          completedAt,
        };
      },
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await store.releaseLease();
    } catch (releaseError) {
      if (primaryError === undefined) throw releaseError;
      throw new AggregateError(
        [primaryError, releaseError],
        "workflow finalization failed and its adopted lease could not be released",
      );
    }
  }
}

async function recoverAutopilotWorkflows(
  root: string,
  dependencies: {
    isProcessAlive: (pid: number) => boolean;
    getProcessStartToken: (pid: number) => Promise<string | null>;
    runGit: typeof git;
  },
): Promise<AutopilotRecoveryResult[]> {
  const results: AutopilotRecoveryResult[] = [];
  const branchManager = new WorkflowBranchManager({ git: dependencies.runGit });
  for (const workflowId of await workflowIds(root)) {
    const store = new WorkflowStore(workflowId, {
      stateDirectory: root,
      isProcessAlive: dependencies.isProcessAlive,
      getProcessStartToken: dependencies.getProcessStartToken,
    });
    const [lease, branch] = await Promise.all([
      observeWorkflowLease(
        store,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
      observeWorkflowBranch(
        root,
        workflowId,
        branchManager,
        dependencies.isProcessAlive,
        dependencies.getProcessStartToken,
      ),
    ]);

    if ((lease.presence === "present" && lease.status === "live")
      || branch.ownerStatus === "live") {
      results.push({ workflowId, disposition: "live-preserve" });
      continue;
    }

    const stateExists = await isAbsent(store.statePath);
    if (stateExists === true) {
      if (branch.presence === "present" && branch.ownerStatus === "dead"
        && branch.identity !== null) {
        const cleanup = await branchManager.cleanup(branch.identity, branch.identity.baseCommitOid);
        results.push({
          workflowId,
          disposition: cleanup.ok && cleanup.worktreeRemoved && cleanup.refsRemoved
            ? "dispose"
            : "human-decision-required",
        });
      } else {
        results.push({ workflowId, disposition: "human-decision-required" });
      }
      continue;
    }
    if (stateExists !== false) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    let state: AutopilotWorkflowState;
    let journal: WorkflowIntentJournal;
    try {
      [state, journal] = await Promise.all([store.read(), store.readIntentJournal()]);
    } catch {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (TERMINAL_WORKFLOW_PHASES.has(state.phase)) continue;
    if (lease.presence !== "present" || lease.status !== "dead"
      || branch.presence === "ambiguous"
      || branch.ownerStatus === "unverifiable") {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }

    const recorded = recordedBranch(journal, state);
    if (recorded === null) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    if (state.phase === "cleaning-up") {
      const expectedHead = expectedWorkflowHead(state);
      const intent = expectedHead === null ? null : cleanupIntent(journal, expectedHead);
      const directlyObserved = expectedHead !== null
        && state.finalGate?.headCommitOid === expectedHead
        && branch.presence === "absent"
        && await isAbsent(branchOwnershipPath(root, workflowId)) === true
        && await cleanupIsDirectlyObserved(recorded, dependencies.runGit);
      if (expectedHead === null || intent === null || !directlyObserved) {
        results.push({ workflowId, disposition: "human-decision-required" });
        continue;
      }
      await finalizeObservedWorkflow(store, state, expectedHead);
      results.push({ workflowId, disposition: "finalize" });
      continue;
    }

    if (branch.presence !== "present"
      || branch.identity === null
      || branch.ownerStatus !== "dead"
      || !sameWorkflowBranch(branch.identity, recorded)) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    const expectedHead = expectedWorkflowHead(state);
    if (expectedHead === null
      || !await activeBranchIsDirectlyObserved(
        branch.identity,
        expectedHead,
        dependencies.runGit,
      )) {
      results.push({ workflowId, disposition: "human-decision-required" });
      continue;
    }
    results.push({ workflowId, disposition: "resume" });
  }
  return results;
}

export async function recoverStaleRuns(
  dependencies: RecoveryDependencies = {},
): Promise<RecoveryResult> {
  const root = await stateRoot();
  // Recovery replays interrupted prunes under a checkout lease. Injected test
  // doubles may omit acquireCheckoutLock, so fall back to the selected platform
  // for that one capability while honoring every capability the caller supplied.
  const supplied = dependencies.platformServices;
  const selected = getPlatformServices();
  const ps: Pick<PlatformServices,
    "os" | "getProcessStartToken" | "terminateProcessTreeByPid" | "acquireCheckoutLock"> = {
    os: supplied?.os ?? selected.os,
    getProcessStartToken: pid => (supplied ?? selected).getProcessStartToken(pid),
    terminateProcessTreeByPid: (pid, token) =>
      (supplied ?? selected).terminateProcessTreeByPid(pid, token),
    acquireCheckoutLock: checkout =>
      supplied && supplied.acquireCheckoutLock
        ? supplied.acquireCheckoutLock(checkout)
        : selected.acquireCheckoutLock(checkout),
  };
  const isProcessAlive = dependencies.isProcessAlive ?? defaultIsProcessAlive;
  const requestCooperativeTermination = dependencies.requestCooperativeTermination
    ?? defaultRequestCooperativeTermination;
  const delayMs = dependencies.delayMs ?? defaultDelayMs;
  const graceMs = dependencies.graceMs ?? 3000;
  const runGit = dependencies.git ?? git;
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
    // The reconciler completes interrupted prunes under a per-repo checkout lease
    // rather than deferring them, so no run is skipped for a pending prune.
    if (runsIdentity !== null) {
      // A crash can leave the cleanup-journal mutex held by a dead owner. That lock
      // is a 64-hex leaf reclaimed by reclaimLocks() near the end of this body, but
      // replayInterruptedPrunes acquires it first — so without an up-front reclaim a
      // stale lock would make replay spin to its deadline and throw, aborting recovery
      // before reclaimLocks ever runs and permanently blocking every future pass.
      await reclaimDeadLock(
        path.join(locksRoot, `${CLEANUP_JOURNAL_LOCK_KEY}.lock`),
        isProcessAlive,
        pid => ps.getProcessStartToken(pid),
      );
      await replayInterruptedPrunes(runsRoot, ps);
    }
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
            if (marker !== null && await lockOwnerStatus(
              { pid: marker.pid, processToken: marker.processToken },
              isProcessAlive,
              pid => ps.getProcessStartToken(pid),
            ) === "dead") {
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
                if (lockedMarker !== null && await lockOwnerStatus(
                  { pid: lockedMarker.pid, processToken: lockedMarker.processToken },
                  isProcessAlive,
                  pid => ps.getProcessStartToken(pid),
                ) === "dead") {
                  const commonDir = await validateGitCommonDir(lockedRecord.canonicalCommonDir);
                  if (lockedMarker.sliced) await archiveInterruptedPipeline(store, lockedResult);
                  await cleanupManagedWorktrees(commonDir, root, entry.name, ps);
                  await cleanupTemporarySliceRefs(commonDir, entry.name, runGit);
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
            runGit,
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
    const workflows = await recoverAutopilotWorkflows(root, {
      isProcessAlive,
      getProcessStartToken: pid => ps.getProcessStartToken(pid),
      runGit,
    });
    return workflows.length === 0
      ? { recovered, quarantined }
      : { recovered, quarantined, workflows };
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
