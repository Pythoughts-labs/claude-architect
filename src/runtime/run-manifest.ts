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
  runtimeVersion: string;
  protocolVersion: string;
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
      id: preserveNullableIdentity(body.producer.id, "producer id"),
      version: preserveNullableIdentity(body.producer.version, "producer version"),
      model: preserveNullableIdentity(body.producer.model, "producer model"),
    },
    effectivePolicy: redactRecord(body.effectivePolicy),
    repositoryInstructions: body.repositoryInstructions
      .map(instruction => ({
        path: preserveIdentity(instruction.path, "repository instruction path"),
        hash: preserveIdentity(instruction.hash, "repository instruction hash"),
      }))
      .sort((left, right) => compareText(left.path, right.path)),
    promptHash: preserveIdentity(body.promptHash, "prompt hash"),
    executionPolicy: redactRecord(body.executionPolicy),
    environment: body.environment
      .map(entry => ({
        name: preserveIdentity(entry.name, "environment name"),
        source: preserveIdentity(entry.source, "environment provenance"),
      }))
      .sort((left, right) => {
        const nameOrder = compareText(left.name, right.name);
        return nameOrder === 0 ? compareText(left.source, right.source) : nameOrder;
      }),
    runtimeVersion: body.runtimeVersion,
    protocolVersion: body.protocolVersion,
    schemaVersions: { ...body.schemaVersions },
    packagedVerifier: {
      version: preserveIdentity(body.packagedVerifier.version, "packaged verifier version"),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => actual.includes(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function protocolMajor(version: string): number | null {
  const match = /^(\d+)\.\d+\.\d+$/.exec(version);
  if (match === null) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : null;
}

function assertManifestShape(value: unknown): asserts value is RunManifest {
  if (!hasExactKeys(value, [
    "manifestVersion",
    "runId",
    "repoRoot",
    "baseCommitOid",
    "candidateManifestHash",
    "producer",
    "effectivePolicy",
    "repositoryInstructions",
    "promptHash",
    "executionPolicy",
    "environment",
    "runtimeVersion",
    "protocolVersion",
    "schemaVersions",
    "packagedVerifier",
    "manifestHash",
  ])
    || value.manifestVersion !== "1"
    || typeof value.runId !== "string"
    || typeof value.repoRoot !== "string"
    || !isObjectId(value.baseCommitOid)
    || (value.candidateManifestHash !== null && !isSha256(value.candidateManifestHash))
    || !hasExactKeys(value.producer, ["id", "version", "model"])
    || !isNullableString(value.producer.id)
    || !isNullableString(value.producer.version)
    || !isNullableString(value.producer.model)
    || !isRecord(value.effectivePolicy)
    || !Array.isArray(value.repositoryInstructions)
    || !value.repositoryInstructions.every(instruction =>
      hasExactKeys(instruction, ["path", "hash"])
      && typeof instruction.path === "string"
      && isSha256(instruction.hash))
    || !isSha256(value.promptHash)
    || !isRecord(value.executionPolicy)
    || !Array.isArray(value.environment)
    || !value.environment.every(entry =>
      hasExactKeys(entry, ["name", "source"])
      && typeof entry.name === "string"
      && typeof entry.source === "string")
    || typeof value.runtimeVersion !== "string"
    || typeof value.protocolVersion !== "string"
    || !hasExactKeys(value.schemaVersions, ["delegationSpec", "attemptResult"])
    || typeof value.schemaVersions.delegationSpec !== "string"
    || typeof value.schemaVersions.attemptResult !== "string"
    || !hasExactKeys(value.packagedVerifier, ["version", "hash"])
    || typeof value.packagedVerifier.version !== "string"
    || !isSha256(value.packagedVerifier.hash)
    || !isSha256(value.manifestHash)) {
    throw new RuntimeError("archived run manifest is malformed");
  }
}

export function sanitizeRunManifest(manifest: RunManifest): RunManifest {
  assertManifestShape(manifest);
  const { manifestHash: _manifestHash, ...body } = manifest;
  return withManifestHash(body);
}

export function verifyRunManifest(value: unknown, expectedRunId?: string): RunManifest {
  assertManifestShape(value);
  const { manifestHash, ...body } = value;
  if (sha256(stableJson(body)) !== manifestHash) {
    throw new RuntimeError("archived run manifest integrity check failed");
  }
  const archivedProtocolMajor = protocolMajor(body.protocolVersion);
  const runtimeProtocolMajor = protocolMajor(PROTOCOL_VERSION);
  if (archivedProtocolMajor === null
    || runtimeProtocolMajor === null
    || archivedProtocolMajor !== runtimeProtocolMajor) {
    throw new RuntimeError(
      `archived run manifest protocol ${body.protocolVersion} is incompatible with runtime protocol ${PROTOCOL_VERSION}`,
    );
  }
  if (body.schemaVersions.delegationSpec !== DELEGATION_SPEC_VERSION
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
