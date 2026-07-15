import { getPlatformServices } from "../platform/select-platform.js";
import { supervise } from "../platform/process-supervisor.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: { stdout: boolean; stderr: boolean };
}

export async function git(cwd: string, args: string[], indexFile?: string): Promise<GitResult> {
  const platformServices = getPlatformServices();
  const executable = await platformServices.resolveExecutable({ name: "git" });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    GIT_AUTHOR_NAME: "claude-architect",
    GIT_AUTHOR_EMAIL: "runtime@claude-architect.invalid",
    GIT_COMMITTER_NAME: "claude-architect",
    GIT_COMMITTER_EMAIL: "runtime@claude-architect.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
  };
  const exit = await supervise(platformServices, {
    executable,
    args: ["-c", "core.autocrlf=false", ...args],
    cwd,
    env,
    timeoutMs: 60_000,
    maxOutputBytes: 8_000_000,
  }, {});
  return {
    stdout: exit.stdout,
    stderr: exit.stderr,
    exitCode: exit.exitCode,
    truncated: { ...exit.truncated },
  };
}
