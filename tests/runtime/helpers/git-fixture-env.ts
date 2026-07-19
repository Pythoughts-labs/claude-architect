export function scrubbedGitEnv(
  overrides?: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const locationKeys = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_COMMON_DIR",
    "GIT_PREFIX",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ] as const;

  for (const key of locationKeys) delete env[key];

  return { ...env, ...overrides };
}
