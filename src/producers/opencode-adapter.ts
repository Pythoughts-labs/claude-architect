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

const OPENCODE_REQUIRED_ENV = ["OPENCODE_CONFIG_DIR", "XDG_DATA_HOME"] as const;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;

function unavailableReport(
  ctx: ProbeContext,
  reason: string,
  resolvedExecutable: ResolvedExecutable | null = null,
): CapabilityReport {
  return {
    producerId: "opencode",
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

export interface OpenCodeAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

function defaultOpenCodeEnv(
  deps: Required<Pick<OpenCodeAdapterDeps, "env" | "homeDirectory" | "hasAuthStore">>,
): Record<string, string> {
  if (deps.env.XDG_DATA_HOME !== undefined) return {};
  const dataHome = join(deps.homeDirectory, ".local", "share");
  return deps.hasAuthStore(join(dataHome, "opencode"))
    ? { XDG_DATA_HOME: dataHome }
    : {};
}

export class OpenCodeAdapter implements ProducerAdapter {
  readonly producerId = "opencode";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: OpenCodeAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "auth.json"))))(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    if (ctx.os === "win32") return unavailableReport(ctx, "unsupported-platform");

    let executable: ResolvedExecutable;
    try {
      executable = await normalizeNodeShim(
        await ctx.ps.resolveExecutable({ name: "opencode" }),
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
      const authStore = join(this.deps.homeDirectory, ".local", "share", "opencode");
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
      "run",
      "--dir",
      ctx.worktreePath,
      "--agent",
      "build",
      "--auto",
      "--log-level",
      "ERROR",
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }

    return {
      executable: ctx.executable,
      args,
      stdin: renderProducerPrompt(spec, ctx.readOnly === true),
      requiredEnv: [...OPENCODE_REQUIRED_ENV],
      env: defaultOpenCodeEnv({
        env: this.deps.env,
        homeDirectory: this.deps.homeDirectory,
        hasAuthStore: directory => this.hasAuthStore(directory),
      }),
      // Model sessions must reach the provider API; write-protection remains the confinement goal.
      network: "allowed",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    return normalizePlainText(raw);
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-with-copied-credentials",
      credentialSources: ["~/.local/share/opencode/auth.json"],
      behavioralConfigSources: ["explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...OPENCODE_REQUIRED_ENV],
      temporaryHomeStrategy: "temp HOME with XDG_DATA_HOME passthrough for the auth store",
    };
  }
}
