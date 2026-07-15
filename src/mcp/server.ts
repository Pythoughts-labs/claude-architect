import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROTOCOL_VERSION, RUNTIME_VERSION } from "../protocol/versions.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleIntegrateCandidate,
  handleReviewCandidate,
  type ToolDependencies,
} from "./tools.js";

function toolOutput(value: object) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

export async function start(dependencies: ToolDependencies = {}): Promise<void> {
  if (process.env.CLAUDE_ARCHITECT_DELEGATED !== undefined) {
    console.error("Claude Architect MCP startup denied: CLAUDE_ARCHITECT_DELEGATED is present");
    process.exitCode = 1;
    return;
  }

  const server = new McpServer({ name: "claude-architect", version: RUNTIME_VERSION });
  server.registerTool(
    "delegate",
    {
      title: "Delegate an implementation subtask",
      description: "Validate a Delegation Spec and run one verified attempt.",
      inputSchema: {
        checkoutPath: z.string(),
        spec: z.unknown(),
        protocolVersion: z.string().optional(),
      },
    },
    async ({ checkoutPath, spec, protocolVersion }) => toolOutput(await handleDelegate(
      checkoutPath,
      spec,
      {
        ...dependencies,
        skillProtocolVersion: protocolVersion ?? dependencies.skillProtocolVersion ?? PROTOCOL_VERSION,
      },
    )),
  );
  server.registerTool(
    "reviewCandidate",
    {
      title: "Review a verified candidate",
      description: "Regenerate and return the exact candidate patch and verification evidence.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => toolOutput(await handleReviewCandidate(runId, dependencies)),
  );
  server.registerTool(
    "decideCandidate",
    {
      title: "Record a candidate decision",
      description: "Record acceptance, rejection, or a revision request for a candidate.",
      inputSchema: {
        runId: z.string(),
        decision: z.enum(["accepted", "rejected", "revision-requested"]),
      },
    },
    async ({ runId, decision }) => toolOutput(await handleDecideCandidate(
      runId,
      decision,
      dependencies,
    )),
  );
  server.registerTool(
    "integrateCandidate",
    {
      title: "Integrate an accepted candidate",
      description: "Apply an accepted candidate tree after revalidating its artifact hash.",
      inputSchema: {
        runId: z.string(),
        expectedArtifactHash: z.string(),
      },
    },
    async ({ runId, expectedArtifactHash }) => toolOutput(await handleIntegrateCandidate(
      runId,
      expectedArtifactHash,
      dependencies,
    )),
  );
  server.registerTool(
    "doctor",
    {
      title: "Diagnose the Claude Architect runtime",
      description: "Report runtime, Git, and Producer availability diagnostics.",
      inputSchema: {},
    },
    async () => toolOutput({ issues: ["doctor-not-implemented"] }),
  );

  await server.connect(new StdioServerTransport());
  console.error("claude-architect MCP server ready");
}
