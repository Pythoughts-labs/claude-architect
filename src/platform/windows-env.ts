const CANONICAL = new Map(["Path", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
  .map(name => [name.toLowerCase(), name]));

export function normalizeWindowsEnv(env: Record<string, string | undefined>): Record<string, string> {
  const byLower = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    byLower.set(lower, { name: CANONICAL.get(lower) ?? byLower.get(lower)?.name ?? name, value });
  }
  return Object.fromEntries([...byLower.values()].map(e => [e.name, e.value]));
}
