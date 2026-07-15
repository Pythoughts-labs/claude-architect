import { git as runGit } from "../git/git-exec.js";
import type { PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import { probeAll as probeProducers } from "../producers/capability-probe.js";
import {
  detectEnvironmentType,
  type CapabilityReport,
  type EnvironmentType,
} from "../producers/producer-adapter.js";
import {
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
} from "../protocol/versions.js";
import { redact } from "../runtime/redaction.js";

export interface DoctorResult {
  node: { version: string; ok: boolean };
  git: { version: string | null; ok: boolean };
  producers: CapabilityReport[];
  runtimeVersion: string;
  schemaVersion: string;
  protocolVersion: string;
  issues: string[];
}

export interface DoctorDependencies {
  ps?: PlatformServices;
  git?: typeof runGit;
  probeAll?: typeof probeProducers;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  arch?: string;
  environmentType?: EnvironmentType;
}

function nodeIsSupported(version: string): boolean {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(major) && major >= 22;
}

function gitVersion(stdout: string): string | null {
  return /^git version ([^\s]+)(?:\s|$)/u.exec(stdout.trim())?.[1] ?? null;
}

export async function doctor(deps: DoctorDependencies = {}): Promise<DoctorResult> {
  const ps = deps.ps ?? getPlatformServices();
  const env = deps.env ?? process.env;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const arch = deps.arch ?? process.arch;
  const environmentType = deps.environmentType ?? detectEnvironmentType();
  const issues: string[] = [];

  const node = { version: nodeVersion, ok: nodeIsSupported(nodeVersion) };
  if (!node.ok) issues.push("unsupported-node-version");
  if (ps.os === "win32") issues.push("unsupported-platform");
  if (!env.CLAUDE_PLUGIN_DATA) issues.push("missing-claude-plugin-data");
  if (env.CLAUDE_ARCHITECT_DELEGATED !== undefined) {
    issues.push("nested-delegation-marker-present");
  }

  let git: DoctorResult["git"] = { version: null, ok: false };
  try {
    const result = await (deps.git ?? runGit)(process.cwd(), ["--version"]);
    const version = result.exitCode === 0 && result.truncated?.stdout !== true
      ? gitVersion(result.stdout)
      : null;
    git = { version, ok: version !== null };
  } catch {
    // The issue code below is the actionable diagnostic; external error text is not exposed.
  }
  if (!git.ok) issues.push("git-unavailable");

  let producers: CapabilityReport[] = [];
  try {
    producers = await (deps.probeAll ?? probeProducers)({
      ps,
      os: ps.os,
      arch,
      environmentType,
    });
    for (const producer of producers) {
      if (!producer.available && producer.reason !== null) {
        issues.push(redact(`producer:${producer.producerId}:${producer.reason}`));
      }
    }
  } catch {
    issues.push("producer-probe-failed");
  }

  return {
    node,
    git,
    producers,
    runtimeVersion: RUNTIME_VERSION,
    schemaVersion: DELEGATION_SPEC_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    issues,
  };
}
