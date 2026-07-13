import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function read(relativePath) {
  return fs.readFileSync(`${root}/${relativePath}`, "utf8");
}

function requirePattern(source, pattern, context) {
  assert.match(source, pattern, context);
}

const harnessAgents = [
  ["Claude Pi", "agents/pi-implementer.md", "--model", "--thinking"],
  ["Claude Pythinker", "agents/pythinker-implementer.md", "--model", "--thinking-effort"],
  ["Claude OpenCode", "agents/opencode-implementer.md", "--model", "--variant"],
  ["OpenCode Pi", ".opencode/agents/pi-implementer.md", "model", "thinking"],
  ["OpenCode Pythinker", ".opencode/agents/pythinker-implementer.md", "model", "thinking-effort"],
];

for (const [hostLane, file, modelControl, reasoningControl] of harnessAgents) {
  const source = read(file);
  requirePattern(source, /(?:override|values?) (?:is|are|both are) optional|may choose|when supplied/i, `${hostLane} ${file}: overrides must be optional`);
  requirePattern(source, /forward(?:ed)? (?:either override |them |it )?(?:exactly|verbatim)|use exact/i, `${hostLane} ${file}: overrides must be forwarded exactly`);
  requirePattern(source, new RegExp(modelControl.replaceAll("-", "\\-") , "i"), `${hostLane} ${file}: missing ${modelControl}`);
  requirePattern(source, new RegExp(reasoningControl.replaceAll("-", "\\-") , "i"), `${hostLane} ${file}: missing ${reasoningControl}`);
  requirePattern(source, /(?:configured|configuration|CLI-configured).{0,80}(?:default|applies)/is, `${hostLane} ${file}: absent overrides must defer to CLI configuration`);
  requirePattern(source, /(?:no plugin-level harness default|plugin supplies no model or thinking default)/i, `${hostLane} ${file}: plugin must not select a harness default`);
  requirePattern(source, /unresolved/i, `${hostLane} ${file}: unresolved producer must be reportable`);
  requirePattern(source, /never guess|rather than guessing/i, `${hostLane} ${file}: unresolved producer must never be guessed`);
}

const adapters = [
  ["Pi", "scripts/run-pi-isolated.sh", "PI_MODEL", "--model", "PI_THINKING", "--thinking"],
  ["Pythinker", "scripts/run-pythinker-isolated.sh", "PYTHINKER_MODEL", "--model", "PYTHINKER_THINKING_EFFORT", "--thinking-effort"],
  ["OpenCode", "scripts/run-opencode-isolated.sh", "OPENCODE_MODEL", "--model", "OPENCODE_VARIANT", "--variant"],
];

for (const [lane, file, modelVariable, modelFlag, reasoningVariable, reasoningFlag] of adapters) {
  const source = read(file);
  for (const [variable, flag] of [[modelVariable, modelFlag], [reasoningVariable, reasoningFlag]]) {
    requirePattern(
      source,
      new RegExp(`if\\s+\\[\\[\\s+-n\\s+\\"\\$\\{${variable}:-\\}\\"\\s+\\]\\];\\s*then[\\s\\S]*?COMMAND\\s*\\+=\\s*\\(\\s*${flag.replaceAll("-", "\\-")}\\s+\\"\\$${variable}\\"\\s*\\)[\\s\\S]*?\\bfi\\b`),
      `${lane} ${file}: ${flag} must be appended only when ${variable} is set`,
    );
  }
}

const delegate = read("skills/delegate/SKILL.md");
const readme = read("README.md");
for (const [name, source] of [["delegate skill", delegate], ["README", readme]]) {
  requirePattern(source, /no implicit lane default|lane selection is mandatory|asks (?:which CLI|you to choose)/i, `${name}: lane selection must be explicit`);
  requirePattern(source, /model selection within a harness lane is optional|optional (?:model|`--model`)|accept optional model/i, `${name}: harness model selection must be optional`);
}

for (const file of ["agents/codex-implementer.md", ".opencode/agents/codex-implementer.md"]) {
  const source = read(file);
  requirePattern(source, /GPT-5\.6 Sol|gpt-5\.6-sol/i, `${file}: missing GPT-5.6 Sol default`);
  requirePattern(source, /model_reasoning_effort=low/, `${file}: missing low reasoning launch default`);
  requirePattern(source, /low.{0,30}default|default.{0,30}low/is, `${file}: low reasoning must be documented as the default`);
}
requirePattern(delegate, /GPT-5\.6 Sol at `low` reasoning by default/, "delegate skill: missing Codex GPT-5.6 Sol low-reasoning default");

for (const file of ["agents/pythinker-implementer.md", ".opencode/agents/pythinker-implementer.md"]) {
  requirePattern(read(file), /--thinking-effort/, `${file}: missing shared Pythinker --thinking-effort guidance`);
}
requirePattern(delegate, /--thinking-effort/, "delegate skill: missing shared Pythinker --thinking-effort guidance");

for (const file of [
  "agents/pythinker-implementer.md",
  ".opencode/agents/pythinker-implementer.md",
  "scripts/run-pythinker-isolated.sh",
  "skills/delegate/SKILL.md",
  "README.md",
]) {
  assert.doesNotMatch(
    read(file),
    /Pythinker.{0,100}(?:lacks|has no|does not (?:have|support)).{0,60}(?:shared )?(?:reasoning|thinking)(?: override| control)/is,
    `${file}: source incorrectly claims Pythinker lacks a shared reasoning override`,
  );
}

console.log("PASS: harness fallbacks and lane reasoning defaults are guarded.");
