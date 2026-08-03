import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { RuntimeError } from "../util/errors.js";
import { assertNoPendingWorktreeRemovalForRepository } from "./worktree-removal-manifest.js";

const WORKTREE_MUTATION_GUARD = Symbol("claude-architect.worktree-mutation-guard");

type LockingPlatformServices = Pick<PlatformServices, "acquireCheckoutLock">;
type GuardedServices = LockingPlatformServices & {
  [WORKTREE_MUTATION_GUARD]?: true;
};

/**
 * Recheck durable removal ambiguity only after repository serialization.
 *
 * Recovery deliberately uses raw PlatformServices so it can acquire the lease
 * that resolves a pending transaction. Every ordinary lifecycle entrypoint
 * wraps its services here before beginning checkout/worktree mutation.
 */
export function guardWorktreeMutations<T extends LockingPlatformServices>(services: T): T {
  if ((services as GuardedServices)[WORKTREE_MUTATION_GUARD] === true) return services;
  const guarded = Object.create(services) as T & GuardedServices;
  Object.defineProperty(guarded, WORKTREE_MUTATION_GUARD, { value: true });
  guarded.acquireCheckoutLock = async (
    checkoutPath,
    options,
  ): Promise<CheckoutLock> => {
    const lease = await services.acquireCheckoutLock(checkoutPath, options);
    try {
      await assertNoPendingWorktreeRemovalForRepository(lease.repositoryIdentity);
      return lease;
    } catch (error) {
      const gateError = new RuntimeError(
        "worktree mutation is unavailable while removal recovery remains ambiguous",
        { classification: "recovery-ambiguous", cause: error },
      );
      try {
        await lease.release();
      } catch (releaseError) {
        throw new AggregateError(
          [gateError, releaseError],
          "worktree-removal gate failed and its checkout lease could not be released",
        );
      }
      throw gateError;
    }
  };
  return guarded;
}
