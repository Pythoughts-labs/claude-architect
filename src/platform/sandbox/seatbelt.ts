import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProducerInvocation } from "../../producers/producer-adapter.js";

export interface SeatbeltPolicy {
  worktreePath: string;
  tempHome: string | null;
  allowNetwork: boolean;
}

function sbPath(path: string): string {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      throw new Error(`seatbelt: control character in path: ${JSON.stringify(path)}`);
    }
  }
  return `"${path.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function openCodeWritablePaths(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): string[] {
  if (
    policy.tempHome !== null
    || !invocation.requiredEnv.includes("OPENCODE_CONFIG_DIR")
  ) return [];

  const home = homedir();
  const dataHome = invocation.env?.XDG_DATA_HOME
    ?? process.env.XDG_DATA_HOME
    ?? join(home, ".local", "share");
  const stateHome = invocation.env?.XDG_STATE_HOME
    ?? process.env.XDG_STATE_HOME
    ?? join(home, ".local", "state");
  return [join(dataHome, "opencode"), join(stateHome, "opencode")];
}

function piWritablePaths(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): string[] {
  if (
    policy.tempHome !== null
    || !invocation.requiredEnv.includes("PI_API_KEY")
  ) return [];

  const home = invocation.env?.HOME ?? process.env.HOME ?? homedir();
  return [join(home, ".pi", "agent")];
}

function isPythinkerInvocation(invocation: ProducerInvocation): boolean {
  return invocation.args.includes("--work-dir")
    && invocation.args.includes("--prompt");
}

function pythinkerWritablePaths(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): string[] {
  if (policy.tempHome !== null || !isPythinkerInvocation(invocation)) return [];

  const home = invocation.env?.HOME ?? process.env.HOME ?? homedir();
  return [join(home, ".pythinker")];
}

function preparePythinkerInvocation(
  invocation: ProducerInvocation,
): ProducerInvocation {
  if (!isPythinkerInvocation(invocation)) return invocation;
  return {
    ...invocation,
    args: [...invocation.args, "--mcp-config-file", "/dev/stdin"],
    stdin: '{"mcpServers":{}}\n',
  };
}

function buildProfile(policy: SeatbeltPolicy, additionalWritable: string[]): string {
  const writable = [...new Set([
    policy.worktreePath,
    policy.tempHome,
    process.env.TMPDIR ?? "/private/tmp",
    "/private/tmp",
    "/dev",
    ...additionalWritable,
  ]
    .filter((path): path is string => typeof path === "string" && path.length > 0)
    .flatMap(path => {
      try {
        return [path, realpathSync(path)];
      } catch {
        return [path];
      }
    }))];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    ...writable.map(path => `(allow file-write* (subpath ${sbPath(path)}))`),
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty"))',
  ];
  if (!policy.allowNetwork) lines.push("(deny network*)");
  return lines.join("\n");
}

export function buildSeatbeltProfile(policy: SeatbeltPolicy): string {
  return buildProfile(policy, []);
}

export function wrapInvocationWithSeatbelt(
  invocation: ProducerInvocation,
  policy: SeatbeltPolicy,
): ProducerInvocation {
  const profile = buildProfile(policy, [
    ...openCodeWritablePaths(invocation, policy),
    ...piWritablePaths(invocation, policy),
    ...pythinkerWritablePaths(invocation, policy),
  ]);
  const preparedInvocation = preparePythinkerInvocation(invocation);
  const inner = [
    preparedInvocation.executable.command,
    ...preparedInvocation.executable.prefixArgs,
    ...preparedInvocation.args,
  ];
  return {
    ...preparedInvocation,
    executable: {
      kind: "native",
      command: "/usr/bin/sandbox-exec",
      prefixArgs: [],
      resolvedFrom: `seatbelt:${invocation.executable.resolvedFrom}`,
    },
    args: ["-p", profile, ...inner],
  };
}
