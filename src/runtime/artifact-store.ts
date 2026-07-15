import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import type {
  AttemptResult,
  CandidateArtifact,
  CommandOutcome,
} from "../protocol/attempt-result.js";
import type { VerificationCommand } from "../protocol/delegation-spec.js";
import { RuntimeError } from "../util/errors.js";
import {
  containsRegisteredSecret,
  containsRegisteredSecretValue,
  redact,
  redactRecord,
} from "./redaction.js";
import {
  sanitizeRunManifest,
  verifyRunManifest,
  type RunManifest,
} from "./run-manifest.js";
import { resolveStateDir } from "./state-dir.js";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
const PRUNE_BACKUP_REF_PREFIX = "refs/claude-architect/prune-backups/";
const CLEANUP_JOURNAL = "cleanup.ndjson";
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface PrunePolicy {
  maxAgeMs: number;
  maxBytes: number;
}

export interface PruneResult {
  removed: string[];
  retained: Array<{ runId: string; reason: string }>;
}

interface RunEntry {
  runId: string;
  directory: string;
  modifiedAtMs: number;
  bytes: number;
  identity: DirectoryIdentity;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
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

interface PreparedAnchorCleanup {
  outcome: AnchorCleanup;
  repoRoot: string | null;
  anchorRef: string | null;
  backupRef: string | null;
  candidateCommitOid: string | null;
}

interface AnchorCleanupTransaction {
  outcome: AnchorCleanup;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

let cleanupJournalTail: Promise<void> = Promise.resolve();

function isSafeComponent(value: string): boolean {
  const base = value.split(".", 1)[0] ?? value;
  return SAFE_COMPONENT.test(value)
    && !value.endsWith(".")
    && !WINDOWS_RESERVED_COMPONENT.test(base);
}

function validateComponent(value: string, kind: "run id" | "log name"): void {
  if (!isSafeComponent(value) || (kind === "run id" && value !== value.toLowerCase())) {
    throw new RuntimeError(`invalid ${kind}: ${JSON.stringify(value)}`);
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function validatePruneLimit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RuntimeError(`invalid ${name}`);
  }
}

function compareEntries(left: RunEntry, right: RunEntry): number {
  if (left.modifiedAtMs !== right.modifiedAtMs) {
    return left.modifiedAtMs - right.modifiedAtMs;
  }
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function ensurePlainDirectory(directory: string): Promise<DirectoryIdentity> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(directory)}`);
  }
  if (created) await syncDirectory(path.dirname(directory));
  return { dev: metadata.dev, ino: metadata.ino };
}

async function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || metadata.dev !== expected.dev
    || metadata.ino !== expected.ino) {
    throw new RuntimeError("archive directory identity changed during operation");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | NO_FOLLOW);
    await handle.sync();
  } catch (error) {
    const unsupportedOnWindows = process.platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "");
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

async function readRegularFile(filename: string): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new RuntimeError(`archive entry is not a regular file: ${redact(filename)}`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) total += await directoryBytes(entryPath);
      else if (entry.isFile()) total += (await lstat(entryPath)).size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return total;
}

function enqueueCleanupJournalWrite(write: () => Promise<void>): Promise<void> {
  const result = cleanupJournalTail.then(write, write);
  cleanupJournalTail = result.catch(() => {});
  return result;
}

function escapeJsonPropertyKeys(serialized: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < serialized.length) {
    if (serialized[cursor] !== '"') {
      result += serialized[cursor];
      cursor += 1;
      continue;
    }

    let end = cursor + 1;
    while (end < serialized.length) {
      if (serialized[end] === "\\") {
        end += 2;
        continue;
      }
      if (serialized[end] === '"') break;
      end += 1;
    }
    const token = serialized.slice(cursor, end + 1);
    let next = end + 1;
    while (/\s/.test(serialized[next] ?? "")) next += 1;
    if (serialized[next] !== ":") {
      result += token;
      cursor = end + 1;
      continue;
    }

    const key = JSON.parse(token) as string;
    let escaped = "";
    for (let index = 0; index < key.length; index += 1) {
      escaped += `\\u${key.charCodeAt(index).toString(16).padStart(4, "0")}`;
    }
    result += `"${escaped}"`;
    cursor = end + 1;
  }
  return result;
}

function serializeJson(value: unknown, indentation?: number): string {
  if (containsRegisteredSecretValue(value)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  const serialized = escapeJsonPropertyKeys(JSON.stringify(value, null, indentation));
  if (containsRegisteredSecret(serialized)) {
    throw new RuntimeError("archive JSON cannot be safely persisted after redaction");
  }
  return serialized;
}

function preserveIdentity(value: string, label: string): string {
  if (redact(value) !== value) {
    throw new RuntimeError(`${label} cannot be safely persisted after redaction`);
  }
  return value;
}

function preserveNullableIdentity(value: string | null, label: string): string | null {
  return value === null ? null : preserveIdentity(value, label);
}

function sanitizeVerificationCommand(command: VerificationCommand): VerificationCommand {
  const sanitized: VerificationCommand = {
    id: preserveIdentity(command.id, "verification command id"),
    executable: redact(command.executable),
    args: command.args.map(redact),
    cwd: redact(command.cwd),
    timeoutMs: command.timeoutMs,
    network: command.network,
    expectedExitCodes: [...command.expectedExitCodes],
  };
  if (command.environment !== undefined) {
    sanitized.environment = redactRecord(command.environment);
  }
  if (command.platform !== undefined) {
    sanitized.platform = {
      ...(command.platform.os === undefined ? {} : { os: [...command.platform.os] }),
      ...(command.platform.arch === undefined
        ? {}
        : { arch: command.platform.arch.map(arch => preserveIdentity(arch, "platform arch")) }),
    };
  }
  return sanitized;
}

function sanitizeCommandOutcome(outcome: CommandOutcome): CommandOutcome {
  return {
    id: preserveIdentity(outcome.id, "command outcome id"),
    executable: redact(outcome.executable),
    args: outcome.args.map(redact),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdoutRef: preserveIdentity(outcome.stdoutRef, "stdout archive ref"),
    stderrRef: preserveIdentity(outcome.stderrRef, "stderr archive ref"),
  };
}

function sanitizeCandidate(candidate: CandidateArtifact): CandidateArtifact {
  const changedPaths = candidate.changedPaths.map(change => ({
    path: preserveIdentity(change.path, "candidate path"),
    changeType: change.changeType,
    mode: preserveIdentity(change.mode, "candidate mode"),
    contentHash: preserveNullableIdentity(change.contentHash, "candidate content hash"),
  }));
  const expectedManifestHash = createHash("sha256")
    .update(JSON.stringify(changedPaths))
    .digest("hex");
  if (candidate.manifestHash !== expectedManifestHash) {
    throw new RuntimeError("candidate manifest hash does not match changed paths");
  }
  return {
    baseCommitOid: preserveIdentity(candidate.baseCommitOid, "candidate base commit oid"),
    candidateTreeOid: preserveIdentity(candidate.candidateTreeOid, "candidate tree oid"),
    candidateCommitOid: preserveIdentity(candidate.candidateCommitOid, "candidate commit oid"),
    anchorRef: preserveIdentity(candidate.anchorRef, "candidate anchor ref"),
    manifestHash: preserveIdentity(candidate.manifestHash, "candidate manifest hash"),
    changedPaths,
    patch: redact(candidate.patch),
  };
}

function sanitizeAttemptResult(result: AttemptResult): AttemptResult {
  return {
    resultVersion: result.resultVersion,
    runId: preserveIdentity(result.runId, "attempt run id"),
    status: preserveIdentity(result.status, "attempt status") as AttemptResult["status"],
    failure: result.failure === null
      ? null
      : preserveIdentity(
        result.failure,
        "failure classification",
      ) as NonNullable<AttemptResult["failure"]>,
    summary: redact(result.summary),
    producerSummary: result.producerSummary === null ? null : redact(result.producerSummary),
    candidate: result.candidate === null ? null : sanitizeCandidate(result.candidate),
    requestedVerification: result.requestedVerification.map(sanitizeVerificationCommand),
    executedVerification: result.executedVerification.map(sanitizeCommandOutcome),
    unresolvedIssues: result.unresolvedIssues.map(redact),
    evidence: redactRecord(result.evidence),
    logsRef: preserveIdentity(result.logsRef, "logs archive ref"),
    producerId: result.producerId === null ? null : redact(result.producerId),
    producerVersion: result.producerVersion === null ? null : redact(result.producerVersion),
    producerModel: result.producerModel === null ? null : redact(result.producerModel),
    durationMs: result.durationMs,
    sessionId: result.sessionId === null ? null : redact(result.sessionId),
  };
}

export class ArtifactStore {
  readonly runDirectory: string;
  private readonly runsRoot: string;
  private readonly runId: string;

  constructor(runId: string) {
    validateComponent(runId, "run id");
    this.runId = runId;
    this.runsRoot = path.join(resolveStateDir(), "runs");
    this.runDirectory = path.join(this.runsRoot, runId);
  }

  private async ensureRunsRoot(): Promise<string> {
    await mkdir(path.dirname(this.runsRoot), { recursive: true, mode: 0o700 });
    await ensurePlainDirectory(this.runsRoot);
    return realpath(this.runsRoot);
  }

  private async ensureRunDirectory(create: boolean): Promise<string | null> {
    const canonicalRunsRoot = await this.ensureRunsRoot();
    if (create) {
      await ensurePlainDirectory(this.runDirectory);
    } else {
      try {
        const metadata = await lstat(this.runDirectory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(this.runDirectory)}`);
        }
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }
    const canonicalRunDirectory = await realpath(this.runDirectory);
    if (!isWithin(canonicalRunsRoot, canonicalRunDirectory)) {
      throw new RuntimeError("archive directory escapes plugin data");
    }
    return canonicalRunDirectory;
  }

  private async ensureArchiveDirectory(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) throw new RuntimeError("archive path must be relative");
    const normalized = path.normalize(relativePath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      throw new RuntimeError("archive path escapes run directory");
    }

    const canonicalRunDirectory = await this.ensureRunDirectory(true);
    if (canonicalRunDirectory === null) throw new RuntimeError("failed to create archive directory");
    const relativeDirectory = path.dirname(normalized);
    if (relativeDirectory === ".") return canonicalRunDirectory;

    let current = canonicalRunDirectory;
    for (const component of relativeDirectory.split(path.sep)) {
      validateComponent(component, "log name");
      current = path.join(current, component);
      await ensurePlainDirectory(current);
      const canonicalCurrent = await realpath(current);
      if (!isWithin(canonicalRunDirectory, canonicalCurrent)) {
        throw new RuntimeError("archive directory escapes run directory");
      }
      current = canonicalCurrent;
    }
    return current;
  }

  private async writeArchiveFile(relativePath: string, text: string): Promise<void> {
    const directory = await this.ensureArchiveDirectory(relativePath);
    const directoryIdentity = await ensurePlainDirectory(directory);
    const destination = path.join(directory, path.basename(relativePath));
    const temporaryPath = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    let handle;
    let temporaryCreated = false;
    try {
      await assertDirectoryIdentity(directory, directoryIdentity);
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      temporaryCreated = true;
      await assertDirectoryIdentity(directory, directoryIdentity);
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        await assertDirectoryIdentity(directory, directoryIdentity);
        await link(temporaryPath, destination);
        await assertDirectoryIdentity(directory, directoryIdentity);
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        await assertDirectoryIdentity(directory, directoryIdentity);
        const existing = await readRegularFile(destination);
        if (existing !== text) {
          throw new RuntimeError(`archive entry already exists with different content: ${relativePath}`);
        }
      }
    } finally {
      await handle?.close();
      if (temporaryCreated) {
        await assertDirectoryIdentity(directory, directoryIdentity);
        await rm(temporaryPath, { force: true });
        await syncDirectory(directory);
        await assertDirectoryIdentity(directory, directoryIdentity);
      }
    }
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    const serialized = `${serializeJson(value, 2)}\n`;
    await this.writeArchiveFile(relativePath, serialized);
  }

  async writeLog(name: string, text: string): Promise<string> {
    validateComponent(name, "log name");
    const ref = path.posix.join("logs", `${name}.log`);
    await this.writeArchiveFile(ref, redact(text));
    return ref;
  }

  async writeResult(result: AttemptResult): Promise<void> {
    if (result.runId !== this.runId) {
      throw new RuntimeError("attempt result run id does not match artifact store");
    }
    await this.writeJson("result.json", sanitizeAttemptResult(result));
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    if (manifest.runId !== this.runId) {
      throw new RuntimeError("run manifest id does not match artifact store");
    }
    await this.writeJson("manifest.json", sanitizeRunManifest(manifest));
  }

  async readResult(runId: string): Promise<AttemptResult | null> {
    validateComponent(runId, "run id");
    const runDirectory = path.join(this.runsRoot, runId);
    if (await this.ensureExistingRunDirectory(runDirectory) === null) return null;
    try {
      return JSON.parse(await readRegularFile(path.join(runDirectory, "result.json"))) as AttemptResult;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async ensureExistingRunDirectory(directory: string): Promise<string | null> {
    const canonicalRunsRoot = await this.ensureRunsRoot();
    try {
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(directory)}`);
      }
      const canonicalDirectory = await realpath(directory);
      if (!isWithin(canonicalRunsRoot, canonicalDirectory)) {
        throw new RuntimeError("archive directory escapes plugin data");
      }
      return canonicalDirectory;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async readManifest(runId: string): Promise<RunManifest | null> {
    const runDirectory = path.join(this.runsRoot, runId);
    if (await this.ensureExistingRunDirectory(runDirectory) === null) return null;
    try {
      return verifyRunManifest(
        JSON.parse(await readRegularFile(path.join(runDirectory, "manifest.json"))),
        runId,
      );
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async list(): Promise<string[]> {
    await this.ensureRunsRoot();
    const entries = await readdir(this.runsRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && isSafeComponent(entry.name))
      .map(entry => entry.name)
      .sort();
  }

  private async entries(): Promise<RunEntry[]> {
    const entries = await Promise.all((await this.list()).map(async runId => {
      const directory = path.join(this.runsRoot, runId);
      try {
        const metadata = await lstat(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return null;
        return {
          runId,
          directory,
          modifiedAtMs: metadata.mtimeMs,
          bytes: await directoryBytes(directory),
          identity: { dev: metadata.dev, ino: metadata.ino },
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }));
    return entries.filter((entry): entry is RunEntry => entry !== null).sort(compareEntries);
  }

  private async prepareCandidateAnchorCleanup(
    runId: string,
    result: AttemptResult,
  ): Promise<PreparedAnchorCleanup> {
    if (result.candidate === null) {
      return {
        outcome: "not-applicable",
        repoRoot: null,
        anchorRef: null,
        backupRef: null,
        candidateCommitOid: null,
      };
    }

    const candidate = sanitizeCandidate(result.candidate);
    const expectedRef = `${CANDIDATE_REF_PREFIX}${runId}`;
    if (candidate.anchorRef !== expectedRef) {
      throw new RuntimeError("archived candidate anchor does not match run id");
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(candidate.candidateCommitOid)) {
      throw new RuntimeError("archived candidate commit oid is invalid");
    }
    const manifest = await this.readManifest(runId);
    if (manifest === null) {
      throw new RuntimeError("cannot remove candidate anchor without archived repository root");
    }
    const canonicalRepoRoot = await realpath(manifest.repoRoot);
    const repositoryTopLevel = await git(canonicalRepoRoot, ["rev-parse", "--show-toplevel"]);
    if (repositoryTopLevel.exitCode !== 0
      || await realpath(repositoryTopLevel.stdout.trim()) !== canonicalRepoRoot) {
      throw new RuntimeError("archived repository root is not a canonical repository root");
    }
    const commit = await git(canonicalRepoRoot, [
      "cat-file",
      "-e",
      `${candidate.candidateCommitOid}^{commit}`,
    ]);
    if (commit.exitCode !== 0) {
      throw new RuntimeError("archived candidate commit does not belong to repository");
    }

    const direct = await git(canonicalRepoRoot, ["rev-parse", "--verify", "--quiet", expectedRef]);
    if (direct.exitCode === 1) {
      const symbolic = await git(canonicalRepoRoot, ["symbolic-ref", "--quiet", expectedRef]);
      if (symbolic.exitCode === 0) {
        throw new RuntimeError("archived candidate anchor is a dangling symbolic ref");
      }
      return {
        outcome: "already-absent",
        repoRoot: canonicalRepoRoot,
        anchorRef: expectedRef,
        backupRef: null,
        candidateCommitOid: candidate.candidateCommitOid,
      };
    }
    if (direct.exitCode !== 0 || direct.stdout.trim() !== candidate.candidateCommitOid) {
      throw new RuntimeError("archived candidate anchor moved");
    }
    return {
      outcome: "deleted",
      repoRoot: canonicalRepoRoot,
      anchorRef: expectedRef,
      backupRef: `${PRUNE_BACKUP_REF_PREFIX}${runId}`,
      candidateCommitOid: candidate.candidateCommitOid,
    };
  }

  private async beginCandidateAnchorCleanup(
    prepared: PreparedAnchorCleanup,
    runId: string,
  ): Promise<AnchorCleanupTransaction> {
    if (prepared.outcome !== "deleted"
      || prepared.repoRoot === null
      || prepared.anchorRef === null
      || prepared.backupRef === null
      || prepared.candidateCommitOid === null) {
      return {
        outcome: prepared.outcome,
        async commit() {},
        async rollback() {},
      };
    }
    const { repoRoot, anchorRef, backupRef, candidateCommitOid } = prepared;
    const zeroOid = "0".repeat(candidateCommitOid.length);
    const backup = await git(repoRoot, [
      "update-ref",
      "--no-deref",
      "-m",
      `claude-architect prune backup ${runId}`,
      backupRef,
      candidateCommitOid,
      zeroOid,
    ]);
    if (backup.exitCode !== 0) {
      throw new RuntimeError("failed to create candidate prune backup");
    }
    const deletion = await git(repoRoot, [
      "update-ref",
      "--no-deref",
      "-m",
      `claude-architect prune ${runId}`,
      "-d",
      anchorRef,
      candidateCommitOid,
    ]);
    if (deletion.exitCode !== 0) {
      await git(repoRoot, ["update-ref", "--no-deref", "-d", backupRef, candidateCommitOid]);
      throw new RuntimeError("failed to remove candidate anchor");
    }

    return {
      outcome: "deleted",
      async commit(): Promise<void> {
        const deleted = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-d",
          backupRef,
          candidateCommitOid,
        ]);
        if (deleted.exitCode !== 0) {
          throw new RuntimeError("failed to remove candidate prune backup");
        }
      },
      async rollback(): Promise<void> {
        const restored = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-m",
          `claude-architect prune rollback ${runId}`,
          anchorRef,
          candidateCommitOid,
          zeroOid,
        ]);
        if (restored.exitCode !== 0) {
          throw new RuntimeError("failed to restore candidate anchor from prune backup");
        }
        const deleted = await git(repoRoot, [
          "update-ref",
          "--no-deref",
          "-d",
          backupRef,
          candidateCommitOid,
        ]);
        if (deleted.exitCode !== 0) {
          throw new RuntimeError("failed to remove restored candidate prune backup");
        }
      },
    };
  }

  private async appendCleanupRecord(record: CleanupRecord): Promise<void> {
    await enqueueCleanupJournalWrite(async () => {
      await this.ensureRunsRoot();
      const filename = path.join(this.runsRoot, CLEANUP_JOURNAL);
      const handle = await open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW,
        0o600,
      );
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile()) throw new RuntimeError("cleanup journal is not a regular file");
        const line = `${serializeJson(record)}\n`;
        await handle.writeFile(line, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(this.runsRoot);
    });
  }

  async prune(policy: PrunePolicy): Promise<PruneResult> {
    validatePruneLimit(policy.maxAgeMs, "maxAgeMs");
    validatePruneLimit(policy.maxBytes, "maxBytes");

    const entries = await this.entries();
    const removed = new Set<string>();
    const attempted = new Set<string>();
    const retained: PruneResult["retained"] = [];
    let retainedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);

    const removeEntry = async (entry: RunEntry, reason: PruneReason): Promise<void> => {
      if (attempted.has(entry.runId)) return;
      attempted.add(entry.runId);
      const quarantineName = `.prune-${entry.runId}-${randomUUID()}`;
      const quarantinePath = path.join(this.runsRoot, quarantineName);
      let prepared: PreparedAnchorCleanup | null = null;
      let transaction: AnchorCleanupTransaction | null = null;
      let archiveDeleted = false;
      try {
        const result = await this.readResult(entry.runId);
        if (result === null) {
          retained.push({ runId: entry.runId, reason: "incomplete-run" });
          return;
        }
        prepared = await this.prepareCandidateAnchorCleanup(entry.runId, result);
        await this.appendCleanupRecord({
          event: "prune-cleanup-intent",
          runId: entry.runId,
          reason,
          anchorCleanup: "pending",
          archiveBytes: entry.bytes,
          quarantineName,
          repoRoot: prepared.repoRoot,
          anchorRef: prepared.anchorRef,
          backupRef: prepared.backupRef,
          candidateCommitOid: prepared.candidateCommitOid,
          recordedAt: new Date().toISOString(),
        });
        transaction = await this.beginCandidateAnchorCleanup(prepared, entry.runId);
        const runsRootIdentity = await ensurePlainDirectory(this.runsRoot);
        await assertDirectoryIdentity(entry.directory, entry.identity);
        await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
        await rename(entry.directory, quarantinePath);
        await syncDirectory(this.runsRoot);
        await assertDirectoryIdentity(this.runsRoot, runsRootIdentity);
        await rm(quarantinePath, { recursive: true, force: false });
        archiveDeleted = true;
        await syncDirectory(this.runsRoot);
        await this.appendCleanupRecord({
          event: "prune-cleanup-complete",
          runId: entry.runId,
          reason,
          anchorCleanup: transaction.outcome,
          archiveBytes: entry.bytes,
          quarantineName,
          repoRoot: prepared.repoRoot,
          anchorRef: prepared.anchorRef,
          backupRef: prepared.backupRef,
          candidateCommitOid: prepared.candidateCommitOid,
          recordedAt: new Date().toISOString(),
        });
        await transaction.commit();
        removed.add(entry.runId);
        retainedBytes -= entry.bytes;
      } catch (error) {
        let rollbackError: unknown;
        if (!archiveDeleted) {
          try {
            if (await pathExists(quarantinePath) && !await pathExists(entry.directory)) {
              await rename(quarantinePath, entry.directory);
              await syncDirectory(this.runsRoot);
            }
            await transaction?.rollback();
            if (prepared !== null) {
              await this.appendCleanupRecord({
                event: "prune-cleanup-rollback",
                runId: entry.runId,
                reason,
                anchorCleanup: prepared.outcome,
                archiveBytes: entry.bytes,
                quarantineName,
                repoRoot: prepared.repoRoot,
                anchorRef: prepared.anchorRef,
                backupRef: prepared.backupRef,
                candidateCommitOid: prepared.candidateCommitOid,
                recordedAt: new Date().toISOString(),
              });
            }
          } catch (rollbackFailure) {
            rollbackError = rollbackFailure;
          }
        } else {
          removed.add(entry.runId);
          retainedBytes -= entry.bytes;
        }
        const primary = error instanceof Error ? error.message : String(error);
        const rollback = rollbackError instanceof Error
          ? `; rollback failed: ${rollbackError.message}`
          : rollbackError === undefined ? "" : `; rollback failed: ${String(rollbackError)}`;
        retained.push({
          runId: entry.runId,
          reason: redact(`${primary}${rollback}`),
        });
      }
    };

    const now = Date.now();
    for (const entry of entries) {
      if (now - entry.modifiedAtMs > policy.maxAgeMs) await removeEntry(entry, "max-age");
    }
    for (const entry of entries) {
      if (retainedBytes <= policy.maxBytes) break;
      await removeEntry(entry, "max-bytes");
    }

    return { removed: [...removed], retained };
  }
}
