import { getPlatformServices } from "../platform/select-platform.js";
import { supervise } from "../platform/process-supervisor.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated?: { stdout: boolean; stderr: boolean };
}

export interface GitExecOptions {
  indexFile?: string;
  env?: Record<string, string>;
  stdin?: string;
  maxOutputBytes?: number;
}

const FILTER_KEY_PATTERN = "^filter\\..*\\.(clean|smudge|process|required)$";
const LOCAL_DISCOVERY_PATTERN =
  "^(extensions\\.worktreeconfig|filter\\..*\\.(clean|smudge|process|required))$";

function toGitResult(exit: Awaited<ReturnType<typeof supervise>>): GitResult {
  return {
    stdout: exit.stdout,
    stderr: exit.stderr,
    exitCode: exit.exitCode,
    truncated: { ...exit.truncated },
  };
}

function parseLocalDiscovery(stdout: string): {
  filterKeys: string[];
  worktreeConfigEnabled: boolean;
} {
  const filterKeys: string[] = [];
  let worktreeConfigEnabled = false;

  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\n");
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? "" : record.slice(separator + 1).trim().toLowerCase();
    if (key.toLowerCase() === "extensions.worktreeconfig") {
      worktreeConfigEnabled = ["true", "yes", "on", "1"].includes(value);
    } else {
      filterKeys.push(key);
    }
  }

  return { filterKeys, worktreeConfigEnabled };
}

function parseNameOnlyDiscovery(stdout: string): string[] {
  return stdout.split("\0").filter(key => key.length > 0);
}

function filterNeutralizations(keys: string[]): { args?: string[]; error?: GitResult } {
  const drivers = new Set<string>();
  for (const key of keys) {
    const match = /^filter\.(.*)\.(clean|smudge|process|required)$/i.exec(key);
    if (match === null) continue;
    const driver = match[1];
    if (driver === undefined || /[=.\n\0]/.test(driver)) {
      return {
        error: {
          stdout: "",
          stderr: "Refusing unsafe Git filter driver name\n",
          exitCode: 2,
        },
      };
    }
    drivers.add(driver);
  }

  const args: string[] = [];
  for (const driver of drivers) {
    args.push(
      "-c", `filter.${driver}.clean=`,
      "-c", `filter.${driver}.smudge=`,
      "-c", `filter.${driver}.process=`,
      "-c", `filter.${driver}.required=false`,
    );
  }
  return { args };
}

export async function git(
  cwd: string,
  args: string[],
  indexFileOrOptions?: string | GitExecOptions,
): Promise<GitResult> {
  const platformServices = getPlatformServices();
  const executable = await platformServices.resolveExecutable({ name: "git" });
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const options = typeof indexFileOrOptions === "string"
    ? { indexFile: indexFileOrOptions }
    : indexFileOrOptions ?? {};
  const maxOutputBytes = options.maxOutputBytes ?? 8_000_000;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    GIT_AUTHOR_NAME: "claude-architect",
    GIT_AUTHOR_EMAIL: "runtime@claude-architect.invalid",
    GIT_COMMITTER_NAME: "claude-architect",
    GIT_COMMITTER_EMAIL: "runtime@claude-architect.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    ...options.env,
  };
  const hardeningArgs = [
    "-c", `core.hooksPath=${nullDevice}`,
    "-c", "core.fsmonitor=false",
    "-c", `core.attributesFile=${nullDevice}`,
    "-c", "core.autocrlf=false",
  ];

  let discoveredFilterKeys: string[] = [];
  if (args[0] !== "init") {
    const localDiscovery = await supervise(platformServices, {
      executable,
      args: [
        ...hardeningArgs,
        "config", "--local", "--includes", "--null", "--get-regexp", LOCAL_DISCOVERY_PATTERN,
      ],
      cwd,
      env,
      timeoutMs: 60_000,
      maxOutputBytes,
    }, {});
    if (localDiscovery.exitCode !== 0 && !(localDiscovery.exitCode === 1 && localDiscovery.stdout === "")) {
      return toGitResult(localDiscovery);
    }

    const local = parseLocalDiscovery(localDiscovery.stdout);
    discoveredFilterKeys = local.filterKeys;
    if (local.worktreeConfigEnabled) {
      const worktreeDiscovery = await supervise(platformServices, {
        executable,
        args: [
          ...hardeningArgs,
          "config", "--worktree", "--includes", "--name-only", "--null",
          "--get-regexp", FILTER_KEY_PATTERN,
        ],
        cwd,
        env,
        timeoutMs: 60_000,
        maxOutputBytes,
      }, {});
      if (worktreeDiscovery.exitCode !== 0
        && !(worktreeDiscovery.exitCode === 1 && worktreeDiscovery.stdout === "")) {
        return toGitResult(worktreeDiscovery);
      }
      discoveredFilterKeys.push(...parseNameOnlyDiscovery(worktreeDiscovery.stdout));
    }
  }

  const neutralizations = filterNeutralizations(discoveredFilterKeys);
  if (neutralizations.error !== undefined) return neutralizations.error;
  const exit = await supervise(platformServices, {
    executable,
    args: [...hardeningArgs, ...(neutralizations.args ?? []), ...args],
    cwd,
    env,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    timeoutMs: 60_000,
    maxOutputBytes,
  }, {});
  return toGitResult(exit);
}
