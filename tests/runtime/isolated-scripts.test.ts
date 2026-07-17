import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runIsolated = path.join(root, "scripts", "run-isolated.sh");
const runCodexIsolated = path.join(root, "scripts", "run-codex-isolated.sh");
const temporaryPaths: string[] = [];

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise(resolve => {
    execFile("/bin/bash", [script, ...args], { env }, (error, stdout, stderr) => {
      const exitCode = error !== null && "code" in error && typeof error.code === "number"
        ? error.code
        : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}

async function makeBin(): Promise<{ root: string; bin: string }> {
  const testRoot = await mkdtemp(path.join(tmpdir(), "ca-isolated-scripts-"));
  temporaryPaths.push(testRoot);
  const bin = path.join(testRoot, "bin");
  await mkdir(bin);
  await symlink("/usr/bin/perl", path.join(bin, "perl"));
  await symlink("/bin/sleep", path.join(bin, "sleep"));
  return { root: testRoot, bin };
}

async function findTimeout(): Promise<string | undefined> {
  for (const candidate of [
    "/opt/homebrew/bin/gtimeout",
    "/usr/local/bin/gtimeout",
    "/usr/bin/timeout",
    "/bin/timeout",
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation location.
    }
  }
  return undefined;
}

async function waitUntilDead(pid: number): Promise<boolean> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 25));
    } catch {
      return true;
    }
  }
  return false;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(candidate =>
    rm(candidate, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("isolated lane scripts", () => {
  it("kills a TERM-ignoring process tree after the timeout grace period", async ctx => {
    const timeout = await findTimeout();
    if (timeout === undefined) {
      ctx.skip();
      return;
    }
    const fixture = await makeBin();
    await symlink(timeout, path.join(fixture.bin, "timeout"));
    const pidFile = path.join(fixture.root, "child.pid");
    const delegate = path.join(fixture.bin, "ignore-term");
    await writeFile(delegate, `#!/bin/bash
trap '' TERM
(trap '' TERM; while :; do /bin/sleep 1; done) &
printf '%s\\n' "$!" > "$CHILD_PID_FILE"
wait
`);
    await chmod(delegate, 0o755);

    const result = await run(runIsolated, ["ignore-term"], {
      PATH: fixture.bin,
      RUN_TIMEOUT_SECONDS: "1",
      CHILD_PID_FILE: pidFile,
    });

    expect(result.exitCode).toBe(124);
    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(await waitUntilDead(childPid)).toBe(true);
  }, 8_000);

  it("maps a delegated SIGKILL exit to the timeout result", async () => {
    const fixture = await makeBin();
    const delegate = path.join(fixture.bin, "sigkill-self");
    await writeFile(delegate, "#!/bin/bash\nkill -KILL $$\n");
    await chmod(delegate, 0o755);

    const result = await run(runIsolated, ["sigkill-self"], {
      PATH: fixture.bin,
      RUN_TIMEOUT_SECONDS: "0",
    });

    expect(result.exitCode).toBe(124);
  });

  it.each([
    { unsafeArgs: ["--sandbox", "danger-full-access"] },
    { unsafeArgs: ["--sandbox=danger-full-access"] },
    { unsafeArgs: ["-sdanger-full-access"] },
    { unsafeArgs: ["--add-dir=/tmp"] },
    { unsafeArgs: ["--disable-sandbox"] },
    { unsafeArgs: ["-C/tmp"] },
    { unsafeArgs: ["-a=never"] },
    { unsafeArgs: ["--dangerously-bypass-approvals-and-sandbox"] },
    { unsafeArgs: ["--full-auto"] },
    { unsafeArgs: ["--yolo"] },
    { unsafeArgs: ["--enable=multi_agent"] },
    { unsafeArgs: ["-c", " sandbox_policy = 'danger-full-access'"] },
    { unsafeArgs: ["-cfeatures.multi_agent=true"] },
    { unsafeArgs: ["--config=\"ask_for_approval\"=never"] },
  ])("rejects unsafe Codex arguments without executing Codex: $unsafeArgs", async ({ unsafeArgs }) => {
    const fixture = await makeBin();
    const marker = path.join(fixture.root, "codex-started");
    const codex = path.join(fixture.bin, "codex");
    await writeFile(codex, `#!/bin/bash\nprintf started > "${marker}"\n`);
    await chmod(codex, 0o755);

    const result = await run(runCodexIsolated, unsafeArgs, {
      PATH: fixture.bin,
      CODEX_TIMEOUT_SECONDS: "0",
    });

    expect(result.exitCode).toBe(65);
    await expect(access(marker)).rejects.toBeDefined();
    expect(result.stderr).toContain("unsafe Codex");
  });

  it("forwards safe Codex arguments unchanged", async () => {
    const fixture = await makeBin();
    const argsFile = path.join(fixture.root, "args");
    const promptFile = path.join(fixture.root, "prompt.txt");
    await writeFile(promptFile, "safe prompt\n");
    const codex = path.join(fixture.bin, "codex");
    await writeFile(codex, `#!/bin/bash\nprintf '%s\\0' "$@" > "${argsFile}"\n`);
    await chmod(codex, 0o755);

    const safeArgs = ["--model", "gpt-5", "-c", "model_reasoning_effort=high", promptFile];
    const result = await run(runCodexIsolated, safeArgs, {
      PATH: fixture.bin,
      CODEX_TIMEOUT_SECONDS: "0",
    });

    expect(result.exitCode).toBe(0);
    const forwarded = (await readFile(argsFile, "utf8")).split("\0").filter(Boolean);
    expect(forwarded).toEqual([
      "exec", "--ignore-user-config", "--ephemeral", ...safeArgs,
      "--disable", "multi_agent",
      "-c", "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
    ]);
  });
});
