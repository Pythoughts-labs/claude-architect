import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "../util/errors.js";
import type { ResolvedExecutable } from "./platform-services.js";

async function pluginRoot(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const packagePath = path.join(directory, "package.json");
      const metadata = await lstat(packagePath);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return directory;
    } catch { /* continue walking */ }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new RuntimeError("unable to locate plugin root for Windows filesystem helper", {
        classification: "cleanup-backend-unavailable",
        toolError: "cleanup-backend-unavailable",
      });
    }
    directory = parent;
  }
}

export async function resolveWindowsFilesystemHelper(
  arch: NodeJS.Architecture = process.arch,
): Promise<ResolvedExecutable> {
  if (arch !== "x64" && arch !== "arm64") {
    throw new RuntimeError(`Windows filesystem helper does not support ${arch}`, {
      classification: "cleanup-backend-unavailable",
      toolError: "cleanup-backend-unavailable",
    });
  }
  const root = await pluginRoot();
  const expected = path.join(root, "native", "bin", `win32-filesystem-${arch}.exe`);
  let canonical: string;
  try {
    await access(expected);
    canonical = await realpath(expected);
    const metadata = await lstat(canonical);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RuntimeError("Windows filesystem helper is not a stable regular file");
    }
  } catch (error) {
    throw new RuntimeError("Windows filesystem helper is unavailable", {
      classification: "cleanup-backend-unavailable",
      toolError: "cleanup-backend-unavailable",
      cause: error,
    });
  }
  if (path.win32.normalize(canonical).toLowerCase()
    !== path.win32.normalize(expected).toLowerCase()) {
    throw new RuntimeError("Windows filesystem helper escaped the plugin package", {
      classification: "cleanup-backend-unavailable",
      toolError: "cleanup-backend-unavailable",
    });
  }
  return {
    kind: "native",
    command: canonical,
    prefixArgs: [],
    resolvedFrom: "plugin-native-filesystem-helper",
  };
}
