interface RepoMutex {
  tail: Promise<void>;
  pending: number;
}

const mutexes = new Map<string, RepoMutex>();

export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let mutex = mutexes.get(key);
  if (mutex === undefined) {
    mutex = { tail: Promise.resolve(), pending: 0 };
    mutexes.set(key, mutex);
  }

  const previous = mutex.tail;
  let release!: () => void;
  mutex.tail = new Promise<void>(resolve => {
    release = resolve;
  });
  mutex.pending += 1;

  await previous;
  try {
    return await fn();
  } finally {
    release();
    mutex.pending -= 1;
    if (mutex.pending === 0 && mutexes.get(key) === mutex) mutexes.delete(key);
  }
}

const IGNORED_PATHS_LIMIT = 50;

/**
 * Bounds `evidence.ignoredPaths` on returned copies only — archived artifacts
 * keep the complete list. A repository-sized ignore set (node_modules) would
 * otherwise dominate every delegate/review tool result.
 */
export function boundIgnoredPathEvidence<T extends { evidence?: unknown }>(value: T): T {
  const evidence = value.evidence;
  if (typeof evidence !== "object" || evidence === null) return value;
  const paths = (evidence as Record<string, unknown>).ignoredPaths;
  if (!Array.isArray(paths) || paths.length <= IGNORED_PATHS_LIMIT) return value;
  return {
    ...value,
    evidence: {
      ...(evidence as Record<string, unknown>),
      ignoredPaths: paths.slice(0, IGNORED_PATHS_LIMIT),
      ignoredPathsOmitted: paths.length - IGNORED_PATHS_LIMIT,
    },
  };
}
