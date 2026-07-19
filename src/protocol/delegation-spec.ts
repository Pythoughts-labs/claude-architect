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
  /** "ignored-paths" permits Git-ignored byproducts (e.g. dependency installs); default "none". */
  allowedMutations?: "none" | "ignored-paths";
  platform?: { os?: Array<"darwin" | "linux" | "win32">; arch?: string[] };
}

export interface Slice {
  objective: string;
  context: string;
  writeAllowlist: string[];
  forbiddenScope: string[];
  successCriteria: string[];
  verification: VerificationCommand[];
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

export const RUNTIME_MAX_TIMEOUT_MS = 1_800_000; // 30 min hard ceiling
export const RUNTIME_MIN_EDIT_TIMEOUT_MS = 600_000; // 10 min edit-run floor
