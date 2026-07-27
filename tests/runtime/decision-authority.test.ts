import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autonomousEligibility,
  DECISION_AUTHORITY_ENV,
  decisionAuthority,
} from "../../src/mcp/decision-authority.js";
import { start } from "../../src/mcp/server.js";
import type { PlatformServices } from "../../src/platform/platform-services.js";
import type { AttemptResult, CandidateArtifact } from "../../src/protocol/attempt-result.js";
import { ArtifactStore } from "../../src/runtime/artifact-store.js";
import type { CandidateDecisionV2 } from "../../src/protocol/candidate-decision.js";
import type { RunManifest } from "../../src/runtime/run-manifest.js";

describe("decisionAuthority", () => {
  it("defaults to autonomous when unset or empty", () => {
    expect(decisionAuthority({})).toBe("autonomous");
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "" })).toBe("autonomous");
  });

  it("honors both recognized values", () => {
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "human" })).toBe("human");
    expect(decisionAuthority({ [DECISION_AUTHORITY_ENV]: "autonomous" })).toBe("autonomous");
  });

  it("fails closed and warns on an unrecognized value", () => {
    // A typo must not silently select the permissive mode — that is the exact
    // failure this setting exists to prevent.
    const warnings: string[] = [];
    expect(decisionAuthority(
      { [DECISION_AUTHORITY_ENV]: "autonomus" },
      message => warnings.push(message),
    )).toBe("human");
    expect(warnings).toEqual([expect.stringContaining("not a recognized decision authority")]);
  });
});

describe("autonomousEligibility", () => {
  const clean = { warnings: [], verifiedClean: true, unreadable: false };

  it("accepts only a verified, unwarned, readable candidate", () => {
    expect(autonomousEligibility("autonomous", clean)).toEqual({ eligible: true, reasons: [] });
  });

  it("refuses when the authority is human", () => {
    expect(autonomousEligibility("human", clean).eligible).toBe(false);
  });

  it("refuses an unreadable archive rather than falling through to a prompt", () => {
    // Under autonomous policy a client may not advertise elicitation at all, so
    // downgrading here would dead-end the run with no path forward.
    const verdict = autonomousEligibility(
      "autonomous",
      { warnings: ["unreadable"], verifiedClean: false, unreadable: true },
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toEqual(["the candidate archive could not be read"]);
  });

  it("refuses a run that is not an independently verified candidate", () => {
    // The decisive case: zero warnings but unverified. A plain `delegate` run
    // carries no pipeline evidence, so keying autonomy off warnings alone would
    // auto-accept whatever it produced.
    const verdict = autonomousEligibility(
      "autonomous",
      { warnings: [], verifiedClean: false, unreadable: false },
    );
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons).toEqual(["the candidate is not an independently verified result"]);
  });

  it("refuses a verified candidate carrying advisory warnings", () => {
    expect(autonomousEligibility(
      "autonomous",
      { warnings: ["the pipeline gate did NOT clear this candidate"], verifiedClean: true, unreadable: false },
    ).eligible).toBe(false);
  });
});

describe("policy-autonomous decisions survive the archive", () => {
  // Isolated state root: this used to write into the real plugin data directory
  // under a fixed run id, so the archive it created survived the run and made
  // the next one fail on a decision conflict with its own leftovers.
  let previousPluginData: string | undefined;

  beforeEach(async () => {
    previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = await mkdtemp(join(tmpdir(), "decision-authority-"));
  });

  afterEach(() => {
    if (previousPluginData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
  });

  it("writes and reads back a policy-autonomous decision", async () => {
    // The write validator rejects unknown provenance values, so without this
    // the new value would be unwritable and every autonomous decision would
    // fail at the point of being recorded.
    const store = new ArtifactStore("decision-authority-roundtrip");
    await store.writeResult({
      resultVersion: "1",
      runId: "decision-authority-roundtrip",
      status: "failed",
      failure: "producer-failure",
      summary: "fixture",
      producerSummary: null,
      candidate: null,
      requestedVerification: [],
      executedVerification: [],
      unresolvedIssues: [],
      evidence: {},
      logsRef: "logs/producer.log",
      producerId: "codex",
      producerVersion: "1.2.3",
      producerModel: null,
      durationMs: 1,
      sessionId: null,
    });
    const record: CandidateDecisionV2 = {
      decisionVersion: "2",
      decision: "accepted",
      authority: "policy-autonomous",
      candidateManifestHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
      policyVersion: "1",
      recordedAt: new Date().toISOString(),
    };
    await store.writeCandidateDecisionRecord(record);
    await expect(store.readCandidateDecision("decision-authority-roundtrip"))
      .resolves.toMatchObject({ authority: "policy-autonomous" });
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
  // The review snapshot maps over this, so it must be a real array rather than
  // absent: a fixture that omits it fails inside the snapshot builder before
  // the authority branch under test is ever reached.
  executedVerification: [],
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
 * The client advertises NO elicitation capability. That makes the assertion
 * discriminating rather than trivial: if the autonomous path regresses and the
 * server tries to prompt, `confirmWithHuman` fails closed and the call reports
 * an error instead of recording a decision. A test that merely asserted
 * "decision recorded" would pass even if elicitation had been deleted outright.
 */
async function decideVia(
  authority: "autonomous" | "human",
  result: AttemptResult,
): Promise<{ output: unknown; decision: CandidateDecisionV2 | null }> {
  const root = await mkdtemp(join(tmpdir(), "decide-authority-"));
  let recorded: CandidateDecisionV2 | null = null;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await start({
      transport: serverTransport,
      recoverStaleRuns: async () => ({ recovered: [], quarantined: [] }),
      pruneRuns: async () => {},
      ps: fakePlatform(),
      decisionAuthority: () => authority,
      storeFactory: () => ({
        readResult: async () => result,
        readManifest: async () => ({
          runId: "decide-authority",
          repoRoot: "/canonical/repo",
          baseCommitOid: candidate.baseCommitOid,
          candidateManifestHash: candidate.manifestHash,
        } as unknown as RunManifest),
        writeCandidateDecisionRecord: async (record: CandidateDecisionV2) => {
          recorded = record;
        },
        readCandidateDecision: async () => recorded,
        writeReviewSnapshot: async () => {},
        readReviewSnapshot: async () => null,
        readRunStartSpecSha256: async () => null,
        readPipelineActiveMarker: async () => null,
      }) as never,
    // The decision path regenerates a review snapshot, which verifies the anchor
    // and tree against the archive before anything is recorded. A git stub that
    // answered nothing failed that check, so the authority branch under test was
    // never reached.
    git: async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{commit}") === true) {
        return { stdout: `${candidate.candidateCommitOid}\n`, stderr: "", exitCode: 0 };
      }
      if (args[0] === "rev-parse" && args.at(-1)?.endsWith("^{tree}") === true) {
        return { stdout: `${candidate.candidateTreeOid}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    });
    const client = new Client({ name: "authority-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const output = await client.callTool({
      name: "decideCandidate",
      arguments: {
        checkoutPath: "/repo",
        runId: "decide-authority",
        decision: "accepted",
        expectedArtifactHash: candidate.manifestHash,
      },
    });
    await client.close();
    return { output, decision: recorded };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("decideCandidate honors the configured authority", () => {
  it("records a clean candidate without prompting under the default authority", async () => {
    const { decision, output } = await decideVia("autonomous", verifiedResult);
    expect(decision, JSON.stringify(output)).not.toBeNull();
    expect(decision?.authority).toBe("policy-autonomous");
  });

  it("still demands a human when the authority is human", async () => {
    // Same candidate, same client, only the authority differs — so this is the
    // mutation that proves the branch above is the reason no prompt happened.
    const { decision, output } = await decideVia("human", verifiedResult);
    expect(decision).toBeNull();
    expect(JSON.stringify(output)).toContain("elicitation");
  });
});
