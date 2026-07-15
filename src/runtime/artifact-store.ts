import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { git } from "../git/git-exec.js";
import type { AttemptResult } from "../protocol/attempt-result.js";
import { RuntimeError } from "../util/errors.js";
import { redact, redactRecord } from "./redaction.js";
import type { RunManifest } from "./run-manifest.js";
import { resolveStateDir } from "./state-dir.js";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const CANDIDATE_REF_PREFIX = "refs/claude-architect/candidates/";
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
}

type PruneReason = "max-age" | "max-bytes";
type AnchorCleanup = "not-applicable" | "deleted" | "already-absent";

interface CleanupRecord {
  event: "prune-cleanup-intent" | "prune-cleanup-complete";
  runId: string;
  reason: PruneReason;
  anchorCleanup: AnchorCleanup | "pending";
  archiveBytes: number;
  recordedAt: string;
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

async function ensurePlainDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyPresent(error)) throw error;
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new RuntimeError(`archive directory must not be a symbolic link: ${redact(directory)}`);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
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

    let current = this.runDirectory;
    for (const component of relativeDirectory.split(path.sep)) {
      validateComponent(component, "log name");
      current = path.join(current, component);
      await ensurePlainDirectory(current);
      const canonicalCurrent = await realpath(current);
      if (!isWithin(canonicalRunDirectory, canonicalCurrent)) {
        throw new RuntimeError("archive directory escapes run directory");
      }
    }
    return current;
  }

  private async writeArchiveFile(relativePath: string, text: string): Promise<void> {
    const directory = await this.ensureArchiveDirectory(relativePath);
    const destination = path.join(directory, path.basename(relativePath));
    const temporaryPath = path.join(directory, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    let handle;
    let temporaryCreated = false;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      temporaryCreated = true;
      await handle.writeFile(text, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;

      try {
        await link(temporaryPath, destination);
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
        const existing = await readRegularFile(destination);
        if (existing !== text) {
          throw new RuntimeError(`archive entry already exists with different content: ${relativePath}`);
        }
      }
    } finally {
      await handle?.close();
      if (temporaryCreated) {
        await rm(temporaryPath, { force: true });
        await syncDirectory(directory);
      }
    }
  }

  private async writeJson(relativePath: string, value: unknown): Promise<void> {
    const sanitized = redactRecord(value);
    const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
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
    await this.writeJson("result.json", result);
  }

  async writeManifest(manifest: RunManifest): Promise<void> {
    if (manifest.runId !== this.runId) {
      throw new RuntimeError("run manifest id does not match artifact store");
    }
    await this.writeJson("manifest.json", manifest);
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
      return JSON.parse(await readRegularFile(path.join(runDirectory, "manifest.json"))) as RunManifest;
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
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    }));
    return entries.filter((entry): entry is RunEntry => entry !== null).sort(compareEntries);
  }

  private async deleteCandidateAnchor(
    runId: string,
    result: AttemptResult,
  ): Promise<AnchorCleanup> {
    if (result.candidate === null) return "not-applicable";

    const expectedRef = `${CANDIDATE_REF_PREFIX}${runId}`;
    if (result.candidate.anchorRef !== expectedRef) {
      throw new RuntimeError("archived candidate anchor does not match run id");
    }
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(result.candidate.candidateCommitOid)) {
      throw new RuntimeError("archived candidate commit oid is invalid");
    }
    const manifest = await this.readManifest(runId);
    if (manifest === null) {
      throw new RuntimeError("cannot remove candidate anchor without archived repository root");
    }
    const deletion = await git(manifest.repoRoot, [
      "update-ref",
      "--no-deref",
      "-m",
      `claude-architect prune ${runId}`,
      "-d",
      expectedRef,
      result.candidate.candidateCommitOid,
    ]);
    if (deletion.exitCode === 0) return "deleted";

    const symbolic = await git(manifest.repoRoot, ["symbolic-ref", "--quiet", expectedRef]);
    const direct = await git(manifest.repoRoot, ["show-ref", "--verify", "--quiet", expectedRef]);
    if (symbolic.exitCode === 1 && direct.exitCode === 1) return "already-absent";
    const diagnostic = redact(deletion.stderr || deletion.stdout).trim().slice(0, 2_000);
    throw new RuntimeError(
      `failed to remove candidate anchor${diagnostic ? `: ${diagnostic}` : ""}`,
    );
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
        const line = `${JSON.stringify(redactRecord(record))}\n`;
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
      try {
        const result = await this.readResult(entry.runId);
        if (result === null) {
          retained.push({ runId: entry.runId, reason: "incomplete-run" });
          return;
        }
        await this.appendCleanupRecord({
          event: "prune-cleanup-intent",
          runId: entry.runId,
          reason,
          anchorCleanup: "pending",
          archiveBytes: entry.bytes,
          recordedAt: new Date().toISOString(),
        });
        const anchorCleanup = await this.deleteCandidateAnchor(entry.runId, result);
        await this.appendCleanupRecord({
          event: "prune-cleanup-complete",
          runId: entry.runId,
          reason,
          anchorCleanup,
          archiveBytes: entry.bytes,
          recordedAt: new Date().toISOString(),
        });
        await rm(entry.directory, { recursive: true, force: true });
        await syncDirectory(this.runsRoot);
        removed.add(entry.runId);
        retainedBytes -= entry.bytes;
      } catch (error) {
        retained.push({
          runId: entry.runId,
          reason: redact(error instanceof Error ? error.message : String(error)),
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
