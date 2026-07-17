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

const claudeLaneFiles = agents.slice(0, 4).map(([, , file]) => file);
const codexLaneFiles = [
  "agents/codex-implementer.md",
  ".opencode/agents/codex-implementer.md",
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

function shellFenceCommands(markdown) {
  const commands = [];
  let command = "";

  for (const line of shellFenceLines(markdown)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    command += `${command ? " " : ""}${trimmed.replace(/\\\s*$/, "")}`;
    if (!/\\\s*$/.test(trimmed)) {
      commands.push(command);
      command = "";
    }
  }

  if (command) commands.push(command);
  return commands;
}

for (const [host, lane, file, adapter] of agents) {
  const source = read(file);
  const context = `${host} ${file}`;
  const executableLines = shellFenceLines(source)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const executableCommands = shellFenceCommands(source);

  for (const field of ["objective", "files", "interfaces", "constraints", "verification"]) {
    requirePattern(source, new RegExp(`\\b${field}\\b`, "i"), `${context}: missing ${field} spec field`);
  }

  requirePattern(
    source,
    /never[^.\n]{0,100}\b(?:implement|substitut)|do not (?:write|implement)/i,
    `${context}: missing prohibition on self-implementation fallback`,
  );
  requirePattern(source, /WORK=\$\(mktemp -d(?:\s[^)]*)?\)/, `${context}: SPEC and FINAL must live in a private mktemp -d WORK directory, not a shared temp namespace`);
  requirePattern(source, /SPEC="\$WORK\/[^"]+"/, `${context}: SPEC must live inside the private WORK directory`);
  requirePattern(source, /FINAL="\$WORK\/[^"]+"/, `${context}: FINAL must live inside the private WORK directory`);
  requirePattern(source, /trap\s+'rm -rf "\$WORK"'\s+EXIT/, `${context}: missing private WORK directory cleanup`);
  requirePattern(
    source,
    /never recover a lost temp path by globbing/i,
    `${context}: missing prohibition on re-globbing the shared temp dir to recover a lost spec path`,
  );
  if (host === "OpenCode") {
    requirePattern(
      executableLines.join("\n"),
      new RegExp(`\\blocal\\s+adapter=${adapter}\\.sh\\b`),
      `${context}: runtime resolver must select ${adapter}.sh`,
    );

    const runtimeInvocation = executableCommands.find((command) =>
      /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*"\$RUNTIME"\s+/.test(command),
    );
    assert.ok(runtimeInvocation, `${context}: missing executable "$RUNTIME" invocation`);

    if (lane === "codex") {
      requirePattern(
        runtimeInvocation,
        /--output-last-message\s+"\$FINAL"\s+-\s+<\s+"\$SPEC"/,
        `${context}: "$RUNTIME" must read "$SPEC" from stdin and write final output to "$FINAL"`,
      );
    } else {
      requirePattern(
        runtimeInvocation,
        /"\$RUNTIME"\s+"\$SPEC"\s+"\$FINAL"(?:\s|$)/,
        `${context}: "$RUNTIME" must receive "$SPEC" and "$FINAL"`,
      );
    }
  } else {
    requirePattern(
      executableCommands.join("\n"),
      new RegExp(`\\b${adapter}\\.sh\\b`),
      `${context}: missing executable ${adapter}.sh delegation`,
    );
  }
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

for (const file of claudeLaneFiles) {
  const source = read(file);
  const context = `Claude ${file}`;

  requirePattern(source, /### Foreground execution and turn completion — hard constraint/, `${context}: missing foreground lifecycle section`);
  requirePattern(source, /one foreground blocking Bash call with timeout 600000ms/i, `${context}: missing mandatory Bash timeout`);
  requirePattern(source, /single Bash tool call/i, `${context}: missing single-Bash-tool-call atomicity rule for spec/runtime/producer steps`);
  requirePattern(source, /Do not use `run_in_background`[^\n]*`nohup`[^\n]*Monitor[^\n]*"wait for notification"/i, `${context}: missing Monitor/background prohibition`);
  requirePattern(source, /exactly two valid turn endings:[^\n]*full report after independent verification[^\n]*concrete blocker report/i, `${context}: missing two-valid-endings contract`);
  requirePattern(source, /stall detection[^\n]*Every cycle must check progress by output-file growth or process CPU-time delta[^\n]*10 consecutive minutes/i, `${context}: missing PID-rejoin stall detection`);
  requirePattern(source, /10 consecutive minutes, kill the process, then either relaunch fresh once or return a concrete blocker report/i, `${context}: missing stalled-PID kill and bounded relaunch outcome`);
  requirePattern(source, /### Worktree isolation and git-state discipline — hard constraint/, `${context}: missing worktree isolation and git-state discipline section`);
  requirePattern(source, /git worktree add --detach/, `${context}: missing detached worktree procedure`);
  requirePattern(source, /NEVER run tree-wide git state mutations[^\n]*`git stash`[^\n]*`git reset --hard`[^\n]*`git clean`/i, `${context}: missing shared-checkout git-state prohibition`);
  requirePattern(source, /git worktree remove --force/, `${context}: missing disposable-worktree cleanup procedure`);
  requirePattern(source, /Always run the producer inside a dedicated git worktree — never directly in a shared or pre-existing checkout, whether or not the dispatch is concurrent/, `${context}: worktree isolation must be unconditional`);
  requirePattern(source, /must also be appended verbatim to the producer's own prompt\/spec file/, `${context}: missing producer-prompt propagation of git-state prohibitions`);
}

for (const file of codexLaneFiles) {
  const source = read(file);
  const context = `Codex ${file}`;

  requirePattern(
    source,
    /FAILURE CLASSIFICATION: sandbox-attributable \| real \| mixed \| unresolved \| not-applicable/,
    `${context}: missing failure classification field`,
  );
  requirePattern(
    source,
    /outside codex(?:'|’|&#39;)s workspace-write sandbox/i,
    `${context}: missing outside-sandbox rerun rule`,
  );
  requirePattern(
    source,
    /If typed files are in scope, complete all linting and formatting before a final type-check over ALL touched typed files, including new or modified tests; the final type-check must run after the final format pass\./,
    `${context}: missing lint-before-final-typecheck rule`,
  );
  requirePattern(source, /CHANGES: \[file — one-line summary, per file, from the actual diff\]/, `${context}: report template must keep per-file CHANGES`);
}

requirePattern(
  read(".opencode/agents/codex-implementer.md"),
  /MODEL: \[exact model that ran\][^`]*REASONING: \[reasoning effort that ran\]/,
  "OpenCode codex lane: report template must keep exact model and reasoning",
);

assert.equal(
  fs.existsSync(`${root}/.opencode/agents/opencode-implementer.md`),
  false,
  "OpenCode must not recursively expose an opencode implementation lane",
);

console.log("PASS: implementation lane contracts are guarded across both hosts.");
