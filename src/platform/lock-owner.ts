/**
 * Shared classification of a lock file's recorded owner.
 *
 * Two independent callers ask about the same bytes: startup recovery, deciding
 * whether a lock may be reclaimed, and lock acquisition, explaining to a human
 * why it timed out. They must agree. A duplicated copy that drifts produces the
 * worst possible outcome — acquisition reporting "a dead process left this, it
 * will be reclaimed" while recovery preserves it forever — so the parser and
 * the status rule live here and are imported by both.
 */

/** The identifying fields of a lock owner. Extra fields are diagnostic-only. */
export interface LockOwner {
  pid: number;
  processToken: string;
}

export type LockOwnerStatus = "dead" | "live" | "unverifiable";

/**
 * Strict parse: anything short of a complete, verifiable owner record returns
 * null, which callers treat as malformed and preserve rather than reclaim. A
 * missing process token is not "probably fine" — without it a recycled pid is
 * indistinguishable from the original owner.
 */
export function parseLockOwner(contents: string): LockOwner | null {
  const trimmed = contents.trim();
  let value: unknown;
  try { value = JSON.parse(trimmed); }
  catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  const owner = value as { pid?: unknown; processToken?: unknown };
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 1
    || typeof owner.processToken !== "string" || owner.processToken.length === 0) return null;
  return { pid: owner.pid, processToken: owner.processToken };
}

export async function lockOwnerStatus(
  owner: { pid: number; processToken: string | null } | null,
  isProcessAlive: (pid: number) => boolean,
  getProcessStartToken: (pid: number) => Promise<string | null>,
): Promise<LockOwnerStatus> {
  if (owner === null || !isProcessAlive(owner.pid)) return "dead";
  if (owner.processToken === null) return "unverifiable";
  const currentToken = await getProcessStartToken(owner.pid);
  if (currentToken === null) return "unverifiable";
  return currentToken === owner.processToken ? "live" : "dead";
}
