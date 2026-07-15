import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryPaths: string[] = [];
const bootstrapPath = fileURLToPath(new URL("../../runtime/bootstrap.mjs", import.meta.url));

async function fakeServer(root: string): Promise<string> {
  const serverPath = path.join(root, "fake-server.mjs");
  await writeFile(
    serverPath,
    "console.error('fake server ready'); export async function start() {}\n",
  );
  return serverPath;
}

async function nodeVersionPrelude(root: string, version: string): Promise<string> {
  const preludePath = path.join(root, `node-${version}.mjs`);
  await writeFile(
    preludePath,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`,
  );
  return preludePath;
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(entry =>
    rm(entry, { recursive: true, force: true })));
});

describe("runtime bootstrap", () => {
  it("starts the server on a supported runtime without writing protocol noise to stdout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-supported-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);

    const result = spawnSync(process.execPath, [bootstrapPath], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_ARCHITECT_SERVER_PATH: serverPath },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it.skipIf(process.platform === "win32")("re-execs a supported node found on PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-reexec-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: bin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it("uses the shipped parser to accept the Node.js 22 boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-boundary-"));
    temporaryPaths.push(root);
    const serverPath = await fakeServer(root);
    const preludePath = await nodeVersionPrelude(root, "22.0.0");
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin);

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: emptyBin,
          CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fake server ready");
  });

  it("fails on stderr when no supported node exists on PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-missing-"));
    temporaryPaths.push(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin);

    const result = spawnSync(
      process.execPath,
      ["--import", preludePath, bootstrapPath],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: emptyBin },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Node.js 22");
    expect(result.stderr).toContain("PATH");
  });

  it.skipIf(process.platform === "win32")("forwards termination to a re-executed server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ca-bootstrap-signal-"));
    temporaryPaths.push(root);
    const preludePath = await nodeVersionPrelude(root, "20.19.0");
    const bin = path.join(root, "bin");
    const serverPath = path.join(root, "signal-server.mjs");
    const pidFile = path.join(root, "server.pid");
    const terminatedFile = path.join(root, "server.terminated");
    await mkdir(bin);
    await symlink(process.execPath, path.join(bin, "node"));
    await writeFile(serverPath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.TEST_SERVER_PID_FILE, String(process.pid));",
      "process.once('SIGTERM', () => {",
      "  writeFileSync(process.env.TEST_SERVER_TERMINATED_FILE, 'terminated');",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", preludePath, bootstrapPath], {
      env: {
        ...process.env,
        PATH: bin,
        CLAUDE_ARCHITECT_SERVER_PATH: serverPath,
        TEST_SERVER_PID_FILE: pidFile,
        TEST_SERVER_TERMINATED_FILE: terminatedFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let serverPid = 0;
    try {
      serverPid = Number(await waitForFile(pidFile));
      child.kill("SIGTERM");
      await waitForFile(terminatedFile);
      expect(Number.isSafeInteger(serverPid) && serverPid > 1).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (serverPid > 1) {
        try {
          process.kill(serverPid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
        }
      }
    }
  });
});
