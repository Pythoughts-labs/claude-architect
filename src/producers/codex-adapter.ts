import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { supervise } from "../platform/process-supervisor.js";
import type { ResolvedExecutable } from "../platform/platform-services.js";
import { SANDBOX_BACKENDS } from "../platform/sandbox/backends.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type {
  AdapterEvent,
  CapabilityReport,
  InvocationContext,
  ProbeContext,
  ProducerAdapter,
  ProducerConfigurationProfile,
  ProducerInvocation,
} from "./producer-adapter.js";

const CODEX_REQUIRED_ENV = [
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
] as const;
const MULTI_AGENT_CONTROL =
  "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}";
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 64 * 1024;

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
    producerId: "codex",
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

function selectCodexWriteConfinementBackend(ctx: ProbeContext): string | null {
  const backend = SANDBOX_BACKENDS.find(candidate =>
    candidate.id === "codex-native-sandbox"
    && candidate.platforms.some(platform =>
      platform.os === ctx.os
      && platform.environmentType === ctx.environmentType
      && (platform.arch === undefined || platform.arch === ctx.arch)
      && (platform.state === "certified" || platform.state === "tested")));
  return backend?.id ?? null;
}

async function normalizeCodexExecutable(
  executable: ResolvedExecutable,
): Promise<ResolvedExecutable> {
  if (executable.kind !== "native") return executable;
  let handle;
  try {
    handle = await open(executable.command, "r");
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
    if (!/^#![^\r\n]*\bnode(?:\s|$)/u.test(firstLine)) return executable;
    return {
      kind: "node-entrypoint",
      command: process.execPath,
      prefixArgs: [executable.command, ...executable.prefixArgs],
      resolvedFrom: `${executable.resolvedFrom};node:${process.execPath}`,
    };
  } catch {
    return executable;
  } finally {
    await handle?.close();
  }
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function renderList(values: string[]): string {
  return values.length === 0 ? "- (none)" : values.map(value => `- ${value}`).join("\n");
}

function renderPrompt(spec: DelegationSpec): string {
  return [
    "You are an untrusted implementation Producer operating inside an isolated worktree.",
    "Do not delegate to other agents or expand the authorized scope.",
    "",
    "Objective:",
    spec.objective,
    "",
    "Context:",
    spec.context,
    "",
    "Authorized write allowlist:",
    renderList(spec.writeAllowlist),
    "",
    "Forbidden scope:",
    renderList(spec.forbiddenScope),
    "",
    "Success criteria:",
    renderList(spec.successCriteria),
    "",
    "Make only the requested edits. Return a concise final summary of the work performed.",
  ].join("\n");
}

export interface DefaultCodexEnvDeps {
  env: Record<string, string | undefined>;
  homeDirectory: string;
  hasAuthStore: (directory: string) => boolean;
}

/**
 * The isolated per-attempt HOME hides the host `~/.codex` auth store. When the
 * Host has not set CODEX_HOME explicitly, default it to the real auth store so
 * Codex authentication survives HOME isolation.
 */
export function defaultCodexEnv(deps: DefaultCodexEnvDeps): Record<string, string> {
  if (deps.env.CODEX_HOME !== undefined) return {};
  const store = join(deps.homeDirectory, ".codex");
  return deps.hasAuthStore(store) ? { CODEX_HOME: store } : {};
}

export class CodexAdapter implements ProducerAdapter {
  readonly producerId = "codex";

  async probe(ctx: ProbeContext): Promise<CapabilityReport> {
    if (ctx.os === "win32") return unavailableReport(ctx, "unsupported-platform");

    let executable: ResolvedExecutable;
    try {
      executable = await normalizeCodexExecutable(
        await ctx.ps.resolveExecutable({ name: "codex" }),
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

      const writeConfinementBackend = selectCodexWriteConfinementBackend(ctx);
      return {
        producerId: this.producerId,
        available: true,
        reason: null,
        os: ctx.os,
        arch: ctx.arch,
        environmentType: ctx.environmentType,
        resolvedExecutable: executable,
        version,
        authState: "unknown",
        executionModes: ["edit"],
        structuredOutput: true,
        writeConfinementBackend,
        laneEligibility: { edit: writeConfinementBackend !== null },
      };
    } catch {
      return unavailableReport(ctx, "probe-failed", executable);
    }
  }

  buildInvocation(spec: DelegationSpec, ctx: InvocationContext): ProducerInvocation {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable",
      "multi_agent",
      "-c",
      MULTI_AGENT_CONTROL,
      "-c",
      'approval_policy="never"',
      "-c",
      "sandbox_workspace_write.network_access=false",
      "-c",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c",
      "sandbox_workspace_write.exclude_slash_tmp=true",
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_ALL","CLAUDE_ARCHITECT_DELEGATED"]',
      "-c",
      'web_search="disabled"',
      "--cd",
      ctx.worktreePath,
    ];
    if (spec.producerOverrides?.model !== undefined) {
      args.push("--model", spec.producerOverrides.model);
    }
    if (spec.producerOverrides?.reasoningEffort !== undefined) {
      args.push(
        "-c",
        `model_reasoning_effort=${quoteTomlString(spec.producerOverrides.reasoningEffort)}`,
      );
    }
    args.push("-");

    return {
      executable: ctx.executable,
      args,
      stdin: renderPrompt(spec),
      requiredEnv: [...CODEX_REQUIRED_ENV],
      env: defaultCodexEnv({
        env: process.env,
        homeDirectory: homedir(),
        hasAuthStore: directory => existsSync(join(directory, "auth.json")),
      }),
      network: "denied",
    };
  }

  normalizeEvents(raw: {
    stdout: string;
    stderr: string;
    exit: Parameters<ProducerAdapter["normalizeEvents"]>[0]["exit"];
  }): ReturnType<ProducerAdapter["normalizeEvents"]> {
    if (raw.exit.truncated.stdout) {
      return { events: [], producerSummary: null, ok: false };
    }
    const lines = raw.stdout.split(/\r?\n/u).filter(line => line.trim().length > 0);
    if (lines.length === 0) return { events: [], producerSummary: null, ok: false };

    const events: AdapterEvent[] = [];
    let producerSummary: string | null = null;
    let completed = false;
    let failed = false;
    try {
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
          return { events: [], producerSummary: null, ok: false };
        }
        if (parsed.type === "turn.completed") {
          completed = true;
          continue;
        }
        if (parsed.type === "error" || parsed.type === "turn.failed") {
          failed = true;
          const text = stringProperty(parsed, "message")
            ?? stringProperty(parsed.error, "message");
          events.push({
            kind: "error",
            ...(text === undefined ? {} : { text }),
            raw: parsed,
          });
          continue;
        }
        if (parsed.type !== "item.completed") continue;
        const item = parsed.item;
        const itemType = stringProperty(item, "type");
        if (itemType === "agent_message") {
          const text = stringProperty(item, "text");
          if (text === undefined) return { events: [], producerSummary: null, ok: false };
          producerSummary = text;
          events.push({ kind: "final", text, raw: parsed });
        } else if (itemType !== undefined) {
          events.push({ kind: "tool", raw: parsed });
        }
      }
    } catch {
      return { events: [], producerSummary: null, ok: false };
    }

    return {
      events,
      producerSummary,
      ok: completed && !failed && producerSummary !== null,
    };
  }

  configurationProfile(): ProducerConfigurationProfile {
    return {
      isolationState: "controlled-config-supported",
      credentialSources: [
        "CODEX_HOME auth store",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "operating-system credential store",
      ],
      behavioralConfigSources: ["explicit invocation argv"],
      repositoryInstructionSources: ["worktree AGENTS.md"],
      environmentDependencies: [...CODEX_REQUIRED_ENV],
      temporaryHomeStrategy:
        "use a per-attempt HOME while preserving CODEX_HOME for auth; ignore user config and rules",
    };
  }
}
