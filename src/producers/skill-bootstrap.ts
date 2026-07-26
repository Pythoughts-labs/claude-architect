import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OFFERED_SKILLS = [
  {
    name: "test-driven-development",
    trigger: "Use for every behavior change or bug fix, before writing implementation code.",
  },
  {
    name: "systematic-debugging",
    trigger: "Use when a test, build, or behavior fails unexpectedly, before proposing a fix.",
  },
  {
    name: "verification-before-completion",
    trigger: "Use before claiming that work is complete or successful.",
  },
] as const;

const FORBIDDEN_SKILLS = [
  ["dispatching-parallel-agents", "nested delegation is forbidden"],
  ["subagent-driven-development", "nested delegation is forbidden"],
  [
    "requesting-code-review",
    "implementers cannot review their own work; review is an independent pipeline role",
  ],
  [
    "receiving-code-review",
    "implementers cannot review their own work; review is an independent pipeline role",
  ],
  [
    "finishing-a-development-branch",
    "only a human can accept a candidate, and src/integrate/ owns application",
  ],
  ["using-git-worktrees", "the attempt already runs inside a linked worktree"],
  ["brainstorming", "there is no human in the Producer loop"],
  [
    "writing-plans",
    "the Delegation Spec is the plan, and a plan-only run with zero edits is a failure",
  ],
  ["executing-plans", "it is a host-loop skill, not an attempt procedure"],
  [
    "using-superpowers",
    "it is a host-loop skill and explicitly excludes dispatched subagents",
  ],
  ["writing-skills", "it is a host-loop skill, not an attempt procedure"],
] as const;

export function renderSkillBootstrap(): string {
  // Source layout: src/producers/ → ../../vendor/superpowers/skills/.
  // Bundled layout: runtime/server.mjs → ../vendor/superpowers/skills/.
  const candidateRoots = [
    new URL("../../vendor/superpowers/skills/", import.meta.url),
    new URL("../vendor/superpowers/skills/", import.meta.url),
  ];
  const missingPaths: string[] = [];

  for (const root of candidateRoots) {
    const offered = OFFERED_SKILLS.map(skill => ({
      ...skill,
      path: fileURLToPath(new URL(`${skill.name}/SKILL.md`, root)),
    }));
    const missing = offered.filter(skill => !existsSync(skill.path));
    if (missing.length > 0) {
      missingPaths.push(...missing.map(skill => skill.path));
      continue;
    }

    return [
      "## Delegated procedure skills",
      "These are the only skill documents you may read. Read an offered skill when its trigger applies, using the exact absolute path. Do not search for or read repository agent rules or other skill documents.",
      "",
      "Offered skills:",
      ...offered.map(skill =>
        `- ${skill.name} — Trigger: ${skill.trigger} Path: ${skill.path}`),
      "",
      "These paths are outside your worktree and are read-only. Never copy their contents into the"
      + " repository, reference them from the candidate diff, or treat them as files under review.",
      "",
      "Forbidden skills:",
      ...FORBIDDEN_SKILLS.map(([name, reason]) => `- ${name} — Forbidden because ${reason}.`),
    ].join("\n");
  }

  throw new Error(
    `Delegated skill bootstrap unavailable; missing vendored skill path(s): ${
      missingPaths.join(", ")
    }`,
  );
}
