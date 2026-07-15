import type { PlatformServices, SpawnRequest, SupervisedExit } from "./platform-services.js";
import { RUNTIME_MAX_TIMEOUT_MS } from "../protocol/delegation-spec.js";
export async function supervise(
  ps: PlatformServices, req: SpawnRequest, opts: { onCancel?: AbortSignal; graceMs?: number }
): Promise<SupervisedExit> {
  if (!(req.timeoutMs > 0 && req.timeoutMs <= RUNTIME_MAX_TIMEOUT_MS)) throw new Error("invalid timeout");
  const proc = await ps.spawnSupervised(req);
  let timedOut = false, cancelled = false;
  let settled = false;
  const grace = opts.graceMs ?? 3000;
  const graceTimers = new Set<NodeJS.Timeout>();
  const escalate = () => {
    if (settled) return;
    const timer = setTimeout(() => {
      graceTimers.delete(timer);
      if (!settled) void ps.terminateProcessTree(proc).catch(() => {});
    }, grace);
    graceTimers.add(timer);
  };
  const cancelCooperatively = () => {
    void Promise.resolve()
      .then(() => ps.requestCooperativeCancellation(proc))
      .catch(() => {})
      .then(escalate);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancelCooperatively();
  }, req.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    cancelCooperatively();
  };
  opts.onCancel?.addEventListener("abort", onAbort, { once: true });
  try {
    const exit = await proc.done;
    return { ...exit, timedOut: timedOut || exit.timedOut, cancelled: cancelled || exit.cancelled };
  } finally {
    // Cancel EVERY pending timer once the process settles, so a late SIGKILL cannot hit a reused pgid.
    settled = true;
    clearTimeout(timer); for (const t of graceTimers) clearTimeout(t);
    opts.onCancel?.removeEventListener("abort", onAbort);
  }
}
