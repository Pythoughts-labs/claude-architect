import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { start } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { RunDecisionRecord } from "../../src/runtime/artifact-store.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";

describe("legacy decision provenance", () => {
  it("keeps policy-autonomous archives readable for backward compatibility", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "decision-authority-state-"));
    const previousStateRoot = process.env.CLAUDE_ARCHITECT_STATE_DIR;
    const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_ARCHITECT_STATE_DIR = stateRoot;
    process.env.CLAUDE_PLUGIN_DATA = stateRoot;
    try {
      const store = new ArtifactStore("decision-authority-roundtrip");
      const record: RunDecisionRecord = {
        decision: "accepted",
        recordedAt: new Date().toISOString(),
        decidedBy: "policy-autonomous",
        candidateManifestHash: "a".repeat(64),
      };
      await store.writeDecision(record);
      await expect(store.readDecision("decision-authority-roundtrip"))
        .resolves.toMatchObject({ decidedBy: "policy-autonomous" });
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
      } else {
        process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateRoot;
      }
      if (previousPluginData === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});

const candidate: CandidateArtifact = {
  baseCommitOid: "1".repeat(40),
  candidateCommitOid: "2".repeat(40),
  candidateTreeOid: "3".repeat(40),
  anchorRef: "refs/claude-architect/candidates/decide-authority",
  // `loadArchivedRun` recomputes this from the changed paths and rejects a
  // mismatch, so derive it rather than inventing a value.
  manifestHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
  changedPaths: [],
};

const verifiedResult = {
  runId: "decide-authority",
  status: "verified-candidate",
  failure: null,
  candidate,
  evidence: {},
  durationMs: 1,
  producerId: "fake",
} as unknown as AttemptResult;

function fakePlatform(): PlatformServices {
  return {
    os: "darwin",
    canonicalizePath: async (input: string) => ({
      input,
      canonical: "/canonical/repo",
      gitCommonDir: "/canonical/repo/.git",
    }),
    acquireCheckoutLock: async (checkout: string) => ({
      key: checkout,
      repositoryIdentity: "/canonical/repo/.git",
      release: async () => {},
    }),
  } as unknown as PlatformServices;
}

/**
 * Drives `decideCandidate` through a real MCP client so the elicitation branch
 * is exercised as the server actually reaches it.
 *
 * The client advertises NO elicitation capability. A verified candidate is the
 * most tempting case to auto-accept, so this proves the public tool still fails
 * closed rather than treating objective verification as human authorization.
 */
async function decideVia(
  result: AttemptResult,
): Promise<{ output: unknown; decision: RunDecisionRecord | null }> {
  let recorded: RunDecisionRecord | null = null;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await start({
    transport: serverTransport,
    recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
    pruneRuns: async () => {},
    ps: fakePlatform(),
    storeFactory: () => ({
      readResult: async () => result,
      readManifest: async () => ({
        runId: "decide-authority",
        repoRoot: "/canonical/repo",
        baseCommitOid: candidate.baseCommitOid,
        candidateManifestHash: candidate.manifestHash,
      } as unknown as RunManifest),
      writeDecision: async (record: RunDecisionRecord) => { recorded = record; },
      readDecision: async () => recorded,
      readPipelineActiveMarker: async () => null,
    }) as never,
    git: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  });
  const client = new Client({ name: "authority-test", version: "1.0.0" });
  await client.connect(clientTransport);
  const output = await client.callTool({
    name: "decideCandidate",
    arguments: { checkoutPath: "/repo", runId: "decide-authority", decision: "accepted" },
  });
  await client.close();
  return { output, decision: recorded };
}

describe("decideCandidate human authority", () => {
  it("never records a clean candidate without human elicitation", async () => {
    const { decision, output } = await decideVia(verifiedResult);
    expect(decision).toBeNull();
    expect(JSON.stringify(output)).toContain("elicitation");
  });

  it.each([
    undefined,
    "caller-asserted",
    "policy-autonomous",
  ] as const)(
    "reports a conflict when human confirmation meets an accepted %s archive",
    async decidedBy => {
      const stateRoot = await mkdtemp(join(tmpdir(), "decision-authority-conflict-"));
      const previousStateRoot = process.env.CLAUDE_ARCHITECT_STATE_DIR;
      const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_ARCHITECT_STATE_DIR = stateRoot;
      process.env.CLAUDE_PLUGIN_DATA = stateRoot;
      const persistentStore = new ArtifactStore("decide-authority");
      const existing: RunDecisionRecord = {
        decision: "accepted",
        recordedAt: "2026-07-27T00:00:00.000Z",
        ...(decidedBy === undefined ? {} : { decidedBy }),
        candidateManifestHash: candidate.manifestHash,
      };
      try {
        await persistentStore.writeDecision(existing);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await start({
          transport: serverTransport,
          recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
          pruneRuns: async () => {},
          ps: fakePlatform(),
          storeFactory: () => ({
            readResult: async () => verifiedResult,
            readManifest: async () => ({
              runId: "decide-authority",
              repoRoot: "/canonical/repo",
              baseCommitOid: candidate.baseCommitOid,
              candidateManifestHash: candidate.manifestHash,
            } as unknown as RunManifest),
            writeDecision: async (record: RunDecisionRecord) => {
              await persistentStore.writeDecision(record);
            },
            readDecision: async () => persistentStore.readDecision("decide-authority"),
            readPipelineActiveMarker: async () => null,
          }) as never,
          git: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        });
        const client = new Client(
          { name: "authority-conflict-test", version: "1.0.0" },
          { capabilities: { elicitation: { form: {} } } },
        );
        client.setRequestHandler(ElicitRequestSchema, async () => ({
          action: "accept",
          content: { confirm: true },
        }));
        await client.connect(clientTransport);
        const output = await client.callTool({
          name: "decideCandidate",
          arguments: {
            checkoutPath: "/repo",
            runId: "decide-authority",
            decision: "accepted",
          },
        });
        await client.close();

        expect(JSON.stringify(output)).toContain("decision-conflict");
        await expect(persistentStore.readDecision("decide-authority")).resolves.toEqual(existing);
      } finally {
        if (previousStateRoot === undefined) {
          delete process.env.CLAUDE_ARCHITECT_STATE_DIR;
        } else {
          process.env.CLAUDE_ARCHITECT_STATE_DIR = previousStateRoot;
        }
        if (previousPluginData === undefined) {
          delete process.env.CLAUDE_PLUGIN_DATA;
        } else {
          process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
        }
        await rm(stateRoot, { recursive: true, force: true });
      }
    },
  );
});
