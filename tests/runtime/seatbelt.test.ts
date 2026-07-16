import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProducerInvocation } from "../../src/producers/producer-adapter.js";
import {
  buildReadOnlySeatbeltPolicy,
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

  it.skipIf(process.platform !== "darwin")(
    "includes both raw and canonical writable paths",
    () => {
      const rawPath = mkdtempSync(join(tmpdir(), "claude-architect-seatbelt-path-"));

      try {
        const canonicalPath = realpathSync(rawPath);
        expect(canonicalPath).not.toBe(rawPath);

        const profile = buildSeatbeltProfile({
          worktreePath: rawPath,
          tempHome: null,
          allowNetwork: false,
        });
        expect(profile.split(`(subpath "${rawPath}")`)).toHaveLength(2);
        expect(profile.split(`(subpath "${canonicalPath}")`)).toHaveLength(2);
      } finally {
        rmSync(rawPath, { recursive: true, force: true });
      }
    },
  );

  it("falls back to the raw writable path when realpath fails", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-architect-seatbelt-missing-"));
    const missingPath = join(root, "missing");

    try {
      expect(() => realpathSync(missingPath)).toThrow();

      const profile = buildSeatbeltProfile({
        worktreePath: missingPath,
        tempHome: null,
        allowNetwork: false,
      });
      expect(profile.split(`(subpath "${missingPath}")`)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allowlists only OpenCode's XDG state directories without a temp home", () => {
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/Users/test/.local/state";

    try {
      const wrapped = wrapInvocationWithSeatbelt({
        ...invocation,
        requiredEnv: ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"],
        env: { XDG_DATA_HOME: "/Users/test/.local/share" },
      }, {
        worktreePath: "/tmp/wt",
        tempHome: null,
        allowNetwork: false,
      });
      const profile = wrapped.args[1] ?? "";

      expect(profile).toContain('(subpath "/Users/test/.local/share/opencode")');
      expect(profile).toContain('(subpath "/Users/test/.local/state/opencode")');
      expect(profile).not.toContain('(subpath "/Users/test/.local/share")');
      expect(profile).not.toContain('(subpath "/Users/test/.local/state")');
      expect(profile).not.toContain('(subpath "/Users/test")');
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    }
  });

  it("allowlists only Pi's agent state directory without a temp home", () => {
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      requiredEnv: ["PI_API_KEY"],
      env: { HOME: "/Users/test" },
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).toContain('(subpath "/Users/test/.pi/agent")');
    expect(profile).not.toContain('(subpath "/Users/test/.pi")');
    expect(profile).not.toContain('(subpath "/Users/test")');
  });

  it("allowlists only Pythinker's state directory without a temp home", () => {
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      args: ["--work-dir", "/tmp/wt", "--prompt", "test"],
      env: { HOME: "/Users/test" },
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).toContain('(subpath "/Users/test/.pythinker")');
    expect(profile).not.toContain('(subpath "/Users/test")');
    expect(wrapped.args.slice(-2)).toEqual(["--mcp-config-file", "/dev/stdin"]);
    expect(wrapped.stdin).toBe('{"mcpServers":{}}\n');
  });

  it("keeps joined subpaths POSIX even when HOME contains win32-style separators", () => {
    const wrapped = wrapInvocationWithSeatbelt({
      ...invocation,
      args: ["--work-dir", "/tmp/wt", "--prompt", "test"],
      env: { HOME: "C:\\Users\\test" },
    }, {
      worktreePath: "/tmp/wt",
      tempHome: null,
      allowNetwork: false,
    });
    const profile = wrapped.args[1] ?? "";

    expect(profile).toContain('(subpath "C:\\\\Users\\\\test/.pythinker")');
    expect(profile).not.toContain('(subpath "C:\\\\Users\\\\test")');
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

describe("buildReadOnlySeatbeltPolicy", () => {
  it("grants no write access to the worktree", () => {
    const policy = buildReadOnlySeatbeltPolicy({ tempHome: "/tmp/role-home" });
    const profile = buildSeatbeltProfile(policy);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/tmp/role-home")');
    expect(profile).not.toContain("worktrees");
  });

  it("works with no temp home at all", () => {
    const profile = buildSeatbeltProfile(buildReadOnlySeatbeltPolicy({ tempHome: null }));
    expect(profile).toContain("(deny file-write*)");
  });
});
