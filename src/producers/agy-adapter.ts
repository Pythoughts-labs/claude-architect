import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { supervise } from "../platform/process-supervisor.js";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import {
  normalizeNodeShim,
  renderProducerPrompt,
  selectOsWriteConfinementBackend,
} from "./plain-text.js";
import type {
  AdapterEvent,
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "./producer-adapter.js";

const AGY_REQUIRED_ENV = ["GEMINI_API_KEY"] as const;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;
const TEXT_LIMIT = 8_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[name];
  return typeof property === "string" ? property : undefined;
}

function unavailableReport(
  ctx: ProbeContext,
  reason: string,
  resolvedExecutable: ResolvedExecutable | null = null,
): CapabilityReport {
  return {
    producerId: "agy",
    available: false,
    reason,
    os: ctx.os,
    arch: ctx.arch,
    environmentType: ctx.environmentType,
    resolvedExecutable,
    version: null,
    authState: "unknown",
    executionModes: ["edit"],
    structuredOutput: true,
    writeConfinementBackend: null,
    laneEligibility: { edit: false },
  };
}

function parseVersion(stdout: string): string | null {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][^\s]+)?)(?:\s|$)/u.exec(stdout.trim());
  return match?.[1] ?? null;
}

/** Go time.ParseDuration accepts a bare seconds-magnitude unit; keep it simple. */
function formatPrintTimeout(timeoutMs: number): string {
  return `${Math.ceil(timeoutMs / 1000)}s`;
}

export interface AgyAdapterDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore?: (directory: string) => boolean;
}

export class AgyAdapter implements ProducerAdapter {
  readonly producerId = "agy";
  readonly structuredOutput = true;
  readonly executionModes = ["edit"];

  constructor(private readonly deps: AgyAdapterDeps = {
    env: process.env,
    homeDirectory: homedir(),
  }) {}

  private hasAuthStore(directory: string): boolean {
    return (this.deps.hasAuthStore ?? (store => existsSync(join(store, "settings.json"))))(directory);
  }

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    if (ctx.os === "win32") return unavailableReport(ctx, "unsupported-platform");

    let executable: ResolvedExecutable;
    try {
      executable = await normalizeNodeShim(
        await ctx.ps.resolveExecutable({ name: "agy" }),
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
      const authStore = join(this.deps.homeDirectory, ".gemini", "antigravity-cli");
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
      renderProducerPrompt(spec, ctx.readOnly === true),
      "--add-dir",
      ctx.worktreePath,
      "--new-project",
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      formatPrintTimeout(spec.timeoutMs),
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push("--effort", spec.producerOverrides.reasoningEffort);
    }

    return {
      executable: ctx.executable,
      args,
      requiredEnv: [...AGY_REQUIRED_ENV],
      // Model sessions must reach the provider API; write-protection remains the confinement goal.
      network: "allowed",
    };
  }

  normalizeEvents(
    raw: Parameters<ProducerAdapter["normalizeEvents"]>[0],
  ): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout) {
      return { events: [], producerSummary: null, ok: false };
    }
    if (raw.exit.exitCode !== 0) {
      return {
        events: [{ kind: "error", text: raw.stderr.slice(-TEXT_LIMIT) }],
        producerSummary: null,
        ok: false,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.stdout.trim());
    } catch {
      return { events: [], producerSummary: null, ok: false };
    }
    if (!isRecord(parsed) || typeof parsed.status !== "string") {
      return { events: [], producerSummary: null, ok: false };
    }

    const response = stringProperty(parsed, "response");
    const ok = parsed.status === "SUCCESS";
    if (ok) {
      if (response === undefined) return { events: [], producerSummary: null, ok: false };
      const events: AdapterEvent[] = [{ kind: "final", text: response, raw: parsed }];
      return { events, producerSummary: response, ok: true };
    }
    const events: AdapterEvent[] = [{
      kind: "error",
      ...(response === undefined ? {} : { text: response }),
      raw: parsed,
    }];
    return { events, producerSummary: null, ok: false };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "inherited-config-only",
      credentialSources: [
        "macOS Keychain (\"Antigravity IDE Safe Storage\")",
        "GEMINI_API_KEY (optional, unconfirmed CI semantics)",
      ],
      behavioralConfigSources: ["~/.gemini/antigravity-cli/settings.json", "explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...AGY_REQUIRED_ENV],
      temporaryHomeStrategy:
        "real HOME inherited by declared policy (keyring auth is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest",
    };
  }
}
