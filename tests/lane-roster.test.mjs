import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function markdownRoster(relativeDirectory) {
  return fs
    .readdirSync(`${root}/${relativeDirectory}`, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

assert.deepEqual(markdownRoster("agents"), [
  "claude-advisor.md",
  "codex-implementer.md",
  "opencode-implementer.md",
  "pi-implementer.md",
  "pythinker-implementer.md",
], "Claude host Markdown roster must match exactly");

assert.deepEqual(markdownRoster(".opencode/agents"), [
  "claude-advisor.md",
  "codex-implementer.md",
  "pi-implementer.md",
  "pythinker-implementer.md",
], "OpenCode host Markdown roster must match exactly");

console.log("PASS: host agent rosters match exactly.");
