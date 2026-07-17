import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptResult } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import {
  buildRunManifest,
  sanitizeRunManifest,
  type BuildRunManifestArgs,
} from "../../src/runtime/run-manifest.js";
import {
  clearRegisteredSecrets,
  registerSecretValue,
} from "../../src/runtime/redaction.js";

const filesystemHooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((filename: string) => Promise<void>),
  beforeLstat: undefined as undefined | ((filename: string) => Promise<void>),
  beforeDirectoryRead: undefined as undefined | ((filename: string) => Promise<void>),
  beforeRm: undefined as undefined | ((filename: string) => Promise<void>),
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hook = filesystemHooks.beforeOpen;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.open(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const hook = filesystemHooks.beforeLstat;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.lstat(...args);
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const hook = filesystemHooks.beforeDirectoryRead;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.opendir(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const hook = filesystemHooks.beforeDirectoryRead;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.readdir(...args);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const hook = filesystemHooks.beforeRm;
      if (hook !== undefined) await hook(String(args[0]));
      return actual.rm(...args);
    },
  };
});

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const emptyCandidateManifestHash = createHash("sha256").update("[]").digest("hex");
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

function manifestArgs(
  runId: string,
  repoRoot: string,
  candidateManifestHash: string | null = null,
  baseCommitOid = "a".repeat(40),
): BuildRunManifestArgs {
  return {
    runId,
    repoRoot,
    baseCommitOid,
    candidateManifestHash,
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
  filesystemHooks.beforeOpen = undefined;
  filesystemHooks.beforeLstat = undefined;
  filesystemHooks.beforeDirectoryRead = undefined;
  filesystemHooks.beforeRm = undefined;
  clearRegisteredSecrets();
});

afterEach(async () => {
  filesystemHooks.beforeOpen = undefined;
  filesystemHooks.beforeLstat = undefined;
  filesystemHooks.beforeDirectoryRead = undefined;
  filesystemHooks.beforeRm = undefined;
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  if (previousPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
  else process.env.CLAUDE_PLUGIN_ROOT = previousPluginRoot;
  clearRegisteredSecrets();
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("ArtifactStore", () => {
  it("redacts secrets in persisted pipeline artifacts", async () => {
    const runId = "run-pipeline-redaction";
    const secret = "sk-pipeline-secret-12345678";
    const store = new ArtifactStore(runId);

    await store.writePipelineArtifact("round-1-review", {
      summary: `provider returned ${secret}`,
      nested: { rawOutput: `Bearer bearer-secret-value and ${secret}` },
    });

    const persisted = await readFile(join(
      store.runDirectory,
      "pipeline",
      "round-1-review.json",
    ), "utf8");
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("bearer-secret-value");
    await expect(store.readPipelineArtifact(runId, "round-1-review")).resolves.toEqual({
      nested: { rawOutput: "Bearer [b] and [k]" },
      summary: "provider returned [k]",
    });
  });

  it("promotes terminal artifacts before a decision and recomputes manifest integrity", async () => {
    const runId = "run-promote";
    const store = new ArtifactStore(runId);
    const original = sampleResult(runId);
    const promoted = { ...original, summary: "promoted result" };
    const originalManifest = buildRunManifest(manifestArgs(runId, "/repo"));
    const promotedManifest = { ...originalManifest, candidateManifestHash: emptyCandidateManifestHash };
    await store.writeResult(original);
    await store.writeManifest(originalManifest);

    await store.promoteTerminalArtifacts({ result: promoted, manifest: promotedManifest });

    await expect(store.readResult(runId)).resolves.toEqual(promoted);
    await expect(store.readManifest(runId)).resolves.toEqual(sanitizeRunManifest(promotedManifest));
  });

  it("rejects terminal promotion across run ids or after a decision", async () => {
    const runId = "run-promote-guarded";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));
    await store.writeResult(sampleResult(runId));
    await store.writeManifest(manifest);

    await expect(store.promoteTerminalArtifacts({
      result: sampleResult("different-run"),
      manifest,
    })).rejects.toThrow(/run id/i);
    await expect(store.promoteTerminalArtifacts({
      result: sampleResult(runId),
      manifest: buildRunManifest(manifestArgs("different-run", "/repo")),
    })).rejects.toThrow(/manifest id/i);

    await store.writeDecision({ decision: "accepted", recordedAt: new Date().toISOString() });
    await expect(store.promoteTerminalArtifacts({
      result: { ...sampleResult(runId), summary: "too late" },
      manifest,
    })).rejects.toThrow(/after a decision/i);
  });

  it("creates each missing plugin-data directory before archiving", async () => {
    const parent = await mkdtemp(join(tmpdir(), "claude-architect-missing-state-"));
    temporaryPaths.push(parent);
    process.env.CLAUDE_PLUGIN_DATA = join(parent, "nested", "plugin-data");
    const store = new ArtifactStore("run-missing-state");

    await store.writeResult(sampleResult("run-missing-state"));

    await expect(stat(join(
      process.env.CLAUDE_PLUGIN_DATA,
      "runs",
      "run-missing-state",
      "result.json",
    ))).resolves.toBeDefined();
  });

  it("preserves baseline and mutation policy on archived verification commands", async () => {
    const store = new ArtifactStore("run-allowed-mutations");
    const result = sampleResult("run-allowed-mutations");
    result.requestedVerification = [{
      id: "install-deps",
      executable: "npm",
      args: ["ci"],
      cwd: ".",
      timeoutMs: 60_000,
      network: "allowed",
      allowedMutations: "ignored-paths",
      expectBaselineFailure: true,
      expectedExitCodes: [0],
    }];

    await store.writeResult(result);

    const archived = await store.readResult("run-allowed-mutations");
    expect(archived?.requestedVerification[0]?.allowedMutations).toBe("ignored-paths");
    expect(archived?.requestedVerification[0]?.expectBaselineFailure).toBe(true);
  });

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

  it("rejects malformed and cross-run archived AttemptResults", async () => {
    const malformedRunId = "run-malformed-result";
    const malformedStore = new ArtifactStore(malformedRunId);
    await malformedStore.writeLog("producer", "create run directory\n");
    await writeFile(join(malformedStore.runDirectory, "result.json"), "{}\n");
    await expect(malformedStore.readResult(malformedRunId)).rejects.toThrow(
      /attempt result.*invalid|run id/i,
    );

    const crossRunId = "run-cross-result";
    const crossStore = new ArtifactStore(crossRunId);
    await crossStore.writeLog("producer", "create run directory\n");
    await writeFile(
      join(crossStore.runDirectory, "result.json"),
      `${JSON.stringify(sampleResult("different-run"))}\n`,
    );
    await expect(crossStore.readResult(crossRunId)).rejects.toThrow(/attempt result.*run id/i);
  });

  it("rejects a runtime-invalid AttemptResult before writing it", async () => {
    const runId = "run-invalid-result-write";
    const store = new ArtifactStore(runId);
    const invalid = {
      ...sampleResult(runId),
      status: "verified-candidate",
      failure: null,
      candidate: null,
    } as AttemptResult;

    await expect(store.writeResult(invalid)).rejects.toThrow(/attempt result.*invalid/i);
  });

  it("validates run ids before reading manifests", async () => {
    const store = new ArtifactStore("run-manifest-id-check");

    await expect(store.readManifest("../outside")).rejects.toThrow(/invalid run id/i);
  });

  it("treats an archived runtime version as provenance", async () => {
    const runId = "run-older-runtime";
    const store = new ArtifactStore(runId);
    const manifest = {
      ...buildRunManifest(manifestArgs(runId, "/repo")),
      runtimeVersion: "0.16.0",
    };

    await store.writeManifest(manifest);

    await expect(store.readManifest(runId)).resolves.toMatchObject({
      runId,
      runtimeVersion: "0.16.0",
    });
  });

  it("rejects incompatible manifest schema versions before writing", async () => {
    const runId = "run-incompatible-manifest-schema";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));

    await expect(store.writeManifest({
      ...manifest,
      schemaVersions: { ...manifest.schemaVersions, delegationSpec: "2" },
    } as never)).rejects.toThrow(/manifest contract/i);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an invalid manifest shape before writing", async () => {
    const runId = "run-invalid-manifest-shape";
    const store = new ArtifactStore(runId);
    const manifest = buildRunManifest(manifestArgs(runId, "/repo"));

    await expect(store.writeManifest({
      ...manifest,
      producer: { ...manifest.producer, unexpected: true },
    } as never)).rejects.toThrow(/manifest.*malformed|manifest contract/i);
    await expect(access(join(store.runDirectory, "manifest.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an oversized archive entry before reading it into memory", async () => {
    const runId = "run-oversized-read";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    await truncate(join(store.runDirectory, "result.json"), 8_000_001);

    await expect(store.readResult(runId)).rejects.toThrow(/archive entry.*large|byte limit/i);
  });

  it("rejects a hardlinked archive entry", async () => {
    const runId = "run-hardlinked-read";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const destination = join(store.runDirectory, "result.json");
    const external = join(process.env.CLAUDE_PLUGIN_DATA!, "external-result.json");
    await writeFile(external, `${JSON.stringify({
      ...sampleResult(runId),
      summary: "forged hardlink result",
    })}\n`);
    await rm(destination);
    await link(external, destination);

    await expect(store.readResult(runId)).rejects.toThrow(/hardlink|link count/i);
  });

  it("fails size accounting when a run directory is swapped for a symlink", async () => {
    const runId = "run-size-swap";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preserved = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-size-swap");
    const external = await mkdtemp(join(tmpdir(), "claude-architect-size-external-"));
    temporaryPaths.push(external);
    await writeFile(join(external, "outside.txt"), "outside\n");
    let swapped = false;
    filesystemHooks.beforeDirectoryRead = async filename => {
      if (swapped || filename !== store.runDirectory) return;
      swapped = true;
      filesystemHooks.beforeDirectoryRead = undefined;
      await rename(store.runDirectory, preserved);
      await symlink(external, store.runDirectory, "dir");
    };

    await expect(store.prune({
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/directory identity|symbolic link/i);

    expect(swapped).toBe(true);
    await expect(readFile(join(external, "outside.txt"), "utf8")).resolves.toBe("outside\n");
  });

  it("binds size accounting to the directory identity captured by listing", async () => {
    const runId = "run-size-identity";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preserved = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-size-identity");
    let probes = 0;
    filesystemHooks.beforeLstat = async filename => {
      if (filename !== store.runDirectory || ++probes !== 2) return;
      filesystemHooks.beforeLstat = undefined;
      await rename(store.runDirectory, preserved);
      await mkdir(store.runDirectory);
      await writeFile(join(store.runDirectory, "replacement.txt"), "replacement\n");
    };

    await expect(store.prune({
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    })).rejects.toThrow(/directory identity/i);

    expect(probes).toBe(2);
    await expect(stat(preserved)).resolves.toBeDefined();
  });

  it.each(["../../outside.ts", "/absolute.ts", "C:\\outside.ts", "src/../outside.ts"])(
    "rejects an unsafe candidate path %s",
    async candidatePath => {
      const runId = "run-unsafe-candidate-path";
      const store = new ArtifactStore(runId);
      const result = sampleResult(runId);
      const changedPaths = [{
        path: candidatePath,
        changeType: "added" as const,
        mode: "100644",
        contentHash: "b".repeat(40),
      }];
      result.failure = "verification-failure";
      result.candidate = {
        baseCommitOid: "a".repeat(40),
        candidateTreeOid: "b".repeat(40),
        candidateCommitOid: "c".repeat(40),
        anchorRef: `refs/claude-architect/candidates/${runId}`,
        manifestHash: createHash("sha256").update(JSON.stringify(changedPaths)).digest("hex"),
        changedPaths,
        patch: "",
      };

      await expect(store.writeResult(result)).rejects.toThrow(/candidate path/i);
    },
  );

  it("persists and replaces the latest candidate decision", async () => {
    const runId = "run-decision";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));

    await store.writeDecision({
      decision: "revision-requested",
      recordedAt: "2026-07-14T12:00:00.000Z",
    });
    await store.writeDecision({
      decision: "accepted",
      recordedAt: "2026-07-14T12:01:00.000Z",
    });

    await expect(store.readDecision(runId)).resolves.toEqual({
      decision: "accepted",
      recordedAt: "2026-07-14T12:01:00.000Z",
    });
    const stored = JSON.parse(await readFile(join(store.runDirectory, "decision.json"), "utf8"));
    expect(stored).toMatchObject({ decision: "accepted" });
  });

  it("does not accept a forged result after a validated run directory is swapped", async () => {
    const runId = "run-read-swap";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const preservedPath = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-run-read-swap");
    let swapped = false;
    filesystemHooks.beforeOpen = async filename => {
      if (swapped || !filename.endsWith(join(runId, "result.json"))) return;
      swapped = true;
      filesystemHooks.beforeOpen = undefined;
      await rename(store.runDirectory, preservedPath);
      await mkdir(store.runDirectory);
      await writeFile(filename, `${JSON.stringify({
        ...sampleResult(runId),
        summary: "forged result",
      })}\n`);
    };

    const result = await store.readResult(runId).catch(() => null);

    expect(swapped).toBe(true);
    expect(result?.summary).not.toBe("forged result");
    await expect(stat(preservedPath)).resolves.toBeDefined();
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

  it.each([
    ["producer id", (result: AttemptResult) => { result.producerId = "identity-secret"; }],
    ["producer version", (result: AttemptResult) => { result.producerVersion = "identity-secret"; }],
    ["producer model", (result: AttemptResult) => { result.producerModel = "identity-secret"; }],
    ["session id", (result: AttemptResult) => { result.sessionId = "identity-secret"; }],
  ])("fails closed instead of redacting the AttemptResult %s", async (_label, assign) => {
    const registration = registerSecretValue("identity-secret");
    const store = new ArtifactStore("run-result-identity");
    const result = sampleResult("run-result-identity");
    assign(result);

    await expect(store.writeResult(result)).rejects.toThrow(/safely persist/);
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
    result.failure = "verification-failure";
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

  it("does not write cleanup intent after the archive root is swapped", async () => {
    const runId = "run-cleanup-root-swap";
    const store = new ArtifactStore(runId);
    await store.writeResult(sampleResult(runId));
    const runsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const preservedRunsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "preserved-runs");
    const cleanupJournal = join(runsRoot, "cleanup.ndjson");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    let swapped = false;
    filesystemHooks.beforeOpen = async filename => {
      if (swapped || filename !== cleanupJournal) return;
      swapped = true;
      filesystemHooks.beforeOpen = undefined;
      await rename(runsRoot, preservedRunsRoot);
      await mkdir(runsRoot);
    };

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(swapped).toBe(true);
    expect(pruned.removed).not.toContain(runId);
    expect(pruned.retained.some(entry => entry.runId === runId)).toBe(true);
    await expect(stat(join(preservedRunsRoot, runId))).resolves.toBeDefined();
    await expect(readFile(cleanupJournal, "utf8")).resolves.toBe("");
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
    result.failure = "verification-failure";
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
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-anchor",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
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
    result.failure = "verification-failure";
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
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-intent",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
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
    result.failure = "verification-failure";
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
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-intent-failure",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
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
    result.failure = "verification-failure";
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
    await store.writeManifest(buildRunManifest(manifestArgs(
      "run-symref",
      repoRoot,
      emptyCandidateManifestHash,
      commitOid,
    )));
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
    result.failure = "verification-failure";
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
      "run-moved-ref",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
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
    result.failure = "verification-failure";
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
      "run-dangling-ref",
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
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
    result.failure = "verification-failure";
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
      emptyCandidateManifestHash,
      candidateCommitOid,
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

  it("does not restore a partially deleted quarantine as a retained archive", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-rollback-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const anchorRef = "refs/claude-architect/candidates/run-prune-rollback";
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);

    const store = new ArtifactStore("run-prune-rollback");
    const result = sampleResult("run-prune-rollback");
    result.failure = "verification-failure";
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
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    await store.writeLog("first", "first log\n");
    await store.writeLog("second", "second log\n");
    filesystemHooks.beforeRm = async filename => {
      if (!filename.includes(".prune-run-prune-rollback-")) return;
      filesystemHooks.beforeRm = undefined;
      await rm(join(filename, "logs", "first.log"));
      throw Object.assign(new Error("forced partial archive removal"), { code: "EACCES" });
    };
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(pruned.removed).toContain("run-prune-rollback");
    expect(pruned.retained.some(entry => entry.runId === "run-prune-rollback")).toBe(false);
    await expect(git(repoRoot, ["show-ref", "--verify", anchorRef])).rejects.toBeDefined();
    expect(await git(repoRoot, [
      "rev-parse",
      "refs/claude-architect/prune-backups/run-prune-rollback",
    ])).toBe(candidateCommitOid);
    await expect(stat(store.runDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a replacement swapped into the quarantine path", async () => {
    const store = new ArtifactStore("run-quarantine-swap");
    await store.writeResult(sampleResult("run-quarantine-swap"));
    const runsRoot = join(process.env.CLAUDE_PLUGIN_DATA!, "runs");
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);
    const preservedPath = join(runsRoot, ".preserved-run-quarantine-swap");
    let swappedPath: string | null = null;
    filesystemHooks.beforeLstat = async directory => {
      if (!directory.startsWith(join(runsRoot, ".prune-run-quarantine-swap-"))) return;
      filesystemHooks.beforeLstat = undefined;
      await rename(directory, preservedPath);
      await mkdir(directory);
      await writeFile(join(directory, "replacement.txt"), "do not delete\n");
      swappedPath = directory;
    };

    const pruned = await store.prune({
      maxAgeMs: 1_000,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(swappedPath).not.toBeNull();
    expect(pruned.removed).not.toContain("run-quarantine-swap");
    expect(pruned.retained.some(entry => entry.runId === "run-quarantine-swap")).toBe(true);
    await expect(readFile(join(swappedPath!, "replacement.txt"), "utf8")).resolves.toBe(
      "do not delete\n",
    );
    await expect(stat(preservedPath)).resolves.toBeDefined();
  });

  it("does not journal cleanup complete or retain a run after backup deletion fails", async () => {
    if (process.platform === "win32") return;
    const repoRoot = await mkdtemp(join(tmpdir(), "claude-architect-backup-failure-repo-"));
    temporaryPaths.push(repoRoot);
    await git(repoRoot, ["init", "-q"]);
    await git(repoRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const candidateCommitOid = await git(repoRoot, ["rev-parse", "HEAD"]);
    const runId = "run-backup-failure";
    const anchorRef = `refs/claude-architect/candidates/${runId}`;
    const backupRef = `refs/claude-architect/prune-backups/${runId}`;
    await git(repoRoot, ["update-ref", anchorRef, candidateCommitOid]);
    // Runtime git() disables repository hooks (core.hooksPath=/dev/null), so a
    // reference-transaction hook can no longer inject the deletion failure.
    // Shim git on PATH to fail only the prune-backup deletion, passing every
    // other invocation (including hardening discovery) through to real git.
    const realGit = (await promisify(execFile)("/usr/bin/env", ["which", "git"]))
      .stdout.trim().split("\n")[0]!;
    const shimDir = join(repoRoot, "shim-bin");
    await mkdir(shimDir);
    await writeFile(join(shimDir, "git"), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    refs/claude-architect/prune-backups/*)
      for prev in "$@"; do
        [ "$prev" = "-d" ] && { echo "backup deletion blocked" >&2; exit 1; }
      done
      ;;
  esac
done
exec ${JSON.stringify(realGit)} "$@"
`);
    await chmod(join(shimDir, "git"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${previousPath ?? ""}`;

    const store = new ArtifactStore(runId);
    const result = sampleResult(runId);
    result.failure = "verification-failure";
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
      runId,
      repoRoot,
      emptyCandidateManifestHash,
      candidateCommitOid,
    )));
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(store.runDirectory, oldTime, oldTime);

    let pruned;
    try {
      pruned = await store.prune({
        maxAgeMs: 1_000,
        maxBytes: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(pruned.removed).toContain(runId);
    expect(pruned.retained.some(entry => entry.runId === runId)).toBe(false);
    expect(await git(repoRoot, ["rev-parse", backupRef])).toBe(candidateCommitOid);
    const records = (await readFile(join(
      process.env.CLAUDE_PLUGIN_DATA!,
      "runs",
      "cleanup.ndjson",
    ), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { event: string });
    expect(records.map(record => record.event)).toEqual(["prune-cleanup-intent"]);
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

  it.each([
    ["repository instruction path", (args: BuildRunManifestArgs) => {
      args.repositoryInstructions[0]!.path = "identity-secret";
    }],
    ["producer id", (args: BuildRunManifestArgs) => { args.producer.id = "identity-secret"; }],
    ["producer version", (args: BuildRunManifestArgs) => {
      args.producer.version = "identity-secret";
    }],
    ["producer model", (args: BuildRunManifestArgs) => {
      args.producer.model = "identity-secret";
    }],
    ["environment name", (args: BuildRunManifestArgs) => {
      args.environment[0]!.name = "identity-secret";
    }],
    ["environment source", (args: BuildRunManifestArgs) => {
      args.environment[0]!.source = "identity-secret" as never;
    }],
    ["packaged verifier version", (args: BuildRunManifestArgs) => {
      args.packagedVerifier.version = "identity-secret";
    }],
  ])("fails closed instead of redacting the manifest %s", (_label, assign) => {
    const registration = registerSecretValue("identity-secret");
    const args = manifestArgs("run-manifest-identity", "/canonical/repo");
    assign(args);

    expect(() => buildRunManifest(args)).toThrow(/safely persist/);
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
    args.effectivePolicy = { profile: "secret" };
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
    const args = manifestArgs("run-manifest-late-secret", "/canonical/repo");
    args.effectivePolicy = { profile: "policy-secret" };
    const manifest = buildRunManifest(args);
    const registration = registerSecretValue("policy-secret");
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
    expect(JSON.stringify(persisted)).not.toContain("policy-secret");
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
