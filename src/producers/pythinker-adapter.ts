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

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const REQUIRED_LONG_OPTIONS = ["--auto", "--prompt", "--model"] as const;

function unavailableReport(
  ctx: ProbeContext,
  reason: string,
  resolvedExecutable: ResolvedExecutable | null = null,
): CapabilityReport {
  return {
    producerId: "pythinker",
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
  return match?.[1] ?? /\d+\.\d+\.\d+(?:[-+][^\s]+)?/u.exec(stdout)?.[0] ?? null;
}

function parseLongOptionTokens(helpText: string): Set<string> {
  const options = new Set<string>();
  for (const line of helpText.split(/\r?\n/u)) {
    const match = /^\s*(?:-[A-Z0-9],\s*)?(--[a-z][a-z0-9-]*)(?=\s|$)/iu.exec(line);
    if (match?.[1] !== undefined) options.add(match[1]);
  }
  return options;
}

export interface PythinkerAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

function defaultPythinkerEnv(
  deps: Required<Pick<PythinkerAdapterDeps, "env" | "homeDirectory">> & {
    hasConfigDir: (directory: string) => boolean;
  },
): Record<string, string> {
  if (deps.env.HOME !== undefined) return {};
  return deps.hasConfigDir(join(deps.homeDirectory, ".pythinker"))
    ? { HOME: deps.homeDirectory }
    : {};
}

export class PythinkerAdapter implements ProducerAdapter {
  readonly producerId = "pythinker";
  readonly structuredOutput = false;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: PythinkerAdapterDeps = {
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
        await ctx.ps.resolveExecutable({ name: "pythinker" }),
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

      let helpResult;
      try {
        helpResult = await supervise(ctx.ps, {
          executable,
          args: ["--help"],
          cwd: process.cwd(),
          env: {},
          timeoutMs: VERSION_TIMEOUT_MS,
          maxOutputBytes: VERSION_OUTPUT_LIMIT,
        }, {});
      } catch {
        return unavailableReport(ctx, "unsupported-cli-surface", executable);
      }
      const options = parseLongOptionTokens(
        `${helpResult.stdout}\n${helpResult.stderr}`,
      );
      if (
        helpResult.spawnError !== undefined
        || helpResult.exitCode !== 0
        || REQUIRED_LONG_OPTIONS.some(option => !options.has(option))
      ) {
        return unavailableReport(ctx, "unsupported-cli-surface", executable);
      }

      const writeConfinementBackend = selectOsWriteConfinementBackend(ctx);
      const authStore = join(this.deps.homeDirectory, ".pythinker");
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
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      throw new Error(
        "Pythinker reasoningEffort override is unsupported by pythinker-code 0.5.1.",
      );
    }

    const args = [
      "--auto",
      "--prompt",
      renderProducerPrompt(spec, ctx.readOnly === true),
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    return {
      executable: ctx.executable,
      args,
      requiredEnv: [],
      env: defaultPythinkerEnv({
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
      credentialSources: ["~/.pythinker/auth.json"],
      behavioralConfigSources: ["~/.pythinker/config.toml"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [],
      temporaryHomeStrategy: "real HOME inherited by declared policy; reduced reproducibility recorded in the Run Manifest",
    };
  }
}
