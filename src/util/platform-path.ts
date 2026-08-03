import path from "node:path";

function stripWindowsExtendedPrefix(value: string): string {
  if (value.toLowerCase().startsWith("\\\\?\\unc\\")) return `\\\\${value.slice(8)}`;
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

/**
 * Compare canonical absolute paths without assuming a Windows directory's
 * per-directory case-sensitivity policy. Callers canonicalize existing paths
 * with realpath first; missing paths must match casing exactly and therefore
 * fail closed when the filesystem policy cannot be observed.
 */
export function platformPathsEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return path.resolve(left) === path.resolve(right);
  return path.win32.normalize(stripWindowsExtendedPrefix(left))
    === path.win32.normalize(stripWindowsExtendedPrefix(right));
}
