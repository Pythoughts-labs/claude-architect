import { createHash } from "node:crypto";
import {
  ATTEMPT_RESULT_VERSION,
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
} from "../protocol/versions.js";
import type { EnvProvenance } from "./environment-policy.js";
import { redact, redactRecord, redactValues } from "./redaction.js";

export interface RunManifestProducer {
  id: string | null;
  version: string | null;
  model: string | null;
}

export interface RepositoryInstructionInput {
  path: string;
  content: string;
}

export interface RepositoryInstructionRecord {
  path: string;
  hash: string;
}

export interface PackagedVerifierInput {
  version: string;
  content: string;
}

export interface RunManifest {
  manifestVersion: "1";
  runId: string;
  repoRoot: string;
  baseCommitOid: string;
  candidateManifestHash: string | null;
  producer: RunManifestProducer;
  effectivePolicy: Record<string, unknown>;
  repositoryInstructions: RepositoryInstructionRecord[];
  promptHash: string;
  executionPolicy: Record<string, unknown>;
  environment: Array<{ name: string; source: string }>;
  runtimeVersion: typeof RUNTIME_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  schemaVersions: {
    delegationSpec: typeof DELEGATION_SPEC_VERSION;
    attemptResult: typeof ATTEMPT_RESULT_VERSION;
  };
  packagedVerifier: {
    version: string;
    hash: string;
  };
  manifestHash: string;
}

export interface BuildRunManifestArgs {
  runId: string;
  repoRoot: string;
  baseCommitOid: string;
  candidateManifestHash: string | null;
  producer: RunManifestProducer;
  effectivePolicy: Record<string, unknown>;
  repositoryInstructions: RepositoryInstructionInput[];
  prompt: string;
  executionPolicy: Record<string, unknown>;
  environment: EnvProvenance;
  packagedVerifier: PackagedVerifierInput;
}

type ManifestBody = Omit<RunManifest, "manifestHash">;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(compareText)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = canonicalize(child);
  }
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function withManifestHash(body: ManifestBody): RunManifest {
  const sanitized = redactValues(body);
  sanitized.effectivePolicy = redactRecord(body.effectivePolicy);
  sanitized.executionPolicy = redactRecord(body.executionPolicy);
  return {
    ...sanitized,
    manifestHash: sha256(stableJson(sanitized)),
  };
}

export function sanitizeRunManifest(manifest: RunManifest): RunManifest {
  const { manifestHash: _manifestHash, ...body } = manifest;
  return withManifestHash(body);
}

export function buildRunManifest(args: BuildRunManifestArgs): RunManifest {
  const body: ManifestBody = {
    manifestVersion: "1",
    runId: redact(args.runId),
    repoRoot: redact(args.repoRoot),
    baseCommitOid: args.baseCommitOid,
    candidateManifestHash: args.candidateManifestHash,
    producer: redactRecord(args.producer),
    effectivePolicy: redactRecord(args.effectivePolicy),
    repositoryInstructions: args.repositoryInstructions
      .map(instruction => ({
        path: redact(instruction.path),
        hash: sha256(instruction.content),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    promptHash: sha256(args.prompt),
    executionPolicy: redactRecord(args.executionPolicy),
    environment: args.environment
      .map(entry => ({ name: redact(entry.name), source: redact(entry.source) }))
      .sort((left, right) => {
        const nameOrder = compareText(left.name, right.name);
        return nameOrder === 0 ? compareText(left.source, right.source) : nameOrder;
      }),
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersions: {
      delegationSpec: DELEGATION_SPEC_VERSION,
      attemptResult: ATTEMPT_RESULT_VERSION,
    },
    packagedVerifier: {
      version: redact(args.packagedVerifier.version),
      hash: sha256(args.packagedVerifier.content),
    },
  };

  return withManifestHash(body);
}
