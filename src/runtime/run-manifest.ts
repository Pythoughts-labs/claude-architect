import { createHash } from "node:crypto";
import {
  ATTEMPT_RESULT_VERSION,
  DELEGATION_SPEC_VERSION,
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
} from "../protocol/versions.js";
import { RuntimeError } from "../util/errors.js";
import type { EnvProvenance } from "./environment-policy.js";
import { redact, redactRecord } from "./redaction.js";

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

function preserveIdentity(value: string, label: string): string {
  if (redact(value) !== value) {
    throw new RuntimeError(`${label} cannot be safely persisted after redaction`);
  }
  return value;
}

function preserveNullableIdentity(value: string | null, label: string): string | null {
  return value === null ? null : preserveIdentity(value, label);
}

function sanitizeBody(body: ManifestBody): ManifestBody {
  return {
    manifestVersion: body.manifestVersion,
    runId: preserveIdentity(body.runId, "run id"),
    repoRoot: preserveIdentity(body.repoRoot, "repository root"),
    baseCommitOid: preserveIdentity(body.baseCommitOid, "base commit oid"),
    candidateManifestHash: preserveNullableIdentity(
      body.candidateManifestHash,
      "candidate manifest hash",
    ),
    producer: {
      id: body.producer.id === null ? null : redact(body.producer.id),
      version: body.producer.version === null ? null : redact(body.producer.version),
      model: body.producer.model === null ? null : redact(body.producer.model),
    },
    effectivePolicy: redactRecord(body.effectivePolicy),
    repositoryInstructions: body.repositoryInstructions
      .map(instruction => ({
        path: redact(instruction.path),
        hash: preserveIdentity(instruction.hash, "repository instruction hash"),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    promptHash: preserveIdentity(body.promptHash, "prompt hash"),
    executionPolicy: redactRecord(body.executionPolicy),
    environment: body.environment
      .map(entry => ({ name: redact(entry.name), source: redact(entry.source) }))
      .sort((left, right) => {
        const nameOrder = compareText(left.name, right.name);
        return nameOrder === 0 ? compareText(left.source, right.source) : nameOrder;
      }),
    runtimeVersion: body.runtimeVersion,
    protocolVersion: body.protocolVersion,
    schemaVersions: { ...body.schemaVersions },
    packagedVerifier: {
      version: redact(body.packagedVerifier.version),
      hash: preserveIdentity(body.packagedVerifier.hash, "packaged verifier hash"),
    },
  };
}

function withManifestHash(body: ManifestBody): RunManifest {
  const sanitized = sanitizeBody(body);
  return {
    ...sanitized,
    manifestHash: sha256(stableJson(sanitized)),
  };
}

export function sanitizeRunManifest(manifest: RunManifest): RunManifest {
  const { manifestHash: _manifestHash, ...body } = manifest;
  return withManifestHash(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function verifyRunManifest(value: unknown, expectedRunId?: string): RunManifest {
  if (!isRecord(value) || typeof value.manifestHash !== "string") {
    throw new RuntimeError("archived run manifest is malformed");
  }
  const { manifestHash, ...body } = value;
  if (!/^[0-9a-f]{64}$/.test(manifestHash)
    || sha256(stableJson(body)) !== manifestHash) {
    throw new RuntimeError("archived run manifest integrity check failed");
  }
  if (body.manifestVersion !== "1"
    || typeof body.runId !== "string"
    || typeof body.repoRoot !== "string"
    || typeof body.baseCommitOid !== "string"
    || (body.candidateManifestHash !== null && typeof body.candidateManifestHash !== "string")
    || body.runtimeVersion !== RUNTIME_VERSION
    || body.protocolVersion !== PROTOCOL_VERSION
    || !isRecord(body.schemaVersions)
    || body.schemaVersions.delegationSpec !== DELEGATION_SPEC_VERSION
    || body.schemaVersions.attemptResult !== ATTEMPT_RESULT_VERSION) {
    throw new RuntimeError("archived run manifest contract is invalid");
  }
  if (expectedRunId !== undefined && body.runId !== expectedRunId) {
    throw new RuntimeError("archived run manifest id does not match run id");
  }
  return value as unknown as RunManifest;
}

export function buildRunManifest(args: BuildRunManifestArgs): RunManifest {
  const body: ManifestBody = {
    manifestVersion: "1",
    runId: args.runId,
    repoRoot: args.repoRoot,
    baseCommitOid: args.baseCommitOid,
    candidateManifestHash: args.candidateManifestHash,
    producer: { ...args.producer },
    effectivePolicy: args.effectivePolicy,
    repositoryInstructions: args.repositoryInstructions
      .map(instruction => ({
        path: instruction.path,
        hash: sha256(instruction.content),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    promptHash: sha256(args.prompt),
    executionPolicy: args.executionPolicy,
    environment: args.environment.map(entry => ({ ...entry })),
    runtimeVersion: RUNTIME_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersions: {
      delegationSpec: DELEGATION_SPEC_VERSION,
      attemptResult: ATTEMPT_RESULT_VERSION,
    },
    packagedVerifier: {
      version: args.packagedVerifier.version,
      hash: sha256(args.packagedVerifier.content),
    },
  };

  return withManifestHash(body);
}
