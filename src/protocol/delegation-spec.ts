export interface VerificationCommand {
  id: string;
  executable: string;               // resolved via PlatformServices.resolveExecutable
  args: string[];
  cwd: string;                      // relative to the materialized candidate root
  environment?: Record<string, string>;
  timeoutMs: number;                // bounded by RUNTIME_MAX_TIMEOUT_MS — schema enforces maximum
  network: "denied" | "allowed";
  expectedExitCodes: number[];
  platform?: { os?: Array<"darwin" | "linux" | "win32">; arch?: string[] };
}

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
}

export const RUNTIME_MAX_TIMEOUT_MS = 1_800_000; // 30 min hard ceiling
