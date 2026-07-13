import assert from "node:assert/strict";
import fs from "node:fs";

const skill = fs.readFileSync(new URL("../skills/delegate/SKILL.md", import.meta.url), "utf8");

assert.match(skill, /If the user invokes `\/delegate` without naming a CLI, implementer, or agent, use the host's structured question tool when available, ask this question, and wait for the answer:/);
assert.match(skill, /Which CLI should handle this delegation\?/);

for (const lane of ["codex-implementer", "opencode-implementer", "pi-implementer", "pythinker-implementer"]) {
  assert.ok(skill.includes(`\`${lane}\``), `delegate question must offer ${lane}`);
}

assert.doesNotMatch(skill, /Use Codex by default|default implementation lane/);

console.log("PASS: unspecified delegations require an explicit CLI selection.");
