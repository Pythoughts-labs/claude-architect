import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCandidate } from "../../src/git/candidate-tree.js";
import { git } from "../../src/git/git-exec.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import type { CandidateArtifact } from "../../src/protocol/attempt-result.js";
import type { VerificationCommand } from "../../src/protocol/delegation-spec.js";
import { clearRegisteredSecrets, redact } from "../../src/runtime/redaction.js";
import { projectVerify } from "../../src/verify/project-verifier.js";

interface Fixture {
  repoRoot: string;
  artifact: CandidateArtifact;
}

const temporaryPaths: string[] = [];
let previousPluginData: string | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function frozenFixture(): Promise<Fixture> {
  const root = await temporaryDirectory("ca-project-verifier-");
  const repoRoot = join(root, "repo");
  const producerWorktree = join(root, "producer-worktree");
  await mkdir(repoRoot);
  await runGit(repoRoot, ["init", "-q"]);
  await writeFile(join(repoRoot, "a.txt"), "hello\n");
  await writeFile(join(repoRoot, ".gitignore"), "ignored-output/\n");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["commit", "-q", "-m", "initial"]);
  const baseCommitOid = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  await runGit(repoRoot, [
    "worktree",
    "add",
    "--detach",
    "-q",
    producerWorktree,
    baseCommitOid,
  ]);
  await writeFile(join(producerWorktree, "a.txt"), "candidate\n");
  const frozen = await freezeCandidate({
    repoRoot,
    worktreePath: producerWorktree,
    baseCommitOid,
    runId: "project-verifier",
    writeAllowlist: ["a.txt"],
    forbiddenScope: [],
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(`freeze failed: ${frozen.reason}`);
  return { repoRoot, artifact: frozen.artifact };
}

function command(overrides: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    id: "pass",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: ".",
    timeoutMs: 5_000,
    network: "denied",
    expectedExitCodes: [0],
    ...overrides,
  };
}

beforeEach(async () => {
  clearRegisteredSecrets();
  previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = await temporaryDirectory("ca-project-verifier-state-");
});

afterEach(async () => {
  clearRegisteredSecrets();
  if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("projectVerify", () => {
  it("records a passing Host-authorized command without mutation", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command()],
    });

    expect(result.mutated).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.commandOutcomes).toHaveLength(1);
    expect(result.commandOutcomes[0]).toMatchObject({
      id: "pass",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      exitCode: 0,
      timedOut: false,
    });
    expect(result.evidence.commands).toEqual([
      expect.objectContaining({
        id: "pass",
        confinement: "none",
        networkPolicy: "unenforced",
        requestedNetwork: "denied",
        skipped: false,
      }),
    ]);
    expect(result.commandOutcomes[0]).toMatchObject({
      stdoutRef: "logs/verification-0-stdout.log",
      stderrRef: "logs/verification-0-stderr.log",
    });
    expect(await runGit(fixture.repoRoot, ["worktree", "list", "--porcelain"]))
      .not.toContain(process.env.CLAUDE_PLUGIN_DATA);
  });

  it("detects a verification command that mutates the materialized candidate", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "mutate",
        args: [
          "-e",
          "require('node:fs').writeFileSync('generated.txt', 'changed\\n')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("does not run later commands after verification mutates the candidate", async () => {
    const fixture = await frozenFixture();
    const marker = join(await temporaryDirectory("ca-project-verifier-marker-"), "marker.txt");

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [
        command({
          id: "mutate-first",
          args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'changed')"],
        }),
        command({
          id: "must-not-run",
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
        }),
      ],
    });

    expect(result.mutated).toBe(true);
    expect(result.commandOutcomes.map(outcome => outcome.id)).toEqual(["mutate-first"]);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects writes to ignored paths in the disposable materialization", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "ignored-mutation",
        args: [
          "-e",
          "require('node:fs').mkdirSync('ignored-output', { recursive: true }); require('node:fs').writeFileSync('ignored-output/result.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("permits ignored-path writes when the command opts into ignored-paths mutations", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "dependency-install",
        allowedMutations: "ignored-paths",
        args: [
          "-e",
          "require('node:fs').mkdirSync('ignored-output', { recursive: true }); require('node:fs').writeFileSync('ignored-output/result.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it("still detects tracked and untracked mutations when ignored-paths are permitted", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "untracked-mutation",
        allowedMutations: "ignored-paths",
        args: [
          "-e",
          "require('node:fs').writeFileSync('stray-untracked.txt', 'changed')",
        ],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("detects a clean status after the verification command changes HEAD", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "move-head",
        executable: "git",
        args: ["reset", "--hard", fixture.artifact.baseCommitOid],
      })],
    });

    expect(result.mutated).toBe(true);
    expect(result.failures).toContain("verification-mutated");
  });

  it("records an unexpected exit code as a verification failure", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "fail", args: ["-e", "process.exit(1)"] })],
    });

    expect(result.commandOutcomes[0]?.exitCode).toBe(1);
    expect(result.failures).toContain("command-failed:fail");
  });

  it("records an unavailable verification executable as a failed outcome", async () => {
    const fixture = await frozenFixture();
    const missing = join(tmpdir(), "claude-architect-missing-verifier");

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "missing", executable: missing })],
    });

    expect(result.commandOutcomes[0]).toMatchObject({
      id: "missing",
      executable: missing,
      exitCode: null,
    });
    expect(result.failures).toContain("command-failed:missing");
    expect(result.outputLogs[1]?.text).toContain("executable is not accessible");
  });

  it("bounds a thrown executable-resolution diagnostic before returning it as a log", async () => {
    const fixture = await frozenFixture();
    const ps = Object.create(getPlatformServices()) as PlatformServices;
    ps.resolveExecutable = async () => {
      throw new Error("x".repeat(1_100_000));
    };

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "huge-error", executable: "missing" })],
      ps,
    });

    expect(Buffer.byteLength(result.outputLogs[1]?.text ?? "")).toBeLessThanOrEqual(1_000_000);
    expect(result.evidence.commands[0]?.truncated?.stderr).toBe(true);
  });

  it("fails a timed-out command even when its SIGTERM handler exits zero", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "timeout",
        args: [
          "-e",
          "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
        ],
        timeoutMs: 100,
      })],
    });

    expect(result.commandOutcomes[0]).toMatchObject({ exitCode: 0, timedOut: true });
    expect(result.failures).toContain("command-failed:timeout");
  });

  it("rejects a command working directory outside the materialized candidate", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({ id: "escape", cwd: ".." })],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toContain("invalid-command-cwd:escape");
  });

  it("rejects a candidate commit that does not materialize the verified tree", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: {
        ...fixture.artifact,
        candidateCommitOid: fixture.artifact.baseCommitOid,
      },
      commands: [command()],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toEqual(["candidate-materialization-mismatch"]);
  });

  it("skips commands excluded by Host OS or architecture filters", async () => {
    const fixture = await frozenFixture();

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "other-platform",
        platform: { arch: ["not-this-architecture"] },
      })],
    });

    expect(result.commandOutcomes).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.evidence.commands).toEqual([
      expect.objectContaining({
        id: "other-platform",
        skipped: true,
        skipReason: "platform-arch",
      }),
    ]);
  });

  it("redacts command-environment secrets before disposing their registration", async () => {
    const fixture = await frozenFixture();
    const secret = "verification-enterprise-secret";

    const result = await projectVerify({
      repoRoot: fixture.repoRoot,
      artifact: fixture.artifact,
      commands: [command({
        id: "secret-output",
        args: ["-e", "process.stdout.write(process.env.VERIFY_API_TOKEN ?? '')"],
        environment: { VERIFY_API_TOKEN: secret },
      })],
    });

    expect(result.outputLogs[0]?.text).toBe("[s]");
    expect(result.outputLogs.some(log => log.text.includes(secret))).toBe(false);
    expect(redact(secret)).toBe(secret);
  });
});
