import { rm } from "node:fs/promises";
import type { PlatformServices, SupervisedExit } from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import { selectOsWriteConfinementBackend } from "../producers/plain-text.js";
import {
  buildReadOnlySeatbeltPolicy,
  buildWriteSeatbeltPolicy,
  wrapInvocationWithSeatbelt,
} from "../platform/sandbox/seatbelt.js";
import {
  classifyFailure,
  type FailureClassification,
  type FailureSignals,
} from "../protocol/attempt-result.js";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { probeAll } from "../producers/capability-probe.js";
import { detectEnvironmentType } from "../producers/producer-adapter.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";
import { route } from "../producers/routing-policy.js";
import { buildEnvironment } from "../runtime/environment-policy.js";
import { redact } from "../runtime/redaction.js";
import {
  buildRoleSpec,
  type PipelineRole,
  type RolePackage,
} from "./role-prompts.js";
import { resolveLinkedWorktreeWritableRoots } from "./git-writable-roots.js";

export interface RoleRunArgs {
  role: PipelineRole;
  baseSpec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;
  ps: PlatformServices;
  registry: ProducerRegistry;
  runId: string;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}

export interface RoleRunResult {
  ok: boolean;
  rawOutput: string;
  archiveSafeRawOutput?: string;
  failure: FailureClassification | null;
  producerId: string | null;
}

const READ_ONLY_ROLES = new Set<PipelineRole>([
  "reviewer-correctness",
  "reviewer-systems",
  "verifier",
]);
const MAX_PRODUCER_OUTPUT_BYTES = 1_000_000;

function preCancelledExit(): SupervisedExit {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    cancelled: true,
    stdout: "",
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}

function definedEnvironment(
  environment: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const additions: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) {
    if (value === undefined) continue;
    Object.defineProperty(additions, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return additions;
}

function failureSignals(exit: SupervisedExit): FailureSignals {
  const signals: FailureSignals = {};
  if (exit.spawnError !== undefined) signals["spawn-failure"] = true;
  if (exit.cancelled) signals.cancelled = true;
  if (exit.timedOut) signals.timeout = true;
  return signals;
}

function hasFailureSignal(signals: FailureSignals): boolean {
  return Object.values(signals).some(Boolean);
}

async function cleanupProcessAttempt(
  tempHome: string | null,
  builtEnvironment: ReturnType<typeof buildEnvironment> | null,
): Promise<unknown | null> {
  const failures: unknown[] = [];
  try {
    builtEnvironment?.secretRegistration.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (tempHome !== null) {
    try {
      await rm(tempHome, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures[0] ?? null;
}

export async function runRole(args: RoleRunArgs): Promise<RoleRunResult> {
  const roleSpec = buildRoleSpec(args.role, args.baseSpec, args.pkg);
  const reports = await probeAll({
    ps: args.ps,
    os: args.ps.os,
    arch: process.arch,
    environmentType: detectEnvironmentType(),
  }, args.registry);
  const routing = route(roleSpec.producerPreferences, reports);
  if (routing.producerId === null) {
    return {
      ok: false,
      rawOutput: "",
      failure: routing.reason === "authentication-required"
        ? "authentication-required"
        : "unavailable",
      producerId: null,
    };
  }

  const producerId = routing.producerId;
  const adapter = args.registry.get(producerId);
  const report = reports.find(candidate => candidate.producerId === producerId);
  if (adapter === undefined || report === undefined || report.resolvedExecutable === null) {
    return {
      ok: false,
      rawOutput: "",
      failure: "unavailable",
      producerId,
    };
  }

  const readOnly = READ_ONLY_ROLES.has(args.role);
  const fixer = args.role === "fixer";
  let extraWritableRoots: string[] = [];
  if (fixer) {
    try {
      extraWritableRoots = await resolveLinkedWorktreeWritableRoots(args.worktreePath);
    } catch {
      return {
        ok: false,
        rawOutput: "",
        failure: "sandbox-violation",
        producerId,
      };
    }
  }
  // Producers with a native sandbox (Codex) must confine read-only roles
  // themselves: wrapping them in an outer Seatbelt profile EPERM-crashes their
  // internal sandbox init. Producers without one get the HOST's read-only
  // Seatbelt wrap, so that path's availability is a host property.
  const nativeReadOnly = readOnly
    && selectSandboxBackend(report).backend?.kind === "producer-native";
  const fixerBackend = fixer ? selectSandboxBackend(report).backend : null;
  const seatbeltFixer = fixerBackend?.kind === "os"
    && fixerBackend.id === "macos-seatbelt";
  if (fixer && (fixerBackend === null
    || (fixerBackend.kind === "os" && !seatbeltFixer))) {
    return {
      ok: false,
      rawOutput: "",
      failure: "sandbox-violation",
      producerId,
    };
  }
  if (readOnly && !nativeReadOnly) {
    const osBackend = selectOsWriteConfinementBackend({
      ps: args.ps,
      os: args.ps.os,
      arch: process.arch,
      environmentType: detectEnvironmentType(),
    });
    if (osBackend === null) {
      return {
        ok: false,
        rawOutput: "",
        failure: "sandbox-violation",
        producerId,
      };
    }
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let tempHome: string | null = null;
    let builtEnvironment: ReturnType<typeof buildEnvironment> | null = null;
    let primaryError: unknown;
    try {
      tempHome = await args.ps.createSecureTempDirectory();
      let invocation = adapter.buildInvocation(roleSpec, {
        worktreePath: args.worktreePath,
        ...(extraWritableRoots.length === 0 ? {} : { extraWritableRoots }),
        runId: args.runId,
        tempHome,
        capabilityReport: report,
        executable: report.resolvedExecutable,
        readOnly: nativeReadOnly,
      });
      if (readOnly && !nativeReadOnly) {
        invocation = wrapInvocationWithSeatbelt(
          invocation,
          buildReadOnlySeatbeltPolicy({ tempHome }),
        );
      } else if (seatbeltFixer) {
        invocation = wrapInvocationWithSeatbelt(
          invocation,
          buildWriteSeatbeltPolicy({
            worktreePath: args.worktreePath,
            tempHome,
            extraWritableRoots,
          }),
        );
      }
      builtEnvironment = buildEnvironment({
        os: args.ps.os,
        adapterAllowlist: invocation.requiredEnv,
        ...(invocation.env === undefined ? {} : { adapterValues: invocation.env }),
        specAdditions: definedEnvironment(args.env),
        tempHome,
      });
      const exit = args.abortSignal?.aborted === true
        ? preCancelledExit()
        : await supervise(args.ps, {
          executable: invocation.executable,
          args: invocation.args,
          cwd: args.worktreePath,
          env: builtEnvironment.env,
          timeoutMs: roleSpec.timeoutMs,
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          maxOutputBytes: MAX_PRODUCER_OUTPUT_BYTES,
        }, args.abortSignal === undefined ? {} : { onCancel: args.abortSignal });

      const signals = failureSignals(exit);
      let rawOutput = exit.stdout;
      if (!hasFailureSignal(signals)) {
        const normalized = adapter.normalizeEvents({
          stdout: exit.stdout,
          stderr: exit.stderr,
          exit,
        });
        rawOutput = normalized.producerSummary ?? exit.stdout;
        if (!normalized.ok) signals["invalid-output"] = true;
        if (exit.exitCode !== 0) signals["producer-failure"] = true;
      }

      const failure = classifyFailure(signals);
      const archiveSafeRawOutput = rawOutput === ""
        ? {}
        : { archiveSafeRawOutput: redact(rawOutput) };
      if (failure === null) {
        return { ok: true, rawOutput, ...archiveSafeRawOutput, failure: null, producerId };
      }
      if (exit.cancelled || attempt === 2) {
        return { ok: false, rawOutput, ...archiveSafeRawOutput, failure, producerId };
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const cleanupError = await cleanupProcessAttempt(tempHome, builtEnvironment);
      if (primaryError === undefined && cleanupError !== null) throw cleanupError;
    }
  }

  throw new Error("unreachable role attempt state");
}
