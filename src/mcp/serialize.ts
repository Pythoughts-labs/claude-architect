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
