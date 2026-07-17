import { createHash } from "node:crypto";
import { git, type GitResult } from "../git/git-exec.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { redact } from "../runtime/redaction.js";
import { RuntimeError } from "../util/errors.js";

const MAX_DIAGNOSTIC_LENGTH = 2_000;

export type StructuralFailure =
  | "manifest-divergence"
  | "artifact-divergence"
  | "out-of-scope-write"
  | "modified-symlink"
  | "empty-candidate"
  | "base-changed";

export interface StructuralVerifyArgs {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
  writeAllowlist: string[];
  forbiddenScope: string[];
}

export interface StructuralVerifyResult {
  ok: boolean;
  failures: StructuralFailure[];
  manifestHash: string;
}

interface RawDiffEntry {
  path: string;
  oldMode: string;
  newMode: string;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

function gitFailure(action: string, result: GitResult): RuntimeError {
  const diagnostic = redact(result.stderr || result.stdout).trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
  return new RuntimeError(`${action} failed${diagnostic ? `: ${diagnostic}` : ""}`);
}

async function checkedGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw gitFailure(`git ${args[0] ?? "command"}`, result);
  return result.stdout;
}

function splitNul(value: string): string[] {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function parseRawDiff(output: string): RawDiffEntry[] {
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

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globMatches(pattern: string, candidate: string, caseInsensitive = false): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character !== "*") {
      expression += escapeRegex(character);
      continue;
    }
    if (pattern[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }
    index += 1;
    if (pattern[index + 1] === "/") {
      expression += "(?:.*/)?";
      index += 1;
    } else {
      expression += ".*";
    }
  }
  return new RegExp(`${expression}$`, caseInsensitive ? "i" : undefined).test(candidate);
}

function isAllowed(
  pathname: string,
  writeAllowlist: string[],
  forbiddenScope: string[],
  opaqueDirectory = false,
): boolean {
  const scopePaths = opaqueDirectory ? [pathname, `${pathname}/`] : [pathname];
  return writeAllowlist.some(pattern => scopePaths.some(candidate => globMatches(pattern, candidate)))
    && !forbiddenScope.some(pattern =>
      scopePaths.some(candidate => globMatches(pattern, candidate, true)));
}

export async function recomputeManifest(args: Pick<
  StructuralVerifyArgs,
  "worktreePath" | "baseCommitOid" | "artifact"
>): Promise<{
  changedPaths: ChangedPath[];
  manifestHash: string;
  rawDiff: RawDiffEntry[];
}> {
  const [rawOutput, nameStatusOutput, treeOutput] = await Promise.all([
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--raw",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, [
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--name-status",
      "-z",
      args.baseCommitOid,
      args.artifact.candidateTreeOid,
    ]),
    checkedGit(args.worktreePath, ["ls-tree", "-r", "-z", args.artifact.candidateTreeOid]),
  ]);
  const rawDiff = parseRawDiff(rawOutput);
  const rawByPath = new Map(rawDiff.map(entry => [entry.path, entry]));
  const treeByPath = parseTree(treeOutput);
  const changedPaths = sortChangedPaths(parseNameStatus(nameStatusOutput).map(({ path, status }) => {
    const rawEntry = rawByPath.get(path);
    const treeEntry = treeByPath.get(path);
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
  return {
    changedPaths,
    manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
    rawDiff,
  };
}

async function artifactIdentityMatches(args: StructuralVerifyArgs): Promise<boolean> {
  const [anchorResult, treeResult, parentResult] = await Promise.all([
    git(args.repoRoot, ["rev-parse", "--verify", `${args.artifact.anchorRef}^{commit}`]),
    git(args.repoRoot, [
      "rev-parse",
      "--verify",
      `${args.artifact.candidateCommitOid}^{tree}`,
    ]),
    git(args.repoRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      args.artifact.candidateCommitOid,
    ]),
  ]);
  if (anchorResult.exitCode !== 0 || treeResult.exitCode !== 0 || parentResult.exitCode !== 0) {
    return false;
  }
  const commitAndParents = parentResult.stdout.trim().split(/\s+/);
  return anchorResult.stdout.trim() === args.artifact.candidateCommitOid
    && treeResult.stdout.trim() === args.artifact.candidateTreeOid
    && commitAndParents.length === 2
    && commitAndParents[0] === args.artifact.candidateCommitOid
    && commitAndParents[1] === args.baseCommitOid;
}

export async function structuralVerify(args: StructuralVerifyArgs): Promise<StructuralVerifyResult> {
  const failures = new Set<StructuralFailure>();
  const [manifest, baseTreeOid, currentHead, mainStatus, artifactIdentityValid] = await Promise.all([
    recomputeManifest(args),
    checkedGit(args.repoRoot, ["rev-parse", `${args.baseCommitOid}^{tree}`]),
    checkedGit(args.repoRoot, ["rev-parse", "--verify", "HEAD"]),
    checkedGit(args.repoRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]),
    artifactIdentityMatches(args),
  ]);

  if (args.artifact.baseCommitOid !== args.baseCommitOid
    || currentHead.trim() !== args.baseCommitOid
    || mainStatus.length > 0) {
    failures.add("base-changed");
  }
  if (JSON.stringify(args.artifact.changedPaths) !== JSON.stringify(manifest.changedPaths)
    || args.artifact.manifestHash !== manifest.manifestHash) {
    failures.add("manifest-divergence");
  }
  if (!artifactIdentityValid) {
    failures.add("artifact-divergence");
  }
  if (manifest.changedPaths.some(change =>
    !isAllowed(
      change.path,
      args.writeAllowlist,
      args.forbiddenScope,
      change.mode === "160000",
    ))) {
    failures.add("out-of-scope-write");
  }
  if (manifest.rawDiff.some(entry =>
    [entry.oldMode, entry.newMode].some(mode => mode === "120000" || mode === "160000"))) {
    failures.add("modified-symlink");
  }
  if (manifest.changedPaths.length === 0
    || args.artifact.candidateTreeOid === baseTreeOid.trim()) {
    failures.add("empty-candidate");
  }

  return {
    ok: failures.size === 0,
    failures: [...failures],
    manifestHash: manifest.manifestHash,
  };
}
