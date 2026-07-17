import assert from "node:assert/strict";
import fs from "node:fs";

const skill = fs.readFileSync(new URL("../skills/delegate/SKILL.md", import.meta.url), "utf8");
const claudeCodexAgent = fs.readFileSync(new URL("../agents/codex-implementer.md", import.meta.url), "utf8");
const opencodeCodexAgent = fs.readFileSync(new URL("../.opencode/agents/codex-implementer.md", import.meta.url), "utf8");

assert.match(skill, /If the user invokes `\/claude-architect:delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer\./);
assert.match(skill, /Which CLI should handle this delegation\?.*Use a custom answer to name a different supported reasoning level\./);

for (const lane of ["codex-implementer", "opencode-implementer", "pi-implementer", "pythinker-implementer"]) {
  assert.ok(skill.includes(`\`${lane}\``), `delegate question must offer ${lane}`);
}

assert.match(skill, /GPT-5\.6 Sol at `low` reasoning by default \(supported overrides: `medium`, `high`, `xhigh`, `max`\)/);
assert.match(skill, /model-specific `--variant`/);
assert.match(skill, /`--thinking off\|minimal\|low\|medium\|high\|xhigh\|max`/);
assert.match(skill, /`--thinking-effort off\|minimal\|low\|medium\|high\|xhigh\|max`/);
assert.match(skill, /Pythinker configuration supplies the default/);
assert.match(skill, /include it in the delegation spec/);
assert.match(claudeCodexAgent, /model_reasoning_effort=low/);
assert.match(opencodeCodexAgent, /model_reasoning_effort=low/);
assert.match(opencodeCodexAgent, /The lane's outer 600000ms timeout remains authoritative over adapter-internal waits/);
assert.doesNotMatch(claudeCodexAgent, /model_reasoning_effort=high/);
assert.doesNotMatch(opencodeCodexAgent, /model_reasoning_effort=high/);
assert.doesNotMatch(opencodeCodexAgent, /600-second cap/);

assert.doesNotMatch(skill, /Use Codex by default|default implementation lane/);

console.log("PASS: unspecified delegations require an explicit CLI selection.");
