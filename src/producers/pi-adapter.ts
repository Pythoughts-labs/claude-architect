import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { supervise } from "../platform/process-supervisor.js";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import {
  normalizeNodeShim,
  normalizePlainText,
  renderProducerPrompt,
  selectOsWriteConfinementBackend,
} from "./plain-text.js";
import type {
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "./producer-adapter.js";

const PI_REQUIRED_ENV = ["PI_API_KEY"] as const;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;

function unavailableReport(
  ctx: ProbeContext,
  reason: string,
  resolvedExecutable: ResolvedExecutable | null = null,
): CapabilityReport {
  return {
    producerId: "pi",
    available: false,
    reason,
    os: ctx.os,
    arch: ctx.arch,
    environmentType: ctx.environmentType,
    resolvedExecutable,
    version: null,
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: false,
    writeConfinementBackend: null,
    laneEligibility: { edit: false },
  };
}

function parseVersion(stdout: string): string | null {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/u.exec(stdout.trim());
  return match?.[1] ?? null;
}

export interface PiAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

function defaultPiEnv(
  deps: Required<Pick<PiAdapterDeps, "env" | "homeDirectory">> & {
    hasConfigDir: (directory: string) => boolean;
  },
): Record<string, string> {
  if (deps.env.HOME !== undefined) return {};
  return deps.hasConfigDir(join(deps.homeDirectory, ".pi"))
    ? { HOME: deps.homeDirectory }
    : {};
}

export class PiAdapter implements ProducerAdapter {
  readonly producerId = "pi";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: PiAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "auth.json"))))(directory);
  }

  private hasConfigDir(directory: string): boolean {
    return existsSync(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    if (ctx.os === "win32") return unavailableReport(ctx, "unsupported-platform");

    let executable: ResolvedExecutable;
    try {
      executable = await normalizeNodeShim(
        await ctx.ps.resolveExecutable({ name: "pi" }),
      );
    } catch {
      return unavailableReport(ctx, "missing-executable");
    }

    try {
      const result = await supervise(ctx.ps, {
        executable,
        args: ["--version"],
        cwd: process.cwd(),
        env: {},
        timeoutMs: VERSION_TIMEOUT_MS,
        maxOutputBytes: VERSION_OUTPUT_LIMIT,
      }, {});
      const version = result.spawnError === undefined && result.exitCode === 0
        ? parseVersion(result.stdout)
        : null;
      if (version === null) return unavailableReport(ctx, "probe-failed", executable);

      const writeConfinementBackend = selectOsWriteConfinementBackend(ctx);
      const authStore = join(this.deps.homeDirectory, ".pi", "agent");
      const authState = this.hasAuthStore(authStore)
        ? "authenticated"
        : "unauthenticated";
      return {
        producerId: this.producerId,
        available: true,
        reason: null,
        os: ctx.os,
        arch: ctx.arch,
        environmentType: ctx.environmentType,
        resolvedExecutable: executable,
        version,
        authState,
        executionModes: [...this.executionModes],
        structuredOutput: this.structuredOutput,
        writeConfinementBackend,
        laneEligibility: { edit: writeConfinementBackend !== null },
      };
    } catch {
      return unavailableReport(ctx, "probe-failed", executable);
    }
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const args = [
      "-p",
      "--no-session",
      "--no-skills",
      "--tools",
      "read,bash,edit,write,grep,find,ls",
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push("--thinking", spec.producerOverrides.reasoningEffort);
    }

    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec),
      requiredEnv: [...PI_REQUIRED_ENV],
      env: defaultPiEnv({
        env: this.deps.env,
        homeDirectory: this.deps.homeDirectory,
        hasConfigDir: directory => this.hasConfigDir(directory),
      }),
      network: "denied",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return normalizePlainText(raw);
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "inherited-config-only",
      credentialSources: ["~/.pi/agent/auth.json"],
      behavioralConfigSources: ["~/.pi/agent/settings.json", "~/.pi/agent/models.json"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...PI_REQUIRED_ENV],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    };
  }
}
