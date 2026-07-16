// This dependency-free entrypoint must remain parseable by Node.js 20 so it can supervise producer
// processes independently of the bundled runtime. It kills the producer process group when the MCP
// server that launched it is no longer alive.
import { spawn } from "node:child_process";

const POLL_INTERVAL_MS = 5_000;
const TERMINATION_GRACE_MS = 5_000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const [supervisorArg, separator, command, ...args] = process.argv.slice(2);

if (separator !== "--" || command === undefined) {
  process.stderr.write("usage: watchdog.mjs <supervisorPid> -- <cmd> [args...]\n");
  process.exit(64);
}

const supervisorPid = Number(supervisorArg);
// POSIX: detach so the child leads its own process group and a negative-PID
// signal reaches the whole tree. Windows has no POSIX process groups or
// signals, so spawn attached and terminate the child directly (Windows
// process-tree teardown is handled separately by the Job Object helper).
const isWindows = process.platform === "win32";
const child = spawn(command, args, { detached: !isWindows, stdio: "inherit" });
let supervisorGone = false;
let terminationTimer = null;

function killChildGroup(signal) {
  try {
    if (isWindows) process.kill(child.pid, signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The child process group has already exited.
  }
}

const signalHandlers = new Map(FORWARDED_SIGNALS.map(signal => [
  signal,
  () => killChildGroup(signal),
]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

const poll = setInterval(() => {
  if (supervisorGone) return;
  try {
    process.kill(supervisorPid, 0);
  } catch {
    supervisorGone = true;
    killChildGroup("SIGTERM");
    terminationTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killChildGroup("SIGKILL");
    }, TERMINATION_GRACE_MS);
  }
}, POLL_INTERVAL_MS);

function cleanup() {
  clearInterval(poll);
  if (terminationTimer !== null) clearTimeout(terminationTimer);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}

child.once("error", () => {
  cleanup();
  process.exit(1);
});

child.once("exit", (code, signal) => {
  cleanup();
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
