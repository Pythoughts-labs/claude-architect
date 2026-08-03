import {
  persistWorktreeRemovalManifest,
  removeWorktreeRemovalManifest,
  replaceWorktreeRemovalManifest,
  type WorktreeRemovalManifest,
} from "./worktree-removal-manifest.js";

export interface StagedWorktreeRegistration {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface WorktreeRemovalCoordination {
  transaction: Omit<WorktreeRemovalManifest, "manifestVersion" | "phase">;
  stageRegistration(): Promise<StagedWorktreeRegistration>;
  stageFailureWasRolledBack(): Promise<boolean>;
  removePhysical(markRemovalStarted: () => Promise<void>): Promise<void>;
  physicalIsUnchanged(): Promise<boolean>;
}

async function rollbackPrecommit(
  manifestPath: string,
  transactionId: string,
  staged: StagedWorktreeRegistration,
  primaryError: unknown,
): Promise<never> {
  try {
    await staged.rollback();
    await removeWorktreeRemovalManifest(manifestPath, transactionId);
  } catch (rollbackError) {
    throw new AggregateError(
      [primaryError, rollbackError],
      "worktree removal failed before commit and its rollback did not complete",
    );
  }
  throw primaryError;
}

export async function coordinateWorktreeRemoval(
  coordination: WorktreeRemovalCoordination,
): Promise<void> {
  let manifest: WorktreeRemovalManifest = {
    manifestVersion: "1",
    phase: "registration-intent",
    ...coordination.transaction,
  };
  const manifestPath = await persistWorktreeRemovalManifest(manifest);
  let staged: StagedWorktreeRegistration;
  try {
    staged = await coordination.stageRegistration();
  } catch (stageError) {
    let rolledBack: boolean;
    try {
      rolledBack = await coordination.stageFailureWasRolledBack();
    } catch (observationError) {
      throw new AggregateError(
        [stageError, observationError],
        "worktree registration staging failed and rollback state is ambiguous",
      );
    }
    if (rolledBack) {
      try {
        await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
      } catch (manifestError) {
        throw new AggregateError(
          [stageError, manifestError],
          "worktree registration staging failed and its manifest could not be removed",
        );
      }
    }
    throw stageError;
  }

  try {
    manifest = { ...manifest, phase: "registration-staged" };
    await replaceWorktreeRemovalManifest(manifestPath, manifest);
    manifest = { ...manifest, phase: "physical-removal-intent" };
    await replaceWorktreeRemovalManifest(manifestPath, manifest);
    await coordination.removePhysical(async () => {
      const removalStarted: WorktreeRemovalManifest = {
        ...manifest,
        phase: "physical-removal-started",
      };
      await replaceWorktreeRemovalManifest(manifestPath, removalStarted);
      manifest = removalStarted;
    });
  } catch (precommitError) {
    if (manifest.phase === "physical-removal-started") throw precommitError;
    let unchanged: boolean;
    try {
      unchanged = await coordination.physicalIsUnchanged();
    } catch (observationError) {
      throw new AggregateError(
        [precommitError, observationError],
        "worktree removal failed and physical rollback state is ambiguous",
      );
    }
    if (unchanged) {
      return await rollbackPrecommit(
        manifestPath,
        manifest.transactionId,
        staged,
        precommitError,
      );
    }
    throw precommitError;
  }

  manifest = { ...manifest, phase: "physical-removed" };
  await replaceWorktreeRemovalManifest(manifestPath, manifest);
  await staged.commit();
  await removeWorktreeRemovalManifest(manifestPath, manifest.transactionId);
}
