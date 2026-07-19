import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PROTOCOL_VERSION, RUNTIME_VERSION } from "../protocol/versions.js";
import { doctor, type DoctorDependencies } from "./doctor.js";
import {
  gitChangedFiles,
  gitDiff,
  gitLog,
  gitStatus,
  type GitReadDependencies,
} from "./git-read-tools.js";
import {
  handleDecideCandidate,
  handleDelegate,
  handleDelegatePipeline,
  handleIntegrateCandidate,
  handleReviewCandidate,
  type ToolDependencies,
} from "./tools.js";
import { recoverStaleRuns } from "../runtime/recovery-manager.js";

const errorOutputFields = {
  ok: z.literal(false).optional(),
  error: z.string().optional(),
  diagnostic: z.string().optional(),
};
const delegateOutput = z.object({
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
export const delegatePipelineOutput = z.object({
  ok: z.boolean(),
  result: z.object({
    runId: z.string(),
    status: z.enum(["decision-ready", "human-decision-required", "failed"]),
    attempt: z.record(z.string(), z.unknown()),
    increments: z.array(z.object({
      increment: z.number(),
      report: z.object({
        reportVersion: z.literal("1"),
        candidateCommit: z.string(),
        status: z.enum(["complete", "continue", "blocked"]),
        summary: z.string(),
        nextSteps: z.string().optional(),
        blockers: z.string().optional(),
      }),
      roleLogRefs: z.array(z.string()),
    })),
    rounds: z.array(z.record(z.string(), z.unknown())),
    verification: z.record(z.string(), z.unknown()).nullable(),
    gate: z.record(z.string(), z.unknown()),
    finalCandidateCommit: z.string(),
    slices: z.array(z.record(z.string(), z.unknown())),
    haltedSliceIndex: z.number().nullable(),
  }).optional(),
  validationErrors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  diagnostic: z.string().optional(),
  error: z.string().optional(),
});
const reviewOutput = z.object({
  patch: z.string().optional(),
  changedPaths: z.array(z.object({
    path: z.string(),
    changeType: z.enum(["added", "modified", "deleted"]),
    mode: z.string(),
    contentHash: z.string().nullable(),
  })).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  executedVerification: z.array(z.record(z.string(), z.unknown())).optional(),
  ...errorOutputFields,
});
const decisionOutput = z.object({
  recorded: z.literal(true).optional(),
  ...errorOutputFields,
});
const integrationOutput = z.object({
  integration: z.enum(["applied", "conflicted", "aborted"]).optional(),
  detail: z.string().optional(),
  ...errorOutputFields,
});
const doctorOutput = z.object({
  node: z.object({ version: z.string(), ok: z.boolean() }),
  git: z.object({ version: z.string().nullable(), ok: z.boolean() }),
  producers: z.array(z.record(z.string(), z.unknown())),
  runtimeVersion: z.string(),
  schemaVersion: z.string(),
  protocolVersion: z.string(),
  issues: z.array(z.string()),
});
const gitReadOutput = z.object({
  ok: z.boolean(),
  output: z.string().optional(),
  error: z.literal("git-read-failed").optional(),
  diagnostic: z.string().optional(),
});

const protocolVersionInput = z.literal(PROTOCOL_VERSION, {
  errorMap: issue => ({
    message: "protocol version mismatch: received "
      + (issue.code === z.ZodIssueCode.invalid_literal && issue.received !== undefined
        ? String(issue.received)
        : "(missing)")
      + `, expected ${PROTOCOL_VERSION}`,
  }),
});

export const delegateInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
}).strict();

export const delegatePipelineInputSchema = z.object({
  checkoutPath: z.string(),
  spec: z.unknown(),
  protocolVersion: protocolVersionInput,
}).strict();

export const reviewCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
}).strict();

export const decideCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  decision: z.enum(["accepted", "rejected", "revision-requested"]),
}).strict();

export const integrateCandidateInputSchema = z.object({
  checkoutPath: z.string(),
  runId: z.string(),
  expectedArtifactHash: z.string(),
}).strict();

export type ServerDependencies = ToolDependencies & DoctorDependencies & GitReadDependencies & {
  recoverStaleRuns?: typeof recoverStaleRuns;
};

function toolOutput(value: object) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

export async function start(dependencies: ServerDependencies = {}): Promise<void> {
  if (process.env.CLAUDE_ARCHITECT_DELEGATED !== undefined) {
    console.error("Claude Architect MCP startup denied: CLAUDE_ARCHITECT_DELEGATED is present");
    process.exitCode = 1;
    return;
  }

  await (dependencies.recoverStaleRuns ?? recoverStaleRuns)();

  const server = new McpServer({ name: "claude-architect", version: RUNTIME_VERSION });
  server.registerTool(
    "delegate",
    {
      title: "Delegate an implementation subtask",
      description: "Validate a Delegation Spec and run one verified attempt.",
      inputSchema: delegateInputSchema,
      outputSchema: delegateOutput,
    },
    async ({ checkoutPath, spec, protocolVersion }, extra) => {
      const progressToken = extra._meta?.progressToken;
      const startedAt = Date.now();
      let step = 0;
      let lastPhase = "starting attempt";
      const emit = (message: string) => {
        if (progressToken === undefined) return;
        step += 1;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        void extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: step, message: `${message} (${elapsed}s)` },
        }).catch(() => { /* progress is best-effort */ });
      };
      const onProgress = progressToken === undefined ? undefined : (message: string) => {
        lastPhase = message;
        emit(message);
      };
      const heartbeat = onProgress === undefined
        ? undefined
        : setInterval(() => emit(lastPhase), 8_000);
      try {
        return toolOutput(await handleDelegate(
          checkoutPath,
          spec,
          {
            ...dependencies,
            skillProtocolVersion: protocolVersion,
            ...(onProgress === undefined ? {} : { onProgress }),
          },
        ));
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    },
  );
  server.registerTool(
    "delegatePipeline",
    {
      title: "Run the fresh-context review pipeline",
      description: "Validate a Delegation Spec and run the full implement/review/fix pipeline.",
      inputSchema: delegatePipelineInputSchema,
      outputSchema: delegatePipelineOutput,
    },
    async ({ checkoutPath, spec, protocolVersion }, extra) => {
      const progressToken = extra._meta?.progressToken;
      const startedAt = Date.now();
      let step = 0;
      let lastPhase = "starting attempt";
      const emit = (message: string) => {
        if (progressToken === undefined) return;
        step += 1;
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        void extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: step, message: `${message} (${elapsed}s)` },
        }).catch(() => { /* progress is best-effort */ });
      };
      const onProgress = progressToken === undefined ? undefined : (message: string) => {
        lastPhase = message;
        emit(message);
      };
      const heartbeat = onProgress === undefined
        ? undefined
        : setInterval(() => emit(lastPhase), 8_000);
      try {
        return toolOutput(await handleDelegatePipeline(
          checkoutPath,
          spec,
          {
            ...dependencies,
            skillProtocolVersion: protocolVersion,
            ...(onProgress === undefined ? {} : { onProgress }),
          },
        ));
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    },
  );
  server.registerTool(
    "reviewCandidate",
    {
      title: "Review a verified candidate",
      description: "Regenerate and return the exact candidate patch and verification evidence.",
      inputSchema: reviewCandidateInputSchema,
      outputSchema: reviewOutput,
    },
    async ({ checkoutPath, runId }) => toolOutput(await handleReviewCandidate(
      checkoutPath,
      runId,
      dependencies,
    )),
  );
  server.registerTool(
    "decideCandidate",
    {
      title: "Record a candidate decision",
      description: "Record acceptance, rejection, or a revision request for a candidate.",
      inputSchema: decideCandidateInputSchema,
      outputSchema: decisionOutput,
    },
    async ({ checkoutPath, runId, decision }) => toolOutput(await handleDecideCandidate(
      checkoutPath,
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
      inputSchema: integrateCandidateInputSchema,
      outputSchema: integrationOutput,
    },
    async ({ checkoutPath, runId, expectedArtifactHash }) => toolOutput(await handleIntegrateCandidate(
      checkoutPath,
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
      outputSchema: doctorOutput,
    },
    async () => toolOutput(await doctor(dependencies)),
  );
  const registerGitReadTool = (
    name: "gitStatus" | "gitDiff" | "gitLog" | "gitChangedFiles",
    title: string,
    description: string,
    handler: (checkoutPath: string, deps: GitReadDependencies) => Promise<object>,
  ) => server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: { checkoutPath: z.string() },
      outputSchema: gitReadOutput,
    },
    async ({ checkoutPath }) => toolOutput(await handler(checkoutPath, dependencies)),
  );
  registerGitReadTool(
    "gitStatus",
    "Read repository status",
    "Return redacted porcelain status without modifying the repository.",
    gitStatus,
  );
  registerGitReadTool(
    "gitDiff",
    "Read repository diff",
    "Return the redacted HEAD-to-worktree diff without external diff drivers.",
    gitDiff,
  );
  registerGitReadTool(
    "gitLog",
    "Read recent repository history",
    "Return a redacted bounded recent commit log.",
    gitLog,
  );
  registerGitReadTool(
    "gitChangedFiles",
    "Read changed repository paths",
    "Return redacted HEAD-to-worktree name-status records.",
    gitChangedFiles,
  );

  await server.connect(new StdioServerTransport());
  console.error("claude-architect MCP server ready");
}
