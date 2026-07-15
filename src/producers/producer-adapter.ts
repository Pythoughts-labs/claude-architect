import { readFileSync } from "node:fs";
import type {
  PlatformServices,
  ResolvedExecutable,
  SupervisedExit,
} from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";

export type PlatformState = "certified" | "tested" | "conditional" | "unsupported" | "unknown";
export type EnvironmentType = "native" | "wsl";

export interface CapabilityReport {
  producerId: string;
  available: boolean;
  reason: string | null;
  os: "darwin" | "linux" | "win32";
  arch: string;
  environmentType: EnvironmentType;
  resolvedExecutable: ResolvedExecutable | null;
  version: string | null;
  authState: "authenticated" | "unauthenticated" | "unknown";
  executionModes: string[];
  structuredOutput: boolean;
  writeConfinementBackend: string | null;
  laneEligibility: Record<string, boolean>;
}

export interface AdapterEvent {
  kind: "message" | "tool" | "error" | "final";
  text?: string;
  raw?: unknown;
}

export interface ProducerInvocation {
  executable: ResolvedExecutable;
  args: string[];
  stdin?: string;
  requiredEnv: string[];
  network: "denied" | "allowed";
}

export interface ProbeContext {
  ps: PlatformServices;
  os: "darwin" | "linux" | "win32";
  arch: string;
  environmentType: EnvironmentType;
}

export interface InvocationContext {
  worktreePath: string;
  runId: string;
  tempHome?: string;
  capabilityReport: CapabilityReport;
  executable: ResolvedExecutable;
}

export interface ProducerAdapter {
  producerId: string;
  probe(ctx: ProbeContext): Promise<CapabilityReport>;
  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation;
  normalizeEvents(raw: { stdout: string; stderr: string; exit: SupervisedExit }): {
    events: AdapterEvent[];
    producerSummary: string | null;
    ok: boolean;
  };
  configurationProfile(): ProducerConfigurationProfile;
}

export type ProducerConfigurationProfile = {
  isolationState:
    | "controlled-config-supported"
    | "controlled-config-with-copied-credentials"
    | "inherited-config-only"
    | "configuration-isolation-unsupported";
  credentialSources: string[];
  behavioralConfigSources: string[];
  repositoryInstructionSources: string[];
  environmentDependencies: string[];
  temporaryHomeStrategy: string;
};

export function detectEnvironmentType(): EnvironmentType {
  if (process.platform !== "linux") return "native";
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft")
      ? "wsl"
      : "native";
  } catch {
    return "native";
  }
}
