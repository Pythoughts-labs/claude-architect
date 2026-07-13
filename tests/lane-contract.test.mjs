import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const agents = [
  ["Claude", "codex", "agents/codex-implementer.md", "run-codex-isolated"],
  ["Claude", "opencode", "agents/opencode-implementer.md", "run-opencode-isolated"],
  ["Claude", "pi", "agents/pi-implementer.md", "run-pi-isolated"],
  ["Claude", "pythinker", "agents/pythinker-implementer.md", "run-pythinker-isolated"],
  ["OpenCode", "codex", ".opencode/agents/codex-implementer.md", "run-codex-isolated"],
  ["OpenCode", "pi", ".opencode/agents/pi-implementer.md", "run-pi-isolated"],
  ["OpenCode", "pythinker", ".opencode/agents/pythinker-implementer.md", "run-pythinker-isolated"],
];

function read(relativePath) {
  return fs.readFileSync(`${root}/${relativePath}`, "utf8");
}

function requirePattern(source, pattern, context) {
  assert.match(source, pattern, context);
}

function shellFenceLines(markdown) {
  const lines = [];
  const fence = /^\s*```(?:bash|sh|shell)\s*$/i;
  let inShellFence = false;

  for (const line of markdown.split("\n")) {
    if (!inShellFence && fence.test(line)) {
      inShellFence = true;
    } else if (inShellFence && /^\s*```\s*$/.test(line)) {
      inShellFence = false;
    } else if (inShellFence) {
      lines.push(line);
    }
  }
  return lines;
}

for (const [host, lane, file, adapter] of agents) {
  const source = read(file);
  const context = `${host} ${file}`;
  const executableLines = shellFenceLines(source)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const field of ["objective", "files", "interfaces", "constraints", "verification"]) {
    requirePattern(source, new RegExp(`\\b${field}\\b`, "i"), `${context}: missing ${field} spec field`);
  }

  requirePattern(
    source,
    /never[^.\n]{0,100}\b(?:implement|substitut)|do not (?:write|implement)/i,
    `${context}: missing prohibition on self-implementation fallback`,
  );
  requirePattern(source, /SPEC=\$\(mktemp(?:\s[^)]*)?\)/, `${context}: SPEC must use mktemp`);
  requirePattern(source, /FINAL=\$\(mktemp(?:\s[^)]*)?\)/, `${context}: FINAL must use mktemp`);
  requirePattern(
    source,
    /(?:trap\s+'rm -f "\$SPEC" "\$FINAL"'\s+EXIT|remove `SPEC` and `FINAL`)/,
    `${context}: missing SPEC and FINAL cleanup`,
  );
  requirePattern(executableLines.join("\n"), new RegExp(`\\b${adapter}\\.sh\\b`), `${context}: missing executable ${adapter}.sh delegation`);
  requirePattern(source, /git status(?: --short)?/i, `${context}: missing actual git status inspection`);
  requirePattern(source, /git diff/i, `${context}: missing actual git diff inspection`);
  requirePattern(
    source,
    /independent(?:ly)? (?:re-?run|rerun)|run the spec's verification command yourself/i,
    `${context}: missing independent verification rerun`,
  );
  requirePattern(
    source,
    /(?:producer|codex|opencode|pi|pythinker)(?:'s)? (?:claim|self-report).*not evidence/i,
    `${context}: producer self-report must not count as evidence`,
  );
  requirePattern(
    source,
    /STATUS:\s*complete\s*\|?\s*partial\s*\|?\s*timeout\s*\|?\s*unavailable/i,
    `${context}: missing complete, partial, timeout, unavailable status vocabulary`,
  );

  for (const line of executableLines) {
    assert.doesNotMatch(
      line,
      /^(?:(?:env\s+)?[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:codex\s+exec|pi\s+-p(?:\s|$)|pythinker\s+--quiet(?:\s|$)|opencode\s+run(?:\s|$))/,
      `${context}: direct CLI launch bypasses ${adapter}.sh: ${line}`,
    );
    assert.doesNotMatch(
      line,
      /^(?:(?:export|local)\s+)?CAP=/,
      `${context}: inline CAP= timeout construction is forbidden: ${line}`,
    );
  }
}

assert.equal(
  fs.existsSync(`${root}/.opencode/agents/opencode-implementer.md`),
  false,
  "OpenCode must not recursively expose an opencode implementation lane",
);

console.log("PASS: implementation lane contracts are guarded across both hosts.");
