import { createHash } from "node:crypto";
import type { ChangedPath } from "../protocol/attempt-result.js";
import { RuntimeError } from "../util/errors.js";

/**
 * The single deep owner of the canonical changed-path manifest: parsing git's
 * `-z` diff/tree output, normalizing entries, deterministic sorting, canonical
 * serialization, and the manifest hash. Freeze, structural verification, and
 * controlled integration obtain the manifest here rather than each re-deriving
 * it — so the frozen-artifact hash is stable across freeze, verification, and
 * integration by construction, not by two files hand-keeping the same key order.
 *
 * This module runs no git: callers own their own git invocation (the redacted
 * `checkedGit` seam is candidate 2) and ref plumbing (candidate 3). Both remain
 * future git-seam work and are deliberately out of scope here.
 *
 * The hashed bytes are `JSON.stringify` of the sorted `ChangedPath[]` with the
 * fixed key order {path, changeType, mode, contentHash}. Changing that
 * serialization changes every frozen candidate's hash and is therefore a
 * deliberate artifact-format migration, not a refactor. `MANIFEST_HASH_FORMAT`
 * documents the current format for telemetry; it is never part of the hash.
 */
export const MANIFEST_HASH_FORMAT = "cap-v1";

export interface RawDiffEntry {
  path: string;
  oldMode: string;
  newMode: string;
}

export interface ChangedPathManifest {
  changedPaths: ChangedPath[];
  manifestHash: string;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

/** Split a git `-z` (NUL-delimited) output into fields, dropping the trailing empty field. */
export function splitNul(value: string): string[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

/** Parse `git diff-tree --raw -z` output into mode-bearing entries (used for scope and symlink checks). */
export function parseRawDiff(output: string): RawDiffEntry[] {
  const fields = splitNul(output);
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const metadata = fields[index]!;
    const entryPath = fields[index + 1];
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]$/.exec(metadata);
    if (match === null || entryPath === undefined) {
      throw new RuntimeError("git diff-tree returned invalid raw output");
    }
    entries.push({ path: entryPath, oldMode: match[1]!, newMode: match[2]! });
  }
  return entries;
}

function parseNameStatus(output: string): Array<{ path: string; status: string }> {
  const fields = splitNul(output);
  if (fields.length % 2 !== 0) {
    throw new RuntimeError("git diff-tree returned invalid name-status output");
  }
  const entries: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index]!, path: fields[index + 1]! });
  }
  return entries;
}

function parseTree(output: string): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of splitNul(output)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new RuntimeError("git ls-tree returned invalid output");
    const [mode, , oid] = record.slice(0, separator).split(" ");
    if (mode === undefined || oid === undefined) {
      throw new RuntimeError("git ls-tree returned invalid output");
    }
    entries.set(record.slice(separator + 1), { mode, oid });
  }
  return entries;
}

function changeType(status: string): ChangedPath["changeType"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  return "modified";
}

function sortChangedPaths(changedPaths: ChangedPath[]): ChangedPath[] {
  return changedPaths.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/**
 * The canonical serialization + hash of a changed-path manifest — the single
 * definition of the hashed bytes (`JSON.stringify` of the entries in their fixed
 * key order). Callers that already hold a `ChangedPath[]` (e.g. an archival
 * self-consistency check) hash it here rather than re-deriving the encoding.
 */
export function manifestHashOf(changedPaths: ChangedPath[]): string {
  return createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex");
}

/**
 * Cross-join name-status, raw diff, and tree entries into the canonical sorted
 * `ChangedPath[]` and its hash. Fails closed when the three git outputs disagree.
 */
export function computeChangedPathManifest(inputs: {
  rawDiff: RawDiffEntry[];
  nameStatusOutput: string;
  treeOutput: string;
}): ChangedPathManifest {
  const rawEntries = new Map(inputs.rawDiff.map(entry => [entry.path, entry]));
  const treeEntries = parseTree(inputs.treeOutput);
  const changedPaths = sortChangedPaths(parseNameStatus(inputs.nameStatusOutput).map(({ path, status }) => {
    const treeEntry = treeEntries.get(path);
    const rawEntry = rawEntries.get(path);
    if (treeEntry === undefined && status !== "D") {
      throw new RuntimeError("candidate tree is missing a changed path");
    }
    if (treeEntry === undefined && rawEntry === undefined) {
      throw new RuntimeError("git diff-tree outputs disagree");
    }
    return {
      path,
      changeType: changeType(status),
      mode: treeEntry?.mode ?? rawEntry!.oldMode,
      contentHash: treeEntry?.oid ?? null,
    };
  }));
  return { changedPaths, manifestHash: manifestHashOf(changedPaths) };
}
