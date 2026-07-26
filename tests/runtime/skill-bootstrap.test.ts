import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSkillBootstrap } from "../../src/producers/skill-bootstrap.js";

const OFFERED_SKILLS = [
  "test-driven-development",
  "systematic-debugging",
  "verification-before-completion",
] as const;

const FORBIDDEN_SKILLS = [
  ["dispatching-parallel-agents", "nested delegation"],
  ["subagent-driven-development", "nested delegation"],
  ["requesting-code-review", "independent pipeline role"],
  ["receiving-code-review", "independent pipeline role"],
  ["finishing-a-development-branch", "only a human can accept"],
  ["using-git-worktrees", "already runs inside a linked worktree"],
  ["brainstorming", "no human in the Producer loop"],
  ["writing-plans", "Delegation Spec is the plan"],
  ["executing-plans", "host-loop skill"],
  ["using-superpowers", "explicitly excludes dispatched subagents"],
  ["writing-skills", "host-loop skill"],
] as const;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("renderSkillBootstrap", () => {
  it("renders each offered skill with a trigger and an existing absolute path", () => {
    const bootstrap = renderSkillBootstrap();

    for (const skill of OFFERED_SKILLS) {
      const line = bootstrap.split("\n").find(candidate => candidate.startsWith(`- ${skill} —`));
      expect(line).toContain("Trigger:");
      const path = line?.split(" Path: ")[1];
      expect(path).toBeDefined();
      expect(isAbsolute(path!)).toBe(true);
      expect(existsSync(path!)).toBe(true);
    }
  });

  it("names every forbidden skill and its trust-invariant reason", () => {
    const bootstrap = renderSkillBootstrap();

    for (const [skill, reason] of FORBIDDEN_SKILLS) {
      const line = bootstrap.split("\n").find(candidate => candidate.startsWith(`- ${skill} —`));
      expect(line).toContain(reason);
    }
  });

  it("imports safely without vendored files and fails closed only when rendering", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: () => false }));

    const imported = await import("../../src/producers/skill-bootstrap.js");

    expect(imported.renderSkillBootstrap).toBeTypeOf("function");
    expect(() => imported.renderSkillBootstrap()).toThrowError(
      /missing vendored skill path\(s\): .*SKILL\.md/u,
    );
  });
});
