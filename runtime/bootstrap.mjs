// This dependency-free entrypoint must remain parseable by Node.js 20 so it can locate and re-exec
// Node.js 22+. Claude Code owns MCP restart and initialize-handshake timeout behavior. Attempts are
// not resumed after a crash; startup recovery reclaims stale state. The host must still resolve the
// first `node` on PATH before this file can run.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_NODE_MAJOR = 22;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BYTES = 64 * 1024;

function isNodeSupported(version) {
  const match = /^v?(\d+)(?:\.|$)/.exec(String(version).trim());
  return match !== null && Number(match[1]) >= MINIMUM_NODE_MAJOR;
}

function missingNodeDiagnostic() {
  return "Claude Architect requires Node.js 22 or newer. Install a supported Node.js release "
    + "and ensure its node executable is available on the host PATH, then reload the plugin.";
}

function serverPath() {
  const override = process.env.CLAUDE_ARCHITECT_SERVER_PATH;
  if (override === undefined || override === "") {
    return fileURLToPath(new URL("./server.mjs", import.meta.url));
  }
  if (override.startsWith("file:")) return fileURLToPath(override);
  return path.resolve(override);
}

function nodeNames() {
  return process.platform === "win32" ? ["node.exe", "node"] : ["node"];
}

function findSupportedNode() {
  const searchPath = process.env.PATH ?? "";
  const visited = new Set();
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const name of nodeNames()) {
      const candidate = path.resolve(directory, name);
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      const probe = spawnSync(candidate, ["-p", "process.versions.node"], {
        encoding: "utf8",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: VERSION_PROBE_TIMEOUT_MS,
        maxBuffer: VERSION_PROBE_MAX_BYTES,
        windowsHide: true,
      });
      if (probe.status === 0 && isNodeSupported(probe.stdout)) return candidate;
    }
  }
  return null;
}

async function runServerWith(nodePath, entrypoint) {
  await new Promise((resolve, reject) => {
    const child = spawn(nodePath, [entrypoint], {
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    const forwarded = new Set();
    const forwardSignal = signal => {
      forwarded.add(signal);
      child.kill(signal);
    };
    const signalHandlers = new Map([
      ["SIGHUP", () => forwardSignal("SIGHUP")],
      ["SIGINT", () => forwardSignal("SIGINT")],
      ["SIGTERM", () => forwardSignal("SIGTERM")],
    ]);
    for (const [signal, handler] of signalHandlers) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    child.once("error", error => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal !== null) {
        if (forwarded.has(signal)) {
          process.kill(process.pid, signal);
          return;
        }
        reject(new Error(`server exited from signal ${signal}`));
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function main() {
  const entrypoint = serverPath();
  if (!isNodeSupported(process.versions.node)) {
    const supportedNode = findSupportedNode();
    if (supportedNode === null) {
      console.error(missingNodeDiagnostic());
      process.exitCode = 1;
      return;
    }
    await runServerWith(supportedNode, entrypoint);
    return;
  }

  const server = await import(pathToFileURL(entrypoint).href);
  if (typeof server.start !== "function") {
    throw new Error("runtime server module does not export start()");
  }
  await server.start();
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Claude Architect bootstrap failed: ${message}`);
  process.exitCode = 1;
}
