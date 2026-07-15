import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { structuralVerify } from "../../src/verify/structural-verifier.js";

interface Fixture {
  repoRoot: string;
  worktreePath: string;
  baseCommitOid: string;
  artifact: CandidateArtifact;
}

const temporaryPaths: string[] = [];

async function runGit(cwd: string, args: string[], indexFile?: string): Promise<string> {
  const result = await git(cwd, args, indexFile);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function frozenFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ca-structural-verifier-"));
  temporaryPaths.push(root);
  const repoRoot = join(root, "repo");
  const worktreePath = join(root, "worktree");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  await writeFile(join(repoRoot, "a.txt"), "hello\n");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, ["worktree", "add", "--detach", "-q", worktreePath, baseCommitOid]);
  await writeFile(join(worktreePath, "a.txt"), "updated\n");

  const frozen = await freezeCandidate({
    repoRoot,
    worktreePath,
    baseCommitOid,
    runId: "structural-test",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(`freeze failed: ${frozen.reason}`);
  return { repoRoot, worktreePath, baseCommitOid, artifact: frozen.artifact };
}

function manifestHash(changedPaths: CandidateArtifact["changedPaths"]): string {
  return createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex");
}

function verify(
  fixture: Fixture,
  artifact = fixture.artifact,
  scope: { writeAllowlist: string[]; forbiddenScope: string[] } = {
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
  },
) {
  return structuralVerify({
    repoRoot: fixture.repoRoot,
    worktreePath: fixture.worktreePath,
    baseCommitOid: fixture.baseCommitOid,
    artifact,
    ...scope,
  });
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("structuralVerify", () => {
  it("accepts an unchanged frozen artifact", async () => {
    const fixture = await frozenFixture();

    await expect(verify(fixture)).resolves.toEqual({
      ok: true,
      failures: [],
      manifestHash: fixture.artifact.manifestHash,
    });
  });

  it("rejects a tampered manifest hash", async () => {
    const fixture = await frozenFixture();

    const result = await verify(fixture, {
      ...fixture.artifact,
      manifestHash: "0".repeat(64),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("manifest-divergence");
    expect(result.manifestHash).toBe(fixture.artifact.manifestHash);
  });

  it("rejects a tampered changed-path manifest even with a matching claimed hash", async () => {
    const fixture = await frozenFixture();
    const changedPaths = fixture.artifact.changedPaths.map(change => ({
      ...change,
      contentHash: "f".repeat(40),
    }));

    const result = await verify(fixture, {
      ...fixture.artifact,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    });

    expect(result.failures).toContain("manifest-divergence");
    expect(result.manifestHash).toBe(fixture.artifact.manifestHash);
  });

  it("rejects a candidate whose anchor no longer resolves to its candidate commit", async () => {
    const fixture = await frozenFixture();
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      fixture.baseCommitOid,
    ]);

    const result = await verify(fixture);

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rejects a candidate commit whose tree differs from the claimed candidate tree", async () => {
    const fixture = await frozenFixture();
    const baseTreeOid = await runGit(
      fixture.repoRoot,
      ["rev-parse", `${fixture.baseCommitOid}^{tree}`],
    );
    const divergentCommitOid = await runGit(fixture.repoRoot, [
      "commit-tree",
      baseTreeOid,
      "-p",
      fixture.baseCommitOid,
      "-m",
      "divergent candidate",
    ]);
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      divergentCommitOid,
    ]);

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateCommitOid: divergentCommitOid,
    });

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rejects a candidate commit without the claimed base as its sole parent", async () => {
    const fixture = await frozenFixture();
    const parentlessCommitOid = await runGit(fixture.repoRoot, [
      "commit-tree",
      fixture.artifact.candidateTreeOid,
      "-m",
      "parentless candidate",
    ]);
    await runGit(fixture.repoRoot, [
      "update-ref",
      fixture.artifact.anchorRef,
      parentlessCommitOid,
    ]);

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateCommitOid: parentlessCommitOid,
    });

    expect(result.failures).toContain("artifact-divergence");
  });

  it("rechecks allowlist and case-insensitive forbidden scope against the frozen tree", async () => {
    const fixture = await frozenFixture();

    const outsideAllowlist = await verify(fixture, fixture.artifact, {
      writeAllowlist: ["src/**"],
      forbiddenScope: [],
    });
    const forbidden = await verify(fixture, fixture.artifact, {
      writeAllowlist: ["a.txt"],
      forbiddenScope: ["A.TXT"],
    });

    expect(outsideAllowlist.failures).toContain("out-of-scope-write");
    expect(forbidden.failures).toContain("out-of-scope-write");
  });

  it("rejects a symlink encoded directly in the immutable candidate tree", async () => {
    const fixture = await frozenFixture();
    const indexFile = join(fixture.repoRoot, ".git", "structural-symlink-index");
    const blobOid = await runGit(fixture.repoRoot, [
      "hash-object",
      "-w",
      join(fixture.worktreePath, "a.txt"),
    ]);
    await runGit(fixture.repoRoot, ["read-tree", fixture.baseCommitOid], indexFile);
    await runGit(fixture.repoRoot, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blobOid},link.txt`,
    ], indexFile);
    const candidateTreeOid = await runGit(fixture.repoRoot, ["write-tree"], indexFile);
    const changedPaths: CandidateArtifact["changedPaths"] = [{
      path: "link.txt",
      changeType: "added",
      mode: "120000",
      contentHash: blobOid,
    }];

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths,
      manifestHash: manifestHash(changedPaths),
    }, {
      writeAllowlist: ["link.txt"],
      forbiddenScope: [],
    });

    expect(result.failures).toContain("modified-symlink");
  });

  it("rejects a candidate tree identical to the base tree", async () => {
    const fixture = await frozenFixture();
    const candidateTreeOid = await runGit(
      fixture.repoRoot,
      ["rev-parse", `${fixture.baseCommitOid}^{tree}`],
    );

    const result = await verify(fixture, {
      ...fixture.artifact,
      candidateTreeOid,
      changedPaths: [],
      manifestHash: manifestHash([]),
    });

    expect(result.failures).toContain("empty-candidate");
  });

  it("rejects a candidate after the main checkout advances", async () => {
    const fixture = await frozenFixture();
    await writeFile(join(fixture.repoRoot, "a.txt"), "new base\n");
    await runGit(fixture.repoRoot, ["add", "a.txt"]);
    await runGit(fixture.repoRoot, ["commit", "-q", "-m", "advance base"]);

    const result = await verify(fixture);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("base-changed");
  });

  it("rejects a candidate when the main checkout becomes dirty", async () => {
    const fixture = await frozenFixture();
    await writeFile(join(fixture.repoRoot, "untracked.txt"), "host edit\n");

    const result = await verify(fixture);

    expect(result.failures).toContain("base-changed");
  });
});
