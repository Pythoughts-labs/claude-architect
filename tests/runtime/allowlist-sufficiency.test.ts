import { describe, expect, it } from "vitest";
import {
  allowlistSufficiencyDiagnostic,
  checkAllowlistSufficiency,
  resolveImport,
} from "../../src/mcp/allowlist-sufficiency.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";

function spec(writeAllowlist: string[], forbiddenScope: string[] = []): DelegationSpec {
  return {
    specVersion: "1",
    objective: "objective",
    context: "context",
    writeAllowlist,
    forbiddenScope,
    successCriteria: ["done"],
    verification: [],
    executionMode: "edit",
    timeoutMs: 600_000,
    producerPreferences: ["codex"],
    expectedOutput: "candidate-patch",
  };
}

function repository(files: Record<string, string>) {
  return {
    git: async () => ({
      stdout: `${Object.keys(files).join("\0")}\0`,
      stderr: "",
      exitCode: 0,
    }),
    readFile: async (target: string) => {
      const key = Object.keys(files).find(name => target.replace(/\\/gu, "/").endsWith(name));
      if (key === undefined) throw new Error(`ENOENT ${target}`);
      return files[key]!;
    },
  };
}

describe("write allowlist sufficiency", () => {
  it("maps an emitted .js specifier back to its TypeScript source", () => {
    const tracked = new Set(["src/mcp/tools.ts", "tests/runtime/e2e.test.ts"]);

    expect(resolveImport("tests/runtime/e2e.test.ts", "../../src/mcp/tools.js", tracked))
      .toBe("src/mcp/tools.ts");
  });

  it("ignores package specifiers and paths that escape the repository", () => {
    const tracked = new Set(["src/mcp/tools.ts"]);

    expect(resolveImport("tests/e2e.test.ts", "vitest", tracked)).toBeNull();
    expect(resolveImport("src/a.ts", "../../outside/thing.js", tracked)).toBeNull();
  });

  it("names a consumer the Producer would not be able to repair", async () => {
    const result = await checkAllowlistSufficiency("/repo", spec(["src/mcp/tools.ts"]), repository({
      "src/mcp/tools.ts": "export function handle() {}",
      "tests/runtime/e2e.test.ts": 'import { handle } from "../../src/mcp/tools.js";',
    }));

    expect(result.allowlisted).toBe(1);
    expect(result.gaps).toEqual([{
      path: "tests/runtime/e2e.test.ts",
      imports: ["src/mcp/tools.ts"],
    }]);
    expect(allowlistSufficiencyDiagnostic(result)).toContain("tests/runtime/e2e.test.ts");
  });

  it("stays silent when every consumer is already inside the allowlist", async () => {
    const result = await checkAllowlistSufficiency(
      "/repo",
      spec(["src/mcp/**", "tests/runtime/**"]),
      repository({
        "src/mcp/tools.ts": "export function handle() {}",
        "tests/runtime/e2e.test.ts": 'import { handle } from "../../src/mcp/tools.js";',
      }),
    );

    expect(result.gaps).toEqual([]);
    expect(allowlistSufficiencyDiagnostic(result)).toBeNull();
  });

  it("treats a forbidden path as outside the allowlist even when a pattern matches it", async () => {
    const result = await checkAllowlistSufficiency(
      "/repo",
      spec(["src/**"], ["src/mcp/**"]),
      repository({
        "src/mcp/tools.ts": "export function handle() {}",
        "src/runtime/caller.ts": 'import { handle } from "../mcp/tools.js";',
      }),
    );

    // tools.ts is forbidden, so nothing in the allowlist is imported by caller.ts.
    expect(result.gaps).toEqual([]);
  });

  it("ranks consumer tests ahead of other consumers", async () => {
    const result = await checkAllowlistSufficiency("/repo", spec(["src/a.ts"]), repository({
      "src/a.ts": "export const a = 1;",
      "src/z-consumer.ts": 'import { a } from "./a.js";',
      "tests/runtime/z.test.ts": 'import { a } from "../../src/a.js";',
    }));

    expect(result.gaps.map(gap => gap.path))
      .toEqual(["tests/runtime/z.test.ts", "src/z-consumer.ts"]);
  });

  it("reports nothing when the allowlist matches no tracked file", async () => {
    const result = await checkAllowlistSufficiency("/repo", spec(["docs/**"]), repository({
      "src/a.ts": "export const a = 1;",
    }));

    expect(result).toEqual({ allowlisted: 0, gaps: [], omitted: 0 });
  });

  it("degrades quietly when the repository cannot be listed", async () => {
    const result = await checkAllowlistSufficiency("/repo", spec(["src/**"]), {
      git: async () => ({ stdout: "", stderr: "not a repository", exitCode: 128 }),
    });

    expect(result).toEqual({ allowlisted: 0, gaps: [], omitted: 0 });
  });

  it("reproduces the finding-22 spec against this repository", async () => {
    // ISO-A allowlisted the handlers plus tools.test.ts and missed the e2e
    // suites that call the same lifecycle functions; the arity change compiled
    // and passed focused verification, then broke the architect's full suite.
    const result = await checkAllowlistSufficiency(process.cwd(), spec([
      "src/mcp/tools.ts",
      "tests/runtime/tools.test.ts",
    ]));

    expect(result.allowlisted).toBe(2);
    expect(result.gaps.map(gap => gap.path)).toContain("tests/runtime/e2e-pipeline.test.ts");
  });
});
