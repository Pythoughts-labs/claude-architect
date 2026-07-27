export interface VerificationCommand {
  id: string;
  executable: string;               // resolved via PlatformServices.resolveExecutable
  args: string[];
  cwd: string;                      // relative to the materialized candidate root
  environment?: Record<string, string>;
  timeoutMs: number;                // bounded by RUNTIME_MAX_TIMEOUT_MS — schema enforces maximum
  network: "denied" | "allowed";
  expectedExitCodes: number[];
  expectBaselineFailure?: boolean;    // tolerate this command failing only on clean HEAD
  /**
   * Exit codes that count as the *intended* baseline failure. Without it any
   * completed non-zero exit satisfies `expectBaselineFailure`, so a missing test
   * file (pytest exit 4) proves the same thing as a test that ran and asserted
   * false. Naming the codes turns the flag into a semantic RED proof.
   */
  baselineFailureExitCodes?: number[];
  /** "ignored-paths" permits Git-ignored byproducts (e.g. dependency installs); default "none". */
  allowedMutations?: "none" | "ignored-paths";
  platform?: { os?: Array<"darwin" | "linux" | "win32">; arch?: string[] };
}

export interface Slice {
  objective: string;
  context: string;
  writeAllowlist: string[];
  allowedTestDeletions?: string[];
  forbiddenScope: string[];
  successCriteria: string[];
  verification: VerificationCommand[];
  /**
   * 1-based indices of the slices this slice must observe before it runs.
   * Omitted means every preceding slice, which reproduces sequential execution
   * exactly — parallelism is opt-in and under-declaration fails at the final
   * composed verification rather than shipping.
   */
  dependsOn?: number[];
}

export type ReviewerKind = "correctness" | "systems";

export interface ReviewConfig {
  reviewers: ReviewerKind[];
  maxRounds: number;
  focus?: string[];
  perSlice?: boolean;
}

export interface ImplementationConfig {
  maxIncrements: number;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  reviewers: ["correctness", "systems"],
  maxRounds: 2,
};

export const DEFAULT_IMPLEMENTATION_CONFIG: ImplementationConfig = {
  maxIncrements: 1,
};

export interface DelegationSpec {
  specVersion: "1";
  objective: string;                         // observable outcome
  context: string;                           // relevant background for the Producer
  writeAllowlist: string[];                  // positive path globs; repo-wide MUST be explicit ["**"]
  allowedTestDeletions?: string[];           // test-file deletion globs explicitly authorized by the architect
  forbiddenScope: string[];                  // path globs never to touch
  successCriteria: string[];
  verification: VerificationCommand[];       // Host-authorized checks only
  executionMode: "edit";                     // P0: implementation Lane only
  timeoutMs: number;                         // wall-clock; bounded by RUNTIME_MAX_TIMEOUT_MS
  producerPreferences: string[];             // ordered producer ids, e.g. ["codex"]
  producerOverrides?: { model?: string; reasoningEffort?: string };
  expectedOutput: "candidate-patch";         // P0 canonical output
  review?: ReviewConfig;
  implementation?: ImplementationConfig;
  slices?: Slice[];
  sliceConcurrency?: number;
}

export function resolveReviewConfig(spec: DelegationSpec): ReviewConfig {
  return spec.review ?? DEFAULT_REVIEW_CONFIG;
}

export function resolveImplementationConfig(spec: DelegationSpec): ImplementationConfig {
  return spec.implementation ?? DEFAULT_IMPLEMENTATION_CONFIG;
}

export function resolveSlices(spec: DelegationSpec): Slice[] {
  return spec.slices ?? [];
}

export const DEFAULT_SLICE_CONCURRENCY = 1;

export function resolveSliceConcurrency(spec: DelegationSpec): number {
  return spec.sliceConcurrency ?? DEFAULT_SLICE_CONCURRENCY;
}

/** Dependencies of slice `index` (1-based), defaulting to every preceding slice. */
export function resolveSliceDependencies(slices: Slice[], index: number): number[] {
  const declared = slices[index - 1]?.dependsOn;
  if (declared === undefined) {
    return Array.from({ length: index - 1 }, (_, offset) => offset + 1);
  }
  return [...declared].sort((left, right) => left - right);
}

export const RUNTIME_MAX_TIMEOUT_MS = 1_800_000; // 30 min hard ceiling
export const RUNTIME_MIN_EDIT_TIMEOUT_MS = 600_000; // 10 min edit-run floor
