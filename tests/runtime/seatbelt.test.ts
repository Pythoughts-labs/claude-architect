import { describe, expect, it } from "vitest";
import type { ProducerInvocation } from "../../src/producers/producer-adapter.js";
import {
  buildSeatbeltProfile,
  wrapInvocationWithSeatbelt,
} from "../../src/platform/sandbox/seatbelt.js";

const invocation: ProducerInvocation = {
  executable: {
    kind: "native",
    command: "/usr/local/bin/opencode",
    prefixArgs: [],
    resolvedFrom: "path:/usr/local/bin/opencode",
  },
  args: ["run", "--dir", "/tmp/wt"],
  requiredEnv: [],
  network: "denied",
};

describe("seatbelt profile", () => {
  it("denies writes by default and allowlists worktree, temp home, and TMPDIR", () => {
    const profile = buildSeatbeltProfile({
      worktreePath: "/tmp/wt",
      tempHome: "/tmp/home",
      allowNetwork: false,
    });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/tmp/wt")');
    expect(profile).toContain('(subpath "/tmp/home")');
    expect(profile).toContain("(deny network*)");
  });

  it("escapes quotes and rejects control characters in paths", () => {
    expect(() => buildSeatbeltProfile({
      worktreePath: "/tmp/a\nb",
      tempHome: null,
      allowNetwork: false,
    })).toThrow();
    const profile = buildSeatbeltProfile({
      worktreePath: '/tmp/a"b',
      tempHome: null,
      allowNetwork: true,
    });
    expect(profile).toContain('\\"');
    expect(profile).not.toContain("(deny network*)");
  });

  it("wraps the invocation as sandbox-exec -p <profile> -- cmd args", () => {
    const wrapped = wrapInvocationWithSeatbelt(invocation, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    expect(wrapped.executable.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args[0]).toBe("-p");
    expect(wrapped.args.slice(2)).toEqual([
      "/usr/local/bin/opencode",
      "run",
      "--dir",
      "/tmp/wt",
    ]);
    expect(wrapped.network).toBe("denied");
    expect(wrapped.stdin).toBe(invocation.stdin);
  });

  it("preserves node-entrypoint prefix args inside the wrapped argv", () => {
    const wrapped = wrapInvocationWithSeatbelt(
      {
        ...invocation,
        executable: {
          kind: "node-entrypoint",
          command: process.execPath,
          prefixArgs: ["/x/cli.js"],
          resolvedFrom: "npm-entry:/x/cli.js",
        },
      },
      { worktreePath: "/tmp/wt", tempHome: null, allowNetwork: false },
    );
    expect(wrapped.args.slice(2)).toEqual([
      process.execPath,
      "/x/cli.js",
      "run",
      "--dir",
      "/tmp/wt",
    ]);
  });
});
