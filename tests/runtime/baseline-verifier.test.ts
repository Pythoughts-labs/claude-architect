import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import type { VerificationCommand } from "../../src/protocol/delegation-spec.js";
import { verifyBaseline } from "../../src/verify/baseline-verifier.js";

const temporaryPaths: string[] = [];

async function fixture(): Promise<{ repoRoot: string; headCommitOid: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), "ca-baseline-verifier-"));
  temporaryPaths.push(repoRoot);
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Test User"],
    ["config", "user.email", "test@example.invalid"],
  ]) {
    expect((await git(repoRoot, args)).exitCode).toBe(0);
  }
  await writeFile(join(repoRoot, "a.txt"), "baseline\n");
  await writeFile(join(repoRoot, ".gitignore"), "node_modules/\n.cache/\n");
  await writeFile(join(repoRoot, "package-lock.json"), "{}\n");
  expect((await git(repoRoot, ["add", "-A"])).exitCode).toBe(0);
  expect((await git(repoRoot, ["commit", "-q", "-m", "initial"])).exitCode).toBe(0);
  await mkdir(join(repoRoot, "node_modules"));
  await writeFile(join(repoRoot, "node_modules", "sentinel"), "safe\n");
  const head = await git(repoRoot, ["rev-parse", "HEAD"]);
  expect(head.exitCode).toBe(0);
  return { repoRoot, headCommitOid: head.stdout.trim() };
}

function command(exitCode: number): VerificationCommand {
  return {
    id: `exit-${exitCode}`,
    executable: process.execPath,
    args: ["-e", `process.exit(${exitCode})`],
    cwd: ".",
    timeoutMs: 5_000,
    network: "denied",
    expectedExitCodes: [0],
  };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

describe("verifyBaseline", () => {
  it("derives its managed worktree name from the run id", async () => {
    const repo = await fixture();
    const markerDirectory = await mkdtemp(join(tmpdir(), "ca-baseline-marker-"));
    temporaryPaths.push(markerDirectory);
    const marker = join(markerDirectory, "worktree-path.txt");

    await verifyBaseline({
      ...repo,
      runId: "run-baseline-name",
      commands: [{
        ...command(0),
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd())`,
        ],
      }],
    });

    expect(await readFile(marker, "utf8")).toMatch(/baseline-run-baseline-name$/);
  });

  it("passes a green command against clean HEAD", async () => {
    const repo = await fixture();
    await expect(verifyBaseline({ ...repo, commands: [command(0)] })).resolves.toEqual({
      baselineCommitOid: repo.headCommitOid,
      commands: [{ id: "exit-0", exitCode: 0, ok: true }],
      dependencyLink: expect.stringMatching(/^(?:inherited|skipped-cow-unsupported)$/),
    });
  });

  it("marks a failing command as not ok", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({ ...repo, commands: [command(1)] });
    expect(report.commands).toEqual([{ id: "exit-1", exitCode: 1, ok: false }]);
  });

  it("tolerates only commands individually marked as expected baseline failures", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      commands: [
        { ...command(1), id: "expected", expectBaselineFailure: true },
        { ...command(1), id: "unexpected" },
      ],
    });
    expect(report.commands).toEqual([
      { id: "expected", exitCode: 1, ok: true },
      { id: "unexpected", exitCode: 1, ok: false },
    ]);
  });

  it("does not run commands when already cancelled", async () => {
    const repo = await fixture();
    const marker = join(repo.repoRoot, "must-not-run.txt");
    const controller = new AbortController();
    controller.abort();

    await expect(verifyBaseline({
      ...repo,
      commands: [command(0), {
        ...command(0),
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      }],
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a successful command that mutates a tracked file as not ok", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      commands: [{
        ...command(0),
        id: "formatter",
        args: ["-e", "require('node:fs').writeFileSync('a.txt', 'formatted\\n')"],
      }],
    });

    expect(report.commands).toEqual([{
      id: "formatter",
      exitCode: 0,
      ok: false,
      mutation: { records: [expect.stringContaining("a.txt")], headChanged: false },
    }]);
  });

  it("keeps a command that only writes git-ignored paths ok in preflight", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      commands: [{
        ...command(0),
        id: "cache-writer",
        args: [
          "-e",
          "require('node:fs').mkdirSync('.cache', { recursive: true }); require('node:fs').writeFileSync('.cache/build.log', 'noise\\n')",
        ],
      }],
    });

    expect(report.commands).toEqual([{ id: "cache-writer", exitCode: 0, ok: true }]);
  });

  it("cancels a running command and does not run remaining commands", async () => {
    const repo = await fixture();
    const marker = join(repo.repoRoot, "remaining-command.txt");
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 50);
    try {
      await expect(verifyBaseline({
        ...repo,
        commands: [
          { ...command(0), id: "long", args: ["-e", "setTimeout(() => {}, 60000)"] },
          { ...command(0), id: "remaining", args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] },
        ],
        abortSignal: controller.signal,
      })).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(cancellation);
    }
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archives each command's output so a baseline failure can be diagnosed", async () => {
    // A baseline failure with nothing retained forces a full rerun to find out
    // which command failed and why — that cost a real run.
    const repo = await fixture();
    const written: { name: string; text: string }[] = [];
    const result = await verifyBaseline({
      ...repo,
      commands: [{
        id: "prints",
        executable: process.execPath,
        args: ["-e", "console.log('baseline says hello'); process.exit(3)"],
        cwd: ".",
        timeoutMs: 60_000,
        network: "denied",
        expectedExitCodes: [0],
      }],
      store: {
        async writeLog(name: string, text: string) {
          written.push({ name, text });
          return `logs/${name}.log`;
        },
      },
    });

    expect(result.commands[0]?.ok).toBe(false);
    expect(result.commands[0]?.stdoutRef).toMatch(/^logs\/.*stdout\.log$/u);
    expect(result.commands[0]?.stderrRef).toMatch(/^logs\/.*stderr\.log$/u);
    expect(written.find(log => log.name.endsWith("stdout"))?.text)
      .toContain("baseline says hello");
  }, 60_000);
});
