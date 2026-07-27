#!/bin/sh

# Opt-in Claude Code statusline. Ambiguous or stale state intentionally renders nothing.
state_root=${CLAUDE_PLUGIN_DATA:-}
[ -n "$state_root" ] || exit 0
[ -d "$state_root/runs" ] || exit 0

node - "$state_root/runs" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const runsRoot = process.argv[2];
const now = Date.now();
const MAX_AGE_MS = 15 * 60 * 1000;

function processToken(pid) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    const line = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return line === "" ? null : `darwin:${line}`;
  } catch {
    return null;
  }
}

function liveStatus(runDirectory) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(runDirectory, "pipeline-active.json"), "utf8"));
    const status = JSON.parse(fs.readFileSync(path.join(runDirectory, "status.json"), "utf8"));
    const markerStartedAt = Date.parse(marker.startedAt);
    const statusUpdatedAt = Date.parse(status.updatedAt);
    if (!Number.isSafeInteger(marker.pid) || marker.pid <= 1) return null;
    if (!Number.isFinite(markerStartedAt) || now - markerStartedAt < 0 || now - markerStartedAt > MAX_AGE_MS) return null;
    if (!Number.isFinite(statusUpdatedAt) || now - statusUpdatedAt < 0 || now - statusUpdatedAt > MAX_AGE_MS) return null;
    if (typeof marker.processToken !== "string" || marker.processToken === "") return null;
    process.kill(marker.pid, 0); // kill -0 semantics: existence/permission check only.
    if (processToken(marker.pid) !== marker.processToken) return null; // Reject PID reuse.
    if (typeof status.phase !== "string" || status.phase === "") return null;
    if (status.mode === "sliced") {
      if (!Number.isSafeInteger(status.sliceIndex) || status.sliceIndex < 1
        || !Number.isSafeInteger(status.sliceCount) || status.sliceCount < status.sliceIndex) return null;
    }
    return status;
  } catch {
    return null;
  }
}

let entries;
try {
  entries = fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(runsRoot, entry.name));
} catch {
  process.exit(0);
}
const live = entries.map(liveStatus).filter(Boolean);
if (live.length !== 1) process.exit(0);
const status = live[0];
const parts = [status.phase];
if (status.mode === "sliced") parts.push(`slice ${status.sliceIndex}/${status.sliceCount}`);
if (typeof status.role === "string" && status.role !== "") parts.push(status.role);
process.stdout.write(`[delegation: ${parts.join(" · ")}]`);
NODE
