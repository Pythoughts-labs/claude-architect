import { promises as fs } from "node:fs";
import path from "node:path";
import nodeProcess from "node:process";
import { RuntimeError } from "../util/errors.js";
import type {
  CanonicalPath, CheckoutLock, ExecutableRequest, PlatformServices, ResolvedExecutable,
  SpawnRequest, SupervisedProcess,
} from "./platform-services.js";

interface WindowsExecutableDependencies {
  pathEntries: string[];
  pathext: string[];
  fs: {
    isFile(path: string): Promise<boolean>;
    readFile(path: string): Promise<string>;
  };
  nodeExe: string;
  comSpec?: string;
  npmEntryProbe?: string[];
}

async function packageBinEntries(
  request: ExecutableRequest,
  directory: string,
  fileSystem: WindowsExecutableDependencies["fs"],
): Promise<string[]> {
  const packageDirectory = path.win32.join(directory, "node_modules", request.name);
  const packagePath = path.win32.join(packageDirectory, "package.json");
  if (!await fileSystem.isFile(packagePath.toLowerCase())) return [];

  try {
    const parsed: unknown = JSON.parse(await fileSystem.readFile(packagePath));
    if (typeof parsed !== "object" || parsed === null || !("bin" in parsed)) return [];
    const bin: unknown = parsed.bin;
    if (typeof bin === "string") {
      return [path.win32.relative(directory, path.win32.join(packageDirectory, bin))];
    }
    if (typeof bin !== "object" || bin === null) return [];
    const namedBin = (bin as Record<string, unknown>)[request.name];
    if (typeof namedBin === "string") {
      return [path.win32.relative(directory, path.win32.join(packageDirectory, namedBin))];
    }
  } catch {
    return [];
  }
  return [];
}

export async function resolveWindowsExecutable(
  request: ExecutableRequest,
  deps: WindowsExecutableDependencies,
): Promise<ResolvedExecutable> {
  if (request.explicitPath !== undefined) {
    if (!await deps.fs.isFile(request.explicitPath.toLowerCase())) {
      throw new RuntimeError("executable was not found", { path: request.explicitPath });
    }
    return {
      kind: "native", command: request.explicitPath, prefixArgs: [],
      resolvedFrom: `explicit:${request.explicitPath}`,
    };
  }

  for (const directory of deps.pathEntries) {
    for (const extension of deps.pathext) {
      const candidate = path.win32.join(directory, `${request.name}${extension.toLowerCase()}`);
      if (!await deps.fs.isFile(candidate.toLowerCase())) continue;

      const normalizedExtension = extension.toLowerCase();
      if (normalizedExtension === ".exe" || normalizedExtension === ".com") {
        return {
          kind: "native", command: candidate, prefixArgs: [],
          resolvedFrom: `pathext:${candidate}`,
        };
      }

      if (normalizedExtension === ".cmd" || normalizedExtension === ".bat") {
        const entries = deps.npmEntryProbe
          ?? await packageBinEntries(request, directory, deps.fs);
        for (const entry of entries) {
          const absoluteEntry = path.win32.join(directory, entry);
          if (await deps.fs.isFile(absoluteEntry.toLowerCase())) {
            return {
              kind: "node-entrypoint", command: deps.nodeExe, prefixArgs: [absoluteEntry],
              resolvedFrom: `npm-entry:${absoluteEntry}`,
            };
          }
        }
        return {
          kind: "cmd-wrapper",
          command: deps.comSpec ?? "C:\\Windows\\System32\\cmd.exe",
          prefixArgs: ["/d", "/s", "/c", candidate],
          resolvedFrom: `cmd-wrapper:${candidate}`,
        };
      }
    }
  }
  throw new RuntimeError("executable was not found", { name: request.name });
}

function notImplemented(): never {
  throw new RuntimeError("not implemented until P0-B Task 3/4");
}

export class WindowsPlatformServices implements PlatformServices {
  readonly os = "win32";

  async resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable> {
    const pathext = (nodeProcess.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";").filter(Boolean).map(extension => extension.toUpperCase());
    const pathEntries = (request.searchPath ?? nodeProcess.env.Path ?? nodeProcess.env.PATH ?? "")
      .split(";").filter(Boolean);
    const realFs = {
      async isFile(candidate: string): Promise<boolean> {
        try { return (await fs.stat(candidate)).isFile(); }
        catch { return false; }
      },
      async readFile(candidate: string): Promise<string> { return fs.readFile(candidate, "utf8"); },
    };
    const commonDeps = { pathEntries, pathext, fs: realFs, nodeExe: nodeProcess.execPath };
    return nodeProcess.env.ComSpec === undefined
      ? resolveWindowsExecutable(request, commonDeps)
      : resolveWindowsExecutable(request, { ...commonDeps, comSpec: nodeProcess.env.ComSpec });
  }

  async spawnSupervised(_request: SpawnRequest): Promise<SupervisedProcess> { return notImplemented(); }
  async requestCooperativeCancellation(_process: SupervisedProcess): Promise<void> { return notImplemented(); }
  async terminateProcessTree(_process: SupervisedProcess): Promise<void> { return notImplemented(); }
  async getProcessStartToken(_pid: number): Promise<string | null> { return notImplemented(); }
  async terminateProcessTreeByPid(_pid: number, _expectedToken?: string | null): Promise<void> {
    return notImplemented();
  }
  async acquireCheckoutLock(_checkout: string): Promise<CheckoutLock> { return notImplemented(); }
  async createSecureTempDirectory(): Promise<string> { return notImplemented(); }
  async canonicalizePath(_path: string): Promise<CanonicalPath> { return notImplemented(); }
}
