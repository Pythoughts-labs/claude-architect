import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import {
  buildRunManifest,
  type BuildRunManifestArgs,
} from "../../src/runtime/run-manifest.js";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "../../src/runtime/redaction.js";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;
let previousPluginRoot: string | undefined;

function sampleResult(runId: string): AttemptResult {
  return {
    resultVersion: "1",
    runId,
    status: "failed",
    failure: "producer-failure",
    summary: "producer exited non-zero",
    producerSummary: null,
    candidate: null,
    requestedVerification: [],
    executedVerification: [],
    unresolvedIssues: [],
    evidence: {},
    logsRef: "logs/producer.log",
    producerId: "codex",
    producerVersion: "1.2.3",
    producerModel: null,
    durationMs: 42,
    sessionId: null,
  };
}

function manifestArgs(runId: string, repoRoot: string): BuildRunManifestArgs {
  return {
    runId,
    repoRoot,
    baseCommitOid: "a".repeat(40),
    candidateManifestHash: null,
    producer: { id: "codex", version: "1.2.3", model: null },
    effectivePolicy: { isolation: "temporary-home", retries: 0 },
    repositoryInstructions: [
      { path: "AGENTS.md", content: "follow the repository rules\n" },
    ],
    prompt: "Implement the requested change",
    executionPolicy: { network: "denied", writeAllowlist: ["src/**"] },
    environment: [
      { name: "PATH", source: "platform" },
      { name: "CODEX_TOKEN", source: "adapter" },
    ],
    packagedVerifier: { version: "1", content: "trusted verifier bytes" },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return result.stdout.trim();
}

beforeEach(async () => {
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  previousPluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const stateRoot = await mkdtemp(join(tmpdir(), "claude-architect-artifacts-"));
  temporaryPaths.push(stateRoot);
  process.env.CLAUDE_PLUGIN_DATA = stateRoot;
  process.env.CLAUDE_PLUGIN_ROOT = join(stateRoot, "plugin-cache");
  clearRegisteredSecrets();
});

afterEach(async () => {
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  clearRegisteredSecrets();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
  it("round-trips an AttemptResult under plugin data", async () => {
    const store = new ArtifactStore("run-round-trip");
    const result = sampleResult("run-round-trip");

    await store.writeResult(result);

    await expect(store.readResult("run-round-trip")).resolves.toEqual(result);
    await expect(store.list()).resolves.toContain("run-round-trip");
    await expect(access(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "run-round-trip",
      "result.json",
    ))).resolves.toBeUndefined();
    await expect(access(join(process.env.CLAUDE_PLUGIN_ROOT!, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps archived JSON valid when a registered secret contains JSON syntax", async () => {
    const registration = registerSecretValue('"runId"');
    const store = new ArtifactStore("run-json-syntax");

    await store.writeResult(sampleResult("run-json-syntax"));

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    expect(() => JSON.parse(stored)).not.toThrow();
    expect(stored).not.toContain('"runId"');
    await expect(store.readResult("run-json-syntax")).resolves.toMatchObject({
      runId: "run-json-syntax",
    });
    registration.dispose();
  });

  it("preserves required result keys when their names equal registered values", async () => {
    const registration = registerSecretValue("ummary");
    const store = new ArtifactStore("run-required-key");

    await store.writeResult(sampleResult("run-required-key"));

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    expect(stored).not.toContain("ummary");
    await expect(store.readResult("run-required-key")).resolves.toMatchObject({
      summary: "producer exited non-zero",
    });
    registration.dispose();
  });

  it("fails closed instead of redacting an AttemptResult status", async () => {
    const registration = registerSecretValue("failed");
    const store = new ArtifactStore("run-status-collision");

    await expect(store.writeResult(sampleResult("run-status-collision"))).rejects.toThrow(
      /safely persist|status/,
    );
    await expect(access(join(store.runDirectory, "result.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    registration.dispose();
  });

  it("fails closed instead of changing hash-bound candidate paths", async () => {
    const secretPath = "enterprise-secret-path.ts";
    const registration = registerSecretValue(secretPath);
    const store = new ArtifactStore("run-candidate-path-collision");
    const result = sampleResult("run-candidate-path-collision");
    const changedPaths = [{
      path: secretPath,
      changeType: "added" as const,
      mode: "100644",
      contentHash: "b".repeat(40),
    }];
    result.candidate = {
      baseCommitOid: "a".repeat(40),
      candidateTreeOid: "b".repeat(40),
      candidateCommitOid: "c".repeat(40),
      anchorRef: "refs/claude-architect/candidates/run-candidate-path-collision",
      manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
      changedPaths,
      patch: "",
    };

    await expect(store.writeResult(result)).rejects.toThrow(/candidate path|safely persist/);
    registration.dispose();
  });

  it("writes redacted logs and returns a relative archive ref", async () => {
    const registration = registerSecretValue("enterprise-secret-value");
    const store = new ArtifactStore("run-log");

    const ref = await store.writeLog("producer", "output enterprise-secret-value\n");

    expect(ref).toBe("logs/producer.log");
    const stored = await readFile(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-log", ref), "utf8");
    expect(stored).not.toContain("enterprise-secret-value");
    expect(stored).toContain("[s]");
    registration.dispose();
  });

  it("redacts registered secrets containing literal marker text from logs", async () => {
    const secret = "prefix[s]suffix";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-marker-secret-log");

    const ref = await store.writeLog("producer", `output ${secret}\n`);

    const stored = await readFile(join(store.runDirectory, ref), "utf8");
    expect(stored).not.toContain(secret);
    expect(stored).toBe("output [s]\n");
    registration.dispose();
  });

  it("redacts registered marker secrets before JSON escaping can hide them", async () => {
    const secret = 'prefix"[s]\\suffix';
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-marker-secret-json");
    const result = sampleResult("run-marker-secret-json");
    result.summary = secret;

    await store.writeResult(result);

    const stored = await readFile(join(store.runDirectory, "result.json"), "utf8");
    const parsed = JSON.parse(stored) as AttemptResult;
    expect(parsed.summary).toBe("[s]");
    expect(JSON.stringify(parsed)).not.toContain(secret);
    registration.dispose();
  });

  it("does not persist a registered secret created by pattern redaction", async () => {
    const secret = "prefix [k] suffix";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-cascading-secret-log");

    const ref = await store.writeLog(
      "producer",
      "prefix sk-ABCDEF0123456789 suffix",
    );

    const stored = await readFile(join(store.runDirectory, ref), "utf8");
    expect(stored).toBe("[s]");
    expect(stored).not.toContain(secret);
    registration.dispose();
  });

  it("redacts registered secrets used as JSON property names", async () => {
    const secret = "enterprise-secret-key";
    const registration = registerSecretValue(secret);
    const store = new ArtifactStore("run-json-key");
    const result = sampleResult("run-json-key");
    result.evidence = { [secret]: "ordinary value" };

    await store.writeResult(result);

    const stored = await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "run-json-key",
      "result.json",
    ), "utf8");
    expect(stored).not.toContain(secret);
    const parsed = JSON.parse(stored) as AttemptResult;
    expect(Object.keys(parsed.evidence)).toContain("[s]");
    registration.dispose();
  });

  it("rejects path traversal in run and log names", async () => {
    expect(() => new ArtifactStore("../outside")).toThrow(/invalid run id/);
    expect(() => new ArtifactStore("CON")).toThrow(/invalid run id/);
    expect(() => new ArtifactStore("Run-A")).toThrow(/invalid run id/);
    const store = new ArtifactStore("run-safe");

    await expect(store.writeLog("../outside", "text")).rejects.toThrow(/invalid log name/);
  });

  it("rejects a symlinked archive directory instead of writing outside plugin data", async () => {
    const external = await mkdtemp(join(tmpdir(), "claude-architect-external-"));
    temporaryPaths.push(external);
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-linked");
    await mkdir(runDirectory, { recursive: true });
    await symlink(external, join(runDirectory, "logs"), "dir");
    const store = new ArtifactStore("run-linked");

    await expect(store.writeLog("producer", "must stay contained")).rejects.toThrow(
      /archive directory|symbolic link/,
    );
    await expect(access(join(external, "producer.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps terminal artifacts create-once and permits idempotent retries", async () => {
    const store = new ArtifactStore("run-create-once");
    const original = sampleResult("run-create-once");
    await store.writeResult(original);

    await expect(store.writeResult(original)).resolves.toBeUndefined();
    await expect(store.writeResult({
      ...original,
      summary: "conflicting terminal result",
    })).rejects.toThrow(/already exists with different content/);
    await expect(store.readResult("run-create-once")).resolves.toEqual(original);
  });

  it("allows only one conflicting concurrent terminal write", async () => {
    const store = new ArtifactStore("run-concurrent");
    const first = sampleResult("run-concurrent");
    const second = { ...first, summary: "different terminal result" };

    const outcomes = await Promise.allSettled([
      store.writeResult(first),
      store.writeResult(second),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    const stored = await store.readResult("run-concurrent");
    expect([first.summary, second.summary]).toContain(stored?.summary);
  });

  it("prunes over-age runs", async () => {
    const oldStore = new ArtifactStore("run-old");
    await oldStore.writeResult(sampleResult("run-old"));
    const oldDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-old");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(oldDirectory, oldTime, oldTime);

    const result = await oldStore.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    expect(result.removed).toContain("run-old");
    await expect(stat(oldDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces the byte limit", async () => {
    const store = new ArtifactStore("run-large");
    await store.writeResult(sampleResult("run-large"));
    await store.writeLog("large", "x".repeat(1_000));

    const result = await store.prune({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxBytes: 0 });

    expect(result.removed).toContain("run-large");
  });

  it("does not prune a run without a terminal AttemptResult", async () => {
    const store = new ArtifactStore("run-active");
    await store.writeLog("producer", "still running");
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-active");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const result = await store.prune({ maxAgeMs: 1_000, maxBytes: 0 });

    expect(result.removed).not.toContain("run-active");
    expect(result.retained).toContainEqual({ runId: "run-active", reason: "incomplete-run" });
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("durably records cleanup before removing an archived run", async () => {
    const store = new ArtifactStore("run-audited");
    await store.writeResult(sampleResult("run-audited"));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-audited");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    const journal = await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8");
    const records = journal.trim().split("\n").map(line => JSON.parse(line) as {
      runId: string;
      reason: string;
      anchorCleanup: string;
    });
    expect(records.at(-1)).toMatchObject({
      runId: "run-audited",
      reason: "max-age",
      anchorCleanup: "not-applicable",
    });
  });

  it("deletes a candidate anchor before pruning its archive", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-prune-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-anchor";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-anchor");
    const result = sampleResult("run-anchor");
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-anchor", repoRoot)));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-anchor");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    await expect(git(repoRoot, ["show-ref", "--verify", anchorRef])).rejects.toBeDefined();
    await expect(git(repoRoot, [
      "show-ref",
      "--verify",
      "refs/claude-architect/prune-backups/run-anchor",
    ])).rejects.toBeDefined();
    await expect(stat(runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records cleanup intent before deleting a candidate anchor", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-intent-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-intent";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-intent");
    const result = sampleResult("run-intent");
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-intent", repoRoot)));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-intent");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    const records = (await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
      event: string;
      runId: string;
      anchorCleanup: string;
    });
    expect(records.slice(-2)).toMatchObject([
      { event: "prune-cleanup-intent", runId: "run-intent", anchorCleanup: "pending" },
      { event: "prune-cleanup-complete", runId: "run-intent", anchorCleanup: "deleted" },
    ]);
  });

  it("retains a candidate anchor when cleanup intent cannot be recorded", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-intent-failure-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-intent-failure";
    await git(repoRoot, ["update-ref", anchorRef, commitOid]);

    const store = new ArtifactStore("run-intent-failure");
    const result = sampleResult("run-intent-failure");
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-intent-failure", repoRoot)));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-intent-failure");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);
    await mkdir(join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "cleanup.ndjson"));

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-intent-failure");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(commitOid);
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("deletes a symbolic candidate anchor without dereferencing it", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-symref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const commitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const branchRef = await git(repoRoot, ["symbolic-ref", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-symref";
    await git(repoRoot, ["symbolic-ref", anchorRef, branchRef]);

    const store = new ArtifactStore("run-symref");
    const result = sampleResult("run-symref");
    result.candidate = {
      baseCommitOid: commitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid: commitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-symref", repoRoot)));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-symref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    await store.prune({ maxAgeMs: 1_000, maxBytes: Number.MAX_SAFE_INTEGER });

    await expect(git(repoRoot, ["rev-parse", branchRef])).resolves.toBe(commitOid);
    await expect(git(repoRoot, ["symbolic-ref", anchorRef])).rejects.toBeDefined();
  });

  it("retains the archive when the candidate anchor moved", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-moved-ref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-moved-ref";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-moved-ref");
    const result = sampleResult("run-moved-ref");
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-moved-ref", repoRoot)));
    await writeFile(join(repoRoot, "later.txt"), "later\n");
    await git(repoRoot, ["add", "later.txt"]);
    await git(repoRoot, ["commit", "-q", "-m", "later"]);
    const movedCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    await git(repoRoot, ["update-ref", anchorRef, movedCommitOid]);
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-moved-ref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-moved-ref");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(movedCommitOid);
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("retains the archive when the candidate anchor is a dangling symbolic ref", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-dangling-ref-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-dangling-ref";
    await git(repoRoot, ["symbolic-ref", anchorRef, "refs/heads/missing"]);

    const store = new ArtifactStore("run-dangling-ref");
    const result = sampleResult("run-dangling-ref");
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs("run-dangling-ref", repoRoot)));
    const runDirectory = join(process.env.CLAUDE_PLUGIN_DATA!, "runs", "run-dangling-ref");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-dangling-ref");
    expect(await git(repoRoot, ["symbolic-ref", anchorRef])).toBe("refs/heads/missing");
    await expect(stat(runDirectory)).resolves.toBeDefined();
  });

  it("rejects a tampered manifest before pruning a candidate anchor", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-integrity-repo-"));
    const otherRepo = await mkdtemp(join(tmpdir(), "claude-architect-other-repo-"));
    temporaryPaths.push(repoRoot, otherRepo);
    for (const repository of [repoRoot, otherRepo]) {
      await git(repository, ["init", "-q"]);
      await git(repository, ["commit", "--allow-empty", "-q", "-m", "base"]);
    }
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-tampered-manifest";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-tampered-manifest");
    const result = sampleResult("run-tampered-manifest");
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-tampered-manifest",
      repoRoot,
    )));
    const manifestPath = join(store.runDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.repoRoot = otherRepo;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).not.toContain("run-tampered-manifest");
    expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(candidateCommitOid);
    await expect(stat(store.runDirectory)).resolves.toBeDefined();
  });

  it("restores the candidate anchor when archive removal fails", async () => {
    if (process.platform === "win32") return;
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-rollback-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-prune-rollback";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-prune-rollback");
    const result = sampleResult("run-prune-rollback");
    result.candidate = {
      baseCommitOid: candidateCommitOid,
      candidateTreeOid: await git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
      candidateCommitOid,
      anchorRef,
      manifestHash: createHash("sha256").update("[]").digest("hex"),
      changedPaths: [],
      patch: "",
    };
    await store.writeResult(result);
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-prune-rollback",
      repoRoot,
    )));
    await store.writeLog("locked", "retain me");
    const logsDirectory = join(store.runDirectory, "logs");
    await chmod(logsDirectory, 0o500);
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    try {
      const pruned = await store.prune({
        maxAgeMs: 1_000,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });

      expect(pruned.removed).not.toContain("run-prune-rollback");
      expect(pruned.retained.some(entry => entry.runId === "run-prune-rollback")).toBe(true);
      expect(await git(repoRoot, ["rev-parse", anchorRef])).toBe(candidateCommitOid);
      await expect(git(repoRoot, [
        "show-ref",
        "--verify",
        "refs/claude-architect/prune-backups/run-prune-rollback",
      ])).rejects.toBeDefined();
      await expect(stat(store.runDirectory)).resolves.toBeDefined();
    } finally {
      await chmod(logsDirectory, 0o700).catch(() => {});
    }
  });
});

describe("buildRunManifest", () => {
  it("fails closed when redaction would change repository identity", () => {
    const repoRoot = "/canonical/enterprise-secret-repository";
    const registration = registerSecretValue(repoRoot);

    expect(() => buildRunManifest(manifestArgs("run-repo-collision", repoRoot))).toThrow(
      /repository root|safely persist/,
    );
    registration.dispose();
  });

  it("records reproducibility hashes and names-only environment provenance", () => {
    const registration = registerSecretValue("manifest-secret-value");
    const args = manifestArgs("run-manifest", "/canonical/repo");
    args.effectivePolicy = {
      token: "manifest-secret-value",
      "manifest-secret-value": true,
      nested: { beta: 2, alpha: 1 },
    };

    const manifest = buildRunManifest(args);
    const reordered = buildRunManifest({
      ...args,
      effectivePolicy: {
        nested: { alpha: 1, beta: 2 },
        "manifest-secret-value": true,
        token: "manifest-secret-value",
      },
      environment: [...args.environment].reverse(),
    });

    expect(manifest.promptHash).toBe(
      createHash("sha256").update(args.prompt).digest("hex"),
    );
    expect(manifest.repositoryInstructions).toEqual([
      {
        path: "AGENTS.md",
        hash: createHash("sha256")
          .update("follow the repository rules\n")
          .digest("hex"),
      },
    ]);
    expect(manifest.packagedVerifier.hash).toBe(
      createHash("sha256").update("trusted verifier bytes").digest("hex"),
    );
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.manifestHash).toBe(reordered.manifestHash);
    expect(JSON.stringify(manifest)).not.toContain("manifest-secret-value");
    expect(manifest.environment).toEqual([
      { name: "CODEX_TOKEN", source: "adapter" },
      { name: "PATH", source: "platform" },
    ]);
    registration.dispose();
  });

  it("keeps the persisted manifest hash consistent after value redaction", async () => {
    const registration = registerSecretValue("secret");
    const store = new ArtifactStore("run-manifest-hash");
    const args = manifestArgs("run-manifest-hash", "/canonical/repo");
    args.producer.version = "secret";
    await store.writeManifest(buildRunManifest(args));

    const persisted = JSON.parse(await readFile(
      join(store.runDirectory, "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    const manifestHash = persisted.manifestHash;
    delete persisted.manifestHash;
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    };
    const recomputed = createHash("sha256")
      .update(JSON.stringify(canonicalize(persisted)))
      .digest("hex");

    expect(manifestHash).toBe(recomputed);
    registration.dispose();
  });

  it("rehashes a manifest when a secret is registered after construction", async () => {
    const manifest = buildRunManifest(manifestArgs(
      "run-manifest-late-secret",
      "/canonical/repo",
    ));
    const registration = registerSecretValue("platform");
    const store = new ArtifactStore("run-manifest-late-secret");

    await store.writeManifest(manifest);

    const persisted = JSON.parse(await readFile(
      join(store.runDirectory, "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    const manifestHash = persisted.manifestHash;
    delete persisted.manifestHash;
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]));
    };

    expect(manifestHash).toBe(createHash("sha256")
      .update(JSON.stringify(canonicalize(persisted)))
      .digest("hex"));
    expect(JSON.stringify(persisted)).not.toContain("platform");
    registration.dispose();
  });

  it("fails closed when the final manifest hash equals a registered secret", async () => {
    const manifest = buildRunManifest(manifestArgs(
      "run-manifest-hash-collision",
      "/canonical/repo",
    ));
    const registration = registerSecretValue(manifest.manifestHash);
    const store = new ArtifactStore("run-manifest-hash-collision");

    await expect(store.writeManifest(manifest)).rejects.toThrow(/safely persist/);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    registration.dispose();
  });
});
