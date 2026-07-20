import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/git-exec.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
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
  await writeFile(join(repoRoot, "package.json"), JSON.stringify({
    scripts: {
      test: "npm run unit",
      unit: "vitest run",
      "echo-vitest": "echo vitest",
      cycle: "npm run cycle",
    },
  }));
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

function platformWithCommandOutput(
  source: string,
  executableNames: string[],
): PlatformServices {
  const ps = Object.create(getPlatformServices()) as PlatformServices;
  const resolveExecutable = ps.resolveExecutable.bind(ps);
  ps.resolveExecutable = async request => executableNames.includes(request.name)
    ? {
        kind: "native",
        command: process.execPath,
        prefixArgs: ["-e", source],
        resolvedFrom: "test-output-fixture",
      }
    : resolveExecutable(request);
  return ps;
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

  it("fails closed with a distinct classification when vitest collects no test files", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write(process.argv.slice(1).join(' '))",
        ["vitest"],
      ),
      commands: [
        {
          ...command(0),
          id: "vitest",
          executable: "vitest",
          args: ["No test files found, exiting with code 0"],
        },
        {
          ...command(0),
          id: "vitest-json",
          executable: "vitest",
          args: [JSON.stringify({ numTotalTestSuites: 0, testResults: [] })],
        },
      ],
    });

    expect(report.commands).toEqual([
      {
        id: "vitest",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
      {
        id: "vitest-json",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
    ]);
  });

  it("tolerates no tests only for an expected baseline failure", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('No test files found, exiting with code 0')",
        ["vitest"],
      ),
      commands: [
        {
          ...command(0),
          id: "expected-empty",
          executable: "vitest",
          args: [],
          expectBaselineFailure: true,
        },
        { ...command(0), id: "unexpected-empty", executable: "vitest", args: [] },
      ],
    });

    expect(report.commands).toEqual([
      {
        id: "expected-empty",
        exitCode: 0,
        ok: true,
        classification: "no-tests-collected",
      },
      {
        id: "unexpected-empty",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
    ]);
  });

  it("does not classify a collecting vitest run or non-vitest output as empty", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write(process.argv.slice(1).join(' '))",
        ["vitest"],
      ),
      commands: [
        {
          ...command(0),
          id: "collecting-vitest",
          executable: "vitest",
          args: ["Test Files 1 passed (1)"],
        },
        {
          ...command(0),
          id: "not-vitest",
          args: ["-e", "process.stdout.write('No test files found, exiting with code 0')"],
        },
      ],
    });

    expect(report.commands).toEqual([
      { id: "collecting-vitest", exitCode: 0, ok: true },
      { id: "not-vitest", exitCode: 0, ok: true },
    ]);
  });

  it("recognizes package-manager script chains without trusting deceptive wrappers", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('No test files found, exiting with code 0')",
        ["npm", "npx", "pnpm", "yarn", "node"],
      ),
      commands: [
        { ...command(0), id: "npm-test", executable: "npm", args: ["test"] },
        { ...command(0), id: "pnpm-test", executable: "pnpm", args: ["run", "test"] },
        { ...command(0), id: "yarn-test", executable: "yarn", args: ["test"] },
        { ...command(0), id: "npx-echo", executable: "npx", args: ["echo", "vitest"] },
        {
          ...command(0),
          id: "npm-echo-script",
          executable: "npm",
          args: ["run", "echo-vitest"],
        },
        {
          ...command(0),
          id: "node-custom-vitest",
          executable: "node",
          args: ["custom/vitest.mjs"],
        },
        { ...command(0), id: "npm-cycle", executable: "npm", args: ["run", "cycle"] },
      ],
    });

    expect(report.commands).toEqual([
      {
        id: "npm-test",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
      {
        id: "pnpm-test",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
      {
        id: "yarn-test",
        exitCode: 0,
        ok: false,
        classification: "no-tests-collected",
      },
      { id: "npx-echo", exitCode: 0, ok: true },
      { id: "npm-echo-script", exitCode: 0, ok: true },
      { id: "node-custom-vitest", exitCode: 0, ok: true },
      { id: "npm-cycle", exitCode: 0, ok: true },
    ]);
  });

  it("recognizes the Vitest package entrypoint when launched through Node", async () => {
    const repo = await fixture();
    const report = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('No test files found, exiting with code 0')",
        ["node"],
      ),
      commands: [{
        ...command(0),
        id: "node-vitest-package",
        executable: "node",
        args: ["node_modules/vitest/vitest.mjs"],
      }],
    });

    expect(report.commands).toEqual([{
      id: "node-vitest-package",
      exitCode: 0,
      ok: false,
      classification: "no-tests-collected",
    }]);
  });

  it("detects split empty-suite output but lets a positive final summary win", async () => {
    const repo = await fixture();
    const emptyReport = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('No test files '); process.stderr.write('found, exiting with code 0')",
        ["vitest"],
      ),
      commands: [{ ...command(0), id: "split-empty", executable: "vitest", args: [] }],
    });
    const collectingReport = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('No test files found\\nTest Files  1 passed (1)')",
        ["vitest"],
      ),
      commands: [{ ...command(0), id: "collecting", executable: "vitest", args: [] }],
    });
    const structuredReport = await verifyBaseline({
      ...repo,
      ps: platformWithCommandOutput(
        "process.stdout.write('{\"numTotal'); process.stderr.write('TestSuites\":0}')",
        ["vitest"],
      ),
      commands: [{ ...command(0), id: "split-json", executable: "vitest", args: [] }],
    });

    expect(emptyReport.commands).toEqual([{
      id: "split-empty",
      exitCode: 0,
      ok: false,
      classification: "no-tests-collected",
    }]);
    expect(collectingReport.commands).toEqual([
      { id: "collecting", exitCode: 0, ok: true },
    ]);
    expect(structuredReport.commands).toEqual([{
      id: "split-json",
      exitCode: 0,
      ok: false,
      classification: "no-tests-collected",
    }]);
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
});
