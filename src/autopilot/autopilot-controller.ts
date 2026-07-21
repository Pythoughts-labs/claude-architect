import { randomUUID } from "node:crypto";
import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { AutopilotSpec, AutopilotTaskSpec } from "../protocol/autopilot-spec.js";
import {
  validateAutopilotSpec,
  type ValidateAutopilotResult,
} from "../protocol/spec-validator.js";
import type { ReviewSnapshot } from "../runtime/review-snapshot.js";
import type {
  HostingAdapter,
  HostingTarget,
  PullRequestIdentity,
  RequiredChecksResult,
} from "../ship/hosting-adapter.js";
import { RuntimeError } from "../util/errors.js";
import {
  autopilotEligibilityRecordHash,
  canonicalArtifactHash,
  type AutopilotEligibilityRecord,
} from "./autopilot-eligibility.js";
import type {
  BranchCleanupResult,
  WorkflowBranchIdentity,
  WorkflowBranchManager,
} from "./branch-manager.js";
import type {
  CandidatePromoter,
  PromotionClassification,
} from "./candidate-promoter.js";
import {
  FINAL_BRANCH_REPORT_REF,
  type FinalBranchReport,
  type FinalBranchReviewer,
} from "./final-branch-reviewer.js";
import type { AutopilotWorkflowState } from "./types.js";
import type {
  WorkflowIntentJournal,
  WorkflowJournalJson,
  WorkflowStore,
} from "./workflow-store.js";

export type AutopilotControllerEvent =
  | "preflight"
  | `task:${string}`
  | `promote:${string}`
  | "final-review"
  | "push"
  | "draft-pr"
  | `checks:${string}`
  | "mark-ready"
  | "cleanup"
  | "ready";

export type AutopilotControllerClassification =
  | "invalid-spec"
  | "not-implemented"
  | "pipeline-failed"
  | "human-decision-required"
  | "candidate-evidence-mismatch"
  | "eligibility-red"
  | PromotionClassification
  | (string & {});

export class AutopilotControllerError extends RuntimeError {
  constructor(
    readonly classification: AutopilotControllerClassification,
    message = classification,
    detail: Record<string, unknown> = {},
  ) {
    super(message, { ...detail, classification });
    this.name = "AutopilotControllerError";
  }
}

export type WorkflowStorePort = Pick<
  WorkflowStore,
  | "create"
  | "acquireLease"
  | "adoptLease"
  | "releaseLease"
  | "read"
  | "readIntentJournal"
  | "beginIntent"
  | "completeIntent"
  | "transition"
  | "update"
>;

export interface PipelineRunner {
  run(checkoutPath: string, spec: AutopilotTaskSpec["delegation"]): Promise<PipelineResult>;
}

export interface ReviewSnapshotter {
  create(args: {
    workflow: AutopilotWorkflowState;
    branch: WorkflowBranchIdentity;
    task: AutopilotTaskSpec;
    pipelineResult: PipelineResult;
  }): Promise<ReviewSnapshot>;
}

export interface EligibilityEvaluator {
  evaluate(args: {
    workflow: AutopilotWorkflowState;
    branch: WorkflowBranchIdentity;
    task: AutopilotTaskSpec;
    pipelineResult: PipelineResult;
    reviewSnapshot: ReviewSnapshot;
  }): Promise<AutopilotEligibilityRecord>;
}

export interface WorkflowLock {
  runExclusive<T>(workflowId: string, operation: () => Promise<T>): Promise<T>;
}

export interface AutopilotControllerDependencies {
  validator?: (value: unknown) => ValidateAutopilotResult;
  workflowId?: () => string;
  now?: () => string;
  workflowLock: WorkflowLock;
  workflowStore: (workflowId: string) => WorkflowStorePort;
  repositoryIdentity: (checkoutPath: string) => Promise<string>;
  branchManager: Pick<
    WorkflowBranchManager,
    "create" | "load" | "revalidate" | "cleanup"
  >;
  pipelineRunner: PipelineRunner;
  reviewSnapshotter: ReviewSnapshotter;
  eligibilityEvaluator: EligibilityEvaluator;
  promoter: Pick<CandidatePromoter, "promote">;
  finalBranchReviewer: Pick<FinalBranchReviewer, "review">;
  hostingAdapter: HostingAdapter;
  requiredChecksPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  emit?: (event: AutopilotControllerEvent) => void;
}

export type AutopilotStartResult = AutopilotWorkflowState & {
  status: "ready-for-human-review";
  headCommitOid: string;
  pullRequest: PullRequestIdentity;
};

export type AutopilotStatusResult = AutopilotWorkflowState;

interface CleanupContext {
  store: WorkflowStorePort;
  state: AutopilotWorkflowState;
  headCommitOid: string;
  pullRequest: PullRequestIdentity;
  cleanup: BranchCleanupResult;
}

interface RecordedWorkflow {
  spec: unknown;
  branch: WorkflowBranchIdentity | null;
}

const DEFAULT_REQUIRED_CHECKS_POLL_INTERVAL_MS = 10_000;
const MIN_REQUIRED_CHECKS_POLL_INTERVAL_MS = 100;
const MAX_REQUIRED_CHECKS_POLL_INTERVAL_MS = 60_000;
const REQUIRED_TASK_EVIDENCE_REFS = [
  "decision.json",
  "manifest.json",
  "pipeline/pipeline-result.json",
  "pipeline/post-pipeline-autopilot.json",
  "result.json",
  "review-snapshot.json",
] as const;

function classificationOf(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const direct = (error as { classification?: unknown }).classification;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const detail = (error as { detail?: { classification?: unknown } }).detail;
  return typeof detail?.classification === "string" && detail.classification.length > 0
    ? detail.classification
    : fallback;
}

function candidateFrom(result: PipelineResult) {
  return result.attempt.candidate;
}

function snapshotMatchesCandidate(
  expectedHead: string,
  pipelineResult: PipelineResult,
  snapshot: ReviewSnapshot,
): boolean {
  const candidate = candidateFrom(pipelineResult);
  return candidate !== null
    && snapshot.runId === pipelineResult.runId
    && snapshot.baseCommitOid === expectedHead
    && snapshot.baseCommitOid === candidate.baseCommitOid
    && snapshot.candidateCommitOid === candidate.candidateCommitOid
    && snapshot.candidateTreeOid === candidate.candidateTreeOid
    && snapshot.manifestHash === candidate.manifestHash;
}

function eligibilityMatchesSnapshot(
  pipelineResult: PipelineResult,
  snapshot: ReviewSnapshot,
  eligibility: AutopilotEligibilityRecord,
): boolean {
  return eligibility.runId === pipelineResult.runId
    && eligibility.baseCommitOid === snapshot.baseCommitOid
    && eligibility.candidateCommitOid === snapshot.candidateCommitOid
    && eligibility.candidateTreeOid === snapshot.candidateTreeOid
    && eligibility.candidateManifestHash === snapshot.manifestHash;
}

function terminalPhase(
  classification: string,
): "failed" | "human-decision-required" | "cancelled" {
  if (classification === "cancelled") return "cancelled";
  return classification === "pipeline-failed"
    || classification === "cleanup-failed"
    || classification === "workflow-lock-release-failed"
    || classification.endsWith("-command-failed")
    || classification.endsWith("-create-failed")
    || classification.endsWith("-query-failed")
    || classification.endsWith("-persistence-failed")
    ? "failed"
    : "human-decision-required";
}

function isTerminal(state: AutopilotWorkflowState): boolean {
  return state.phase === "ready-for-human-review"
    || state.phase === "human-decision-required"
    || state.phase === "failed"
    || state.phase === "cancelled";
}

function expectedHeadOf(state: AutopilotWorkflowState): string {
  return state.tasks
    .slice(0, state.currentTaskIndex + 1)
    .reduce(
      (head, task) => task.promotionCommitOid ?? head,
      state.baseCommitOid,
    );
}

function branchMatchesState(
  checkoutPath: string,
  state: AutopilotWorkflowState,
  branch: WorkflowBranchIdentity,
): boolean {
  return branch.workflowId === state.workflowId
    && branch.checkoutPath === checkoutPath
    && branch.repositoryIdentity === state.repositoryIdentity
    && branch.baseCommitOid === state.baseCommitOid
    && branch.branchRef === state.workflowRef
    && branch.worktreePath === state.worktreePath
    && branch.branch === state.shipping.branch;
}

function redactedState(state: AutopilotWorkflowState): AutopilotStatusResult {
  const redacted = structuredClone(state);
  redacted.repositoryIdentity = "[redacted]";
  redacted.worktreePath = "[redacted]";
  if (redacted.shipping.prUrl !== null) redacted.shipping.prUrl = "[redacted]";
  for (const observation of redacted.ciObservations) {
    for (const check of observation.checks) {
      if (check.link !== null) check.link = "[redacted]";
    }
  }
  return redacted;
}

function recordedWorkflowFrom(journal: WorkflowIntentJournal): RecordedWorkflow {
  const recorded = journal.intents.find(intent =>
    intent.intent.operation === "record-workflow-spec"
    && intent.intent.idempotencyKey === "workflow-spec");
  const completion = recorded?.completion?.completion;
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    throw new AutopilotControllerError(
      "workflow-spec-missing",
      "workflow specification is unavailable for resume",
    );
  }
  const recordedCompletion = completion as {
    spec?: unknown;
    branch?: WorkflowBranchIdentity;
  };
  return {
    spec: recordedCompletion.spec,
    branch: recordedCompletion.branch ?? null,
  };
}

function initialWorkflowState(args: {
  workflowId: string;
  spec: AutopilotSpec;
  branch: WorkflowBranchIdentity;
  startedAt: string;
  ciDeadlineAt: string;
}): AutopilotWorkflowState {
  return {
    stateVersion: "1",
    workflowId: args.workflowId,
    repositoryIdentity: args.branch.repositoryIdentity,
    baseCommitOid: args.branch.baseCommitOid,
    workflowRef: args.branch.branchRef,
    worktreePath: args.branch.worktreePath,
    autopilotSpecHash: canonicalArtifactHash(args.spec),
    revision: 0,
    phase: "preflighting",
    currentTaskIndex: 0,
    tasks: args.spec.tasks.map(task => ({
      id: task.id,
      runId: null,
      candidateManifestHash: null,
      eligibilityHash: null,
      promotionCommitOid: null,
      status: "pending",
    })),
    intentJournal: {
      ref: "journal.ndjson",
      entryCount: 0,
      lastEntryHash: null,
    },
    finalGate: null,
    shipping: {
      branch: args.branch.branch,
      prNumber: null,
      prUrl: null,
      ciDeadlineAt: args.ciDeadlineAt,
    },
    ciObservations: [],
    cleanup: null,
    terminal: null,
    createdAt: args.startedAt,
    updatedAt: args.startedAt,
  };
}

function finalGateFor(report: FinalBranchReport) {
  const reportHash = canonicalArtifactHash(report);
  return {
    reportRef: FINAL_BRANCH_REPORT_REF,
    reportHash,
    headCommitOid: report.headCommitOid,
    eligibilityHash: reportHash,
  };
}

function pullRequestIdentityMatches(
  pullRequest: PullRequestIdentity,
  target: HostingTarget,
  branch: WorkflowBranchIdentity,
  expectedHead: string,
): boolean {
  return Number.isSafeInteger(pullRequest.number)
    && pullRequest.number > 0
    && pullRequest.url.length > 0
    && pullRequest.repository === target.repository
    && pullRequest.baseBranch === branch.baseBranch
    && pullRequest.headBranch === branch.branch
    && pullRequest.headCommitOid === expectedHead;
}

function pullRequestMatches(
  pullRequest: PullRequestIdentity,
  target: HostingTarget,
  branch: WorkflowBranchIdentity,
  expectedHead: string,
  expectedDraft: boolean,
): boolean {
  return pullRequestIdentityMatches(pullRequest, target, branch, expectedHead)
    && pullRequest.draft === expectedDraft;
}

function checksAreNonEmptyAndPassing(checks: RequiredChecksResult): boolean {
  return checks.result === "passed"
    && checks.checks.length > 0
    && checks.checks.every(check => check.bucket === "pass");
}

function stateHasPassingChecks(state: AutopilotWorkflowState): boolean {
  const observation = state.ciObservations.at(-1);
  return observation !== undefined && checksAreNonEmptyAndPassing(observation);
}

const CLEANUP_INTENT_OPERATION = "cleanup-workflow-branch";

function cleanupIntentKey(headCommitOid: string): string {
  return `cleanup:${headCommitOid}`;
}

function cleanupProofFrom(journal: WorkflowIntentJournal, headCommitOid: string) {
  const status = journal.intents.find(intent =>
    intent.intent.operation === CLEANUP_INTENT_OPERATION
    && intent.intent.idempotencyKey === cleanupIntentKey(headCommitOid));
  const completion = status?.completion?.completion;
  if (typeof completion !== "object" || completion === null || Array.isArray(completion)) {
    return null;
  }
  const proof = completion as { worktreeRemoved?: unknown; refsRemoved?: unknown };
  return proof.worktreeRemoved === true && proof.refsRemoved === true
    ? { ok: true as const, worktreeRemoved: true, refsRemoved: true }
    : null;
}

export class AutopilotController {
  private readonly validator: (value: unknown) => ValidateAutopilotResult;
  private readonly createWorkflowId: () => string;
  private readonly now: () => string;
  private readonly pollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly dependencies: AutopilotControllerDependencies) {
    this.validator = dependencies.validator ?? validateAutopilotSpec;
    this.createWorkflowId = dependencies.workflowId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    const configuredInterval = dependencies.requiredChecksPollIntervalMs
      ?? DEFAULT_REQUIRED_CHECKS_POLL_INTERVAL_MS;
    this.pollIntervalMs = Number.isFinite(configuredInterval)
      ? Math.min(
          MAX_REQUIRED_CHECKS_POLL_INTERVAL_MS,
          Math.max(MIN_REQUIRED_CHECKS_POLL_INTERVAL_MS, Math.trunc(configuredInterval)),
        )
      : DEFAULT_REQUIRED_CHECKS_POLL_INTERVAL_MS;
    this.sleep = dependencies.sleep ?? (async milliseconds => {
      await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
    });
  }

  async start(checkoutPath: string, value: unknown): Promise<AutopilotStartResult> {
    const validated = this.validator(value);
    if (!validated.ok) {
      throw new AutopilotControllerError(
        "invalid-spec",
        "autopilot specification is invalid",
        { validationErrors: validated.errors },
      );
    }

    const spec = validated.spec;
    const startedAt = this.now();
    const startedAtMs = Date.parse(startedAt);
    if (!Number.isFinite(startedAtMs)) {
      throw new AutopilotControllerError("clock-invalid", "autopilot clock is invalid");
    }
    const ciDeadlineAt = new Date(
      startedAtMs + spec.shipping.requiredChecksTimeoutMs,
    ).toISOString();
    const ciDeadlineMs = Date.parse(ciDeadlineAt);
    const workflowId = this.createWorkflowId();
    let pendingCleanup: CleanupContext | null = null;
    // The widening assertion keeps the catch block below able to narrow this
    // variable: it is assigned inside the locked closure, which control-flow
    // analysis cannot see, so a plain null initializer would narrow to never.
    let bootstrapBranch = null as WorkflowBranchIdentity | null;
    let bootstrapStore = null as WorkflowStorePort | null;
    let bootstrapState = null as AutopilotWorkflowState | null;
    let bootstrapLeaseAcquired = false;
    let bootstrapCompleted = false;
    let completedCleanup: CleanupContext;
    try {
      completedCleanup = await this.dependencies.workflowLock.runExclusive(
        workflowId,
        async (): Promise<CleanupContext> => {
      let target: HostingTarget;
      this.dependencies.emit?.("preflight");
      try {
        target = await this.dependencies.hostingAdapter.preflight({ checkoutPath });
      } catch (error) {
        throw new AutopilotControllerError(
          classificationOf(error, "preflight-failed"),
          "shipping preflight failed",
        );
      }

      let branch: WorkflowBranchIdentity;
      try {
        branch = await this.dependencies.branchManager.create({
          checkoutPath,
          workflowId,
          topic: spec.topic,
          remote: spec.base.remote,
          baseBranch: spec.base.branch,
        });
        bootstrapBranch = branch;
      } catch (error) {
        throw new AutopilotControllerError(
          classificationOf(error, "workflow-branch-create-failed"),
          "workflow branch creation failed",
        );
      }
      if (branch.ownerRepo !== target.repository
        || branch.remoteUrl !== target.canonicalHttpsUrl) {
        throw new AutopilotControllerError(
          "repository-identity-mismatch",
          "shipping and workflow repository identities differ",
        );
      }

      const store = this.dependencies.workflowStore(workflowId);
      let state = await store.create(initialWorkflowState({
        workflowId,
        spec,
        branch,
        startedAt,
        ciDeadlineAt,
      }));
      bootstrapStore = store;
      bootstrapState = state;
      await store.acquireLease();
      bootstrapLeaseAcquired = true;
      await store.beginIntent({
        expectedRevision: state.revision,
        operation: "record-workflow-spec",
        idempotencyKey: "workflow-spec",
      });
      await store.completeIntent({
        expectedRevision: state.revision,
        idempotencyKey: "workflow-spec",
        completion: {
          spec: structuredClone(spec),
          branch: structuredClone(branch),
        } as unknown as WorkflowJournalJson,
      });
      bootstrapCompleted = true;
      let expectedHead = branch.baseCommitOid;

      for (const [index, task] of spec.tasks.entries()) {
        if (state.phase === "preflighting") {
          state = await store.transition({
            expectedRevision: state.revision,
            to: "running-task",
            update(draft) {
              draft.currentTaskIndex = index;
              draft.tasks[index]!.status = "running";
            },
          });
        }

        this.dependencies.emit?.(`task:${task.id}`);
        const pipelineResult = await this.dependencies.pipelineRunner.run(
          branch.worktreePath,
          task.delegation,
        ).catch(async error =>
          await this.halt(store, state, classificationOf(error, "pipeline-failed")));
        if (pipelineResult.status === "failed") {
          return await this.halt(store, state, "pipeline-failed");
        }
        if (pipelineResult.status === "human-decision-required"
          || pipelineResult.gate.requiresHumanDecision) {
          return await this.halt(store, state, "human-decision-required");
        }

        const snapshot = await this.dependencies.reviewSnapshotter.create({
          workflow: state,
          branch,
          task,
          pipelineResult,
        }).catch(async error =>
          await this.halt(
            store,
            state,
            classificationOf(error, "candidate-evidence-mismatch"),
          ));
        if (!snapshotMatchesCandidate(expectedHead, pipelineResult, snapshot)) {
          return await this.halt(store, state, "candidate-evidence-mismatch");
        }
        const eligibility = await this.dependencies.eligibilityEvaluator.evaluate({
          workflow: state,
          branch,
          task,
          pipelineResult,
          reviewSnapshot: snapshot,
        }).catch(async error =>
          await this.halt(store, state, classificationOf(error, "eligibility-red")));
        if (!eligibilityMatchesSnapshot(pipelineResult, snapshot, eligibility)) {
          return await this.halt(store, state, "candidate-evidence-mismatch");
        }
        if (!eligibility.eligible || eligibility.reasons.length !== 0) {
          return await this.halt(store, state, "eligibility-red");
        }

        const candidate = candidateFrom(pipelineResult)!;
        const eligibilityHash = autopilotEligibilityRecordHash(eligibility);
        state = await store.transition({
          expectedRevision: state.revision,
          to: "promoting-task",
          update(draft) {
            const current = draft.tasks[index]!;
            current.runId = pipelineResult.runId;
            current.candidateManifestHash = candidate.manifestHash;
            current.eligibilityHash = eligibilityHash;
          },
        });

        this.dependencies.emit?.(`promote:${task.id}`);
        const promotion = await this.dependencies.promoter.promote({
          workflowId,
          runId: pipelineResult.runId,
          workflowCheckoutPath: branch.worktreePath,
          expectedHead,
          expectedArtifactHash: candidate.manifestHash,
          commitMessage: task.commitMessage,
        }).catch(async error =>
          await this.halt(
            store,
            state,
            classificationOf(error, "promotion-failed"),
          ));
        if (promotion.status === "rejected") {
          return await this.halt(store, state, promotion.classification);
        }

        expectedHead = promotion.commitOid;
        const nextPhase = index === spec.tasks.length - 1 ? "final-review" : "running-task";
        state = await store.transition({
          expectedRevision: state.revision,
          to: nextPhase,
          update(draft) {
            const current = draft.tasks[index]!;
            current.status = "promoted";
            current.promotionCommitOid = promotion.commitOid;
            draft.currentTaskIndex = index + 1;
            if (nextPhase === "running-task") {
              draft.tasks[index + 1]!.status = "running";
            }
          },
        });
      }

      this.dependencies.emit?.("final-review");
      const report = await this.dependencies.finalBranchReviewer.review({
        workflowId,
        expectedRevision: state.revision,
        taskEvidence: state.tasks.map(task => ({
          taskId: task.id,
          runId: task.runId!,
          candidateManifestHash: task.candidateManifestHash!,
          promotionCommitOid: task.promotionCommitOid!,
          evidenceRefs: [...REQUIRED_TASK_EVIDENCE_REFS],
        })),
        autopilotSpec: spec,
        checkoutPath: branch.worktreePath,
      }).catch(async error =>
        await this.halt(
          store,
          state,
          classificationOf(error, "final-review-failed"),
        ));
      if (report.workflowId !== workflowId
        || report.baseCommitOid !== branch.baseCommitOid
        || report.headCommitOid !== expectedHead) {
        return await this.halt(store, state, "stale-final-review");
      }
      if (!report.eligible
        || report.status !== "ready-to-ship"
        || report.reasons.length !== 0) {
        return await this.halt(
          store,
          state,
          "human-decision-required",
          draft => { draft.finalGate = finalGateFor(report); },
        );
      }

      state = await store.transition({
        expectedRevision: state.revision,
        to: "pushing",
        update(draft) { draft.finalGate = finalGateFor(report); },
      });
      this.dependencies.emit?.("push");
      const pushed = await this.dependencies.hostingAdapter.pushBranch({
        checkoutPath: branch.worktreePath,
        target,
        branch: branch.branch,
        headCommitOid: expectedHead,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "push-failed")));
      if (pushed.remoteHead !== expectedHead) {
        return await this.halt(store, state, "push-head-mismatch");
      }

      state = await store.transition({
        expectedRevision: state.revision,
        to: "creating-draft-pr",
      });
      this.dependencies.emit?.("draft-pr");
      const pullRequest = await this.dependencies.hostingAdapter.ensureDraftPullRequest({
        checkoutPath: branch.worktreePath,
        target,
        baseBranch: branch.baseBranch,
        headBranch: branch.branch,
        headCommitOid: expectedHead,
        title: spec.shipping.pullRequestTitle,
        body: spec.shipping.pullRequestBody,
      }).catch(async error =>
        await this.halt(
          store,
          state,
          classificationOf(error, "draft-pull-request-failed"),
        ));
      if (!pullRequestMatches(pullRequest, target, branch, expectedHead, true)) {
        return await this.halt(store, state, "draft-pull-request-identity-mismatch");
      }

      state = await store.transition({
        expectedRevision: state.revision,
        to: "waiting-required-checks",
        update(draft) {
          draft.shipping.prNumber = pullRequest.number;
          draft.shipping.prUrl = pullRequest.url;
        },
      });

      while (true) {
        const beforePoll = Date.parse(this.now());
        if (!Number.isFinite(beforePoll) || beforePoll >= ciDeadlineMs) {
          return await this.halt(store, state, "required-checks-timeout");
        }
        const observation = await this.dependencies.hostingAdapter.requiredChecks({
          checkoutPath: branch.worktreePath,
          target,
          pullRequestNumber: pullRequest.number,
        }).catch(async error =>
          await this.halt(
            store,
            state,
            classificationOf(error, "required-checks-failed"),
          ));
        this.dependencies.emit?.(`checks:${observation.result === "passed"
          ? "pass"
          : observation.result === "failed" ? "red" : observation.result}`);
        const observedAt = this.now();
        const observedAtMs = Date.parse(observedAt);
        state = await store.update({
          expectedRevision: state.revision,
          update(draft) {
            draft.ciObservations.push({
              observedAt,
              result: observation.result,
              checks: structuredClone(observation.checks),
            });
          },
        });
        if (!Number.isFinite(observedAtMs) || observedAtMs >= ciDeadlineMs) {
          return await this.halt(store, state, "required-checks-timeout");
        }
        if (checksAreNonEmptyAndPassing(observation)) break;
        if (observation.result === "missing" || observation.checks.length === 0) {
          return await this.halt(store, state, "required-checks-missing");
        }
        if (observation.result === "failed"
          || observation.checks.some(check =>
            check.bucket !== "pass" && check.bucket !== "pending")) {
          return await this.halt(store, state, "required-checks-red");
        }
        const remainingMs = ciDeadlineMs - observedAtMs;
        await this.sleep(Math.min(this.pollIntervalMs, remainingMs)).catch(async error =>
          await this.halt(store, state, classificationOf(error, "checks-wait-failed")));
      }

      state = await store.transition({
        expectedRevision: state.revision,
        to: "marking-ready",
      });
      this.dependencies.emit?.("mark-ready");
      const readyPullRequest = await this.dependencies.hostingAdapter.markReady({
        checkoutPath: branch.worktreePath,
        target,
        pullRequestNumber: pullRequest.number,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "mark-ready-failed")));
      if (!pullRequestMatches(readyPullRequest, target, branch, expectedHead, false)
        || readyPullRequest.number !== pullRequest.number
        || readyPullRequest.url !== pullRequest.url) {
        return await this.halt(store, state, "mark-ready-identity-mismatch");
      }

      state = await store.transition({
        expectedRevision: state.revision,
        to: "cleaning-up",
      });
      const cleanup = await this.cleanupBranch(store, state, branch, expectedHead);
      pendingCleanup = {
        store,
        state,
        headCommitOid: expectedHead,
        pullRequest: readyPullRequest,
        cleanup,
      };
      return pendingCleanup;
    });
    } catch (error) {
      if (pendingCleanup !== null) {
        await this.finishCleanup(pendingCleanup, false, "workflow-lock-release-failed");
        throw new AutopilotControllerError(
          "workflow-lock-release-failed",
          "workflow lock release failed",
        );
      }
      if (bootstrapBranch !== null && !bootstrapCompleted) {
        const cleanup = await this.dependencies.branchManager.cleanup(
          bootstrapBranch,
          bootstrapBranch.baseCommitOid,
        ).catch((): BranchCleanupResult => ({
          ok: false,
          classification: "cleanup-failed",
        }));
        const cleanupSucceeded = cleanup.ok
          && cleanup.worktreeRemoved
          && cleanup.refsRemoved;
        const originalClassification = classificationOf(
          error,
          "workflow-bootstrap-failed",
        );
        const terminalClassification = cleanupSucceeded
          ? originalClassification
          : "workflow-bootstrap-cleanup-failed";
        if (bootstrapStore !== null
          && bootstrapState !== null
          && bootstrapLeaseAcquired) {
          await bootstrapStore.transition({
            expectedRevision: bootstrapState.revision,
            to: "failed",
            update: draft => {
              draft.terminal = {
                classification: "failed",
                reason: terminalClassification,
                evidenceRefs: [],
                completedAt: this.now(),
              };
            },
          });
          await bootstrapStore.releaseLease();
        }
        if (!cleanupSucceeded) {
          throw new AutopilotControllerError(
            "workflow-bootstrap-cleanup-failed",
            "workflow bootstrap failed and its branch could not be safely cleaned",
            { originalClassification },
          );
        }
      }
      throw error;
    }

    const result = await this.finishCleanup(completedCleanup, true);
    this.dependencies.emit?.("ready");
    return {
      ...result,
      status: "ready-for-human-review",
      headCommitOid: completedCleanup.headCommitOid,
      pullRequest: structuredClone(completedCleanup.pullRequest),
    };
  }

  async status(
    checkoutPath: string,
    workflowId: string,
  ): Promise<AutopilotStatusResult> {
    const store = this.dependencies.workflowStore(workflowId);
    const state = await store.read();
    await this.assertRepositoryIdentity(checkoutPath, workflowId, state);
    const branch = await this.dependencies.branchManager.load(workflowId);
    if (branch !== null && !branchMatchesState(checkoutPath, state, branch)) {
      throw new AutopilotControllerError(
        "workflow-identity-mismatch",
        "workflow branch identity does not match persisted state",
      );
    }
    if (!isTerminal(state) && branch === null) {
      throw new AutopilotControllerError(
        "workflow-identity-mismatch",
        "active workflow branch identity is unavailable",
      );
    }
    return redactedState(state);
  }

  async resume(
    checkoutPath: string,
    workflowId: string,
  ): Promise<AutopilotWorkflowState> {
    let pendingCleanup: CleanupContext | null = null;
    let outcome: AutopilotWorkflowState | CleanupContext;
    try {
      outcome = await this.dependencies.workflowLock.runExclusive(workflowId, async () => {
        const store = this.dependencies.workflowStore(workflowId);
        let state = await store.read();
        await this.assertRepositoryIdentity(checkoutPath, workflowId, state);
        if (isTerminal(state)) return state;
        await store.adoptLease();

        const recordedWorkflow = recordedWorkflowFrom(await store.readIntentJournal());
        const loadedBranch = await this.dependencies.branchManager.load(workflowId);
        const branch = loadedBranch ?? (
          state.phase === "cleaning-up" ? recordedWorkflow.branch : null
        );
        if (branch === null || !branchMatchesState(checkoutPath, state, branch)) {
          throw new AutopilotControllerError(
            "workflow-identity-mismatch",
            "workflow branch identity does not match persisted state",
          );
        }
        const validated = this.validator(recordedWorkflow.spec);
        if (!validated.ok
          || canonicalArtifactHash(validated.spec) !== state.autopilotSpecHash) {
          throw new AutopilotControllerError(
            "workflow-spec-mismatch",
            "recorded workflow specification does not match persisted state",
          );
        }

        const expectedHead = expectedHeadOf(state);
        if (state.phase !== "promoting-task" && state.phase !== "cleaning-up") {
          const revalidated = await this.dependencies.branchManager.revalidate(
            branch,
            expectedHead,
          );
          if (!revalidated.ok) {
            throw new AutopilotControllerError(
              revalidated.classification,
              "workflow branch cannot be proven for resume",
            );
          }
        }

        let target: HostingTarget;
        try {
          target = await this.dependencies.hostingAdapter.preflight({ checkoutPath });
        } catch (error) {
          throw new AutopilotControllerError(
            classificationOf(error, "preflight-failed"),
            "shipping preflight failed",
          );
        }
        if (branch.ownerRepo !== target.repository
          || branch.remoteUrl !== target.canonicalHttpsUrl) {
          throw new AutopilotControllerError(
            "repository-identity-mismatch",
            "shipping and workflow repository identities differ",
          );
        }

        const resumed = await this.resumeActiveWorkflow({
          store,
          state,
          spec: validated.spec,
          branch,
          target,
          expectedHead,
        });
        pendingCleanup = resumed;
        return resumed;
      });
    } catch (error) {
      if (pendingCleanup !== null) {
        await this.finishCleanup(pendingCleanup, false, "workflow-lock-release-failed");
        throw new AutopilotControllerError(
          "workflow-lock-release-failed",
          "workflow lock release failed",
        );
      }
      throw error;
    }

    if ("headCommitOid" in outcome) {
      return await this.finishCleanup(outcome, true);
    }
    return outcome;
  }

  private async assertRepositoryIdentity(
    checkoutPath: string,
    workflowId: string,
    state: AutopilotWorkflowState,
  ): Promise<void> {
    let repositoryIdentity: string;
    try {
      repositoryIdentity = await this.dependencies.repositoryIdentity(checkoutPath);
    } catch {
      throw new AutopilotControllerError(
        "repository-identity-mismatch",
        "repository identity cannot be proven",
      );
    }
    if (state.workflowId !== workflowId || repositoryIdentity !== state.repositoryIdentity) {
      throw new AutopilotControllerError(
        "repository-identity-mismatch",
        "repository does not own the requested workflow",
      );
    }
  }

  private async resumeActiveWorkflow(args: {
    store: WorkflowStorePort;
    state: AutopilotWorkflowState;
    spec: AutopilotSpec;
    branch: WorkflowBranchIdentity;
    target: HostingTarget;
    expectedHead: string;
  }): Promise<CleanupContext> {
    const { store, spec, branch, target } = args;
    let state = args.state;
    let expectedHead = args.expectedHead;

    while (state.phase === "preflighting"
      || state.phase === "running-task"
      || state.phase === "promoting-task") {
      const index = state.currentTaskIndex;
      const task = spec.tasks[index];
      const taskState = state.tasks[index];
      if (task === undefined || taskState === undefined || task.id !== taskState.id) {
        throw new AutopilotControllerError(
          "workflow-state-mismatch",
          "workflow task state cannot be proven",
        );
      }
      if (state.phase === "preflighting") {
        state = await store.transition({
          expectedRevision: state.revision,
          to: "running-task",
          update(draft) { draft.tasks[index]!.status = "running"; },
        });
      }

      if (state.phase === "running-task") {
        this.dependencies.emit?.(`task:${task.id}`);
        const pipelineResult = await this.dependencies.pipelineRunner.run(
          branch.worktreePath,
          task.delegation,
        ).catch(async error =>
          await this.halt(store, state, classificationOf(error, "pipeline-failed")));
        if (pipelineResult.status === "failed") {
          return await this.halt(store, state, "pipeline-failed");
        }
        if (pipelineResult.status === "human-decision-required"
          || pipelineResult.gate.requiresHumanDecision) {
          return await this.halt(store, state, "human-decision-required");
        }
        const snapshot = await this.dependencies.reviewSnapshotter.create({
          workflow: state,
          branch,
          task,
          pipelineResult,
        }).catch(async error =>
          await this.halt(
            store,
            state,
            classificationOf(error, "candidate-evidence-mismatch"),
          ));
        if (!snapshotMatchesCandidate(expectedHead, pipelineResult, snapshot)) {
          return await this.halt(store, state, "candidate-evidence-mismatch");
        }
        const eligibility = await this.dependencies.eligibilityEvaluator.evaluate({
          workflow: state,
          branch,
          task,
          pipelineResult,
          reviewSnapshot: snapshot,
        }).catch(async error =>
          await this.halt(store, state, classificationOf(error, "eligibility-red")));
        if (!eligibilityMatchesSnapshot(pipelineResult, snapshot, eligibility)) {
          return await this.halt(store, state, "candidate-evidence-mismatch");
        }
        if (!eligibility.eligible || eligibility.reasons.length !== 0) {
          return await this.halt(store, state, "eligibility-red");
        }
        const candidate = candidateFrom(pipelineResult)!;
        state = await store.transition({
          expectedRevision: state.revision,
          to: "promoting-task",
          update(draft) {
            const current = draft.tasks[index]!;
            current.runId = pipelineResult.runId;
            current.candidateManifestHash = candidate.manifestHash;
            current.eligibilityHash = autopilotEligibilityRecordHash(eligibility);
          },
        });
      }

      const current = state.tasks[index]!;
      if (current.runId === null
        || current.candidateManifestHash === null
        || current.eligibilityHash === null) {
        throw new AutopilotControllerError(
          "workflow-state-mismatch",
          "promotion intent is incomplete",
        );
      }
      this.dependencies.emit?.(`promote:${task.id}`);
      const promotion = await this.dependencies.promoter.promote({
        workflowId: state.workflowId,
        runId: current.runId,
        workflowCheckoutPath: branch.worktreePath,
        expectedHead,
        expectedArtifactHash: current.candidateManifestHash,
        commitMessage: task.commitMessage,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "promotion-failed")));
      if (promotion.status === "rejected") {
        return await this.halt(store, state, promotion.classification);
      }
      expectedHead = promotion.commitOid;
      const nextPhase = index === spec.tasks.length - 1 ? "final-review" : "running-task";
      state = await store.transition({
        expectedRevision: state.revision,
        to: nextPhase,
        update(draft) {
          const promoted = draft.tasks[index]!;
          promoted.status = "promoted";
          promoted.promotionCommitOid = promotion.commitOid;
          draft.currentTaskIndex = index + 1;
          if (nextPhase === "running-task") draft.tasks[index + 1]!.status = "running";
        },
      });
    }

    if (state.phase === "final-review") {
      this.dependencies.emit?.("final-review");
      const report = await this.dependencies.finalBranchReviewer.review({
        workflowId: state.workflowId,
        expectedRevision: state.revision,
        taskEvidence: state.tasks.map(task => ({
          taskId: task.id,
          runId: task.runId!,
          candidateManifestHash: task.candidateManifestHash!,
          promotionCommitOid: task.promotionCommitOid!,
          evidenceRefs: [...REQUIRED_TASK_EVIDENCE_REFS],
        })),
        autopilotSpec: spec,
        checkoutPath: branch.worktreePath,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "final-review-failed")));
      if (report.workflowId !== state.workflowId
        || report.baseCommitOid !== branch.baseCommitOid
        || report.headCommitOid !== expectedHead) {
        return await this.halt(store, state, "stale-final-review");
      }
      if (!report.eligible || report.status !== "ready-to-ship" || report.reasons.length !== 0) {
        return await this.halt(
          store,
          state,
          "human-decision-required",
          draft => { draft.finalGate = finalGateFor(report); },
        );
      }
      state = await store.transition({
        expectedRevision: state.revision,
        to: "pushing",
        update(draft) { draft.finalGate = finalGateFor(report); },
      });
    }

    if (state.phase === "pushing") {
      this.dependencies.emit?.("push");
      const pushed = await this.dependencies.hostingAdapter.pushBranch({
        checkoutPath: branch.worktreePath,
        target,
        branch: branch.branch,
        headCommitOid: expectedHead,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "push-failed")));
      if (pushed.remoteHead !== expectedHead) {
        return await this.halt(store, state, "push-head-mismatch");
      }
      state = await store.transition({
        expectedRevision: state.revision,
        to: "creating-draft-pr",
      });
    }

    let pullRequest: PullRequestIdentity;
    if (state.phase === "creating-draft-pr") {
      this.dependencies.emit?.("draft-pr");
      pullRequest = await this.dependencies.hostingAdapter.ensureDraftPullRequest({
        checkoutPath: branch.worktreePath,
        target,
        baseBranch: branch.baseBranch,
        headBranch: branch.branch,
        headCommitOid: expectedHead,
        title: spec.shipping.pullRequestTitle,
        body: spec.shipping.pullRequestBody,
      }).catch(async error =>
        await this.halt(
          store,
          state,
          classificationOf(error, "draft-pull-request-failed"),
        ));
      if (!pullRequestMatches(pullRequest, target, branch, expectedHead, true)) {
        return await this.halt(store, state, "draft-pull-request-identity-mismatch");
      }
      state = await store.transition({
        expectedRevision: state.revision,
        to: "waiting-required-checks",
        update(draft) {
          draft.shipping.prNumber = pullRequest.number;
          draft.shipping.prUrl = pullRequest.url;
        },
      });
    } else {
      if (state.shipping.prNumber === null || state.shipping.prUrl === null) {
        throw new AutopilotControllerError(
          "workflow-state-mismatch",
          "shipping identity is incomplete",
        );
      }
      pullRequest = {
        number: state.shipping.prNumber,
        url: state.shipping.prUrl,
        repository: target.repository,
        baseBranch: branch.baseBranch,
        headBranch: branch.branch,
        headCommitOid: expectedHead,
        draft: state.phase !== "cleaning-up",
      };
      if (state.phase === "marking-ready" && !stateHasPassingChecks(state)) {
        return await this.halt(store, state, "required-checks-proof-missing");
      }
      if (state.phase === "waiting-required-checks" || state.phase === "marking-ready") {
        const establishedPullRequest = await this.dependencies.hostingAdapter
          .ensureDraftPullRequest({
            checkoutPath: branch.worktreePath,
            target,
            baseBranch: branch.baseBranch,
            headBranch: branch.branch,
            headCommitOid: expectedHead,
            title: spec.shipping.pullRequestTitle,
            body: spec.shipping.pullRequestBody,
          })
          .catch(async error =>
            await this.halt(
              store,
              state,
              classificationOf(error, "draft-pull-request-failed"),
            ));
        const expectedDraft = state.phase === "waiting-required-checks";
        if (!pullRequestIdentityMatches(
          establishedPullRequest,
          target,
          branch,
          expectedHead,
        ) || (expectedDraft && !establishedPullRequest.draft)
          || establishedPullRequest.number !== pullRequest.number
          || establishedPullRequest.url !== pullRequest.url) {
          return await this.halt(store, state, "draft-pull-request-identity-mismatch");
        }
        pullRequest = establishedPullRequest;
        if (state.phase === "marking-ready" && !pullRequest.draft) {
          state = await store.transition({
            expectedRevision: state.revision,
            to: "cleaning-up",
          });
        }
      }
    }

    if (state.phase === "waiting-required-checks") {
      const deadlineMs = Date.parse(state.shipping.ciDeadlineAt);
      if (!Number.isFinite(deadlineMs)) {
        return await this.halt(store, state, "required-checks-timeout");
      }
      while (true) {
        const beforePoll = Date.parse(this.now());
        if (!Number.isFinite(beforePoll) || beforePoll >= deadlineMs) {
          return await this.halt(store, state, "required-checks-timeout");
        }
        const observation = await this.dependencies.hostingAdapter.requiredChecks({
          checkoutPath: branch.worktreePath,
          target,
          pullRequestNumber: pullRequest.number,
        }).catch(async error =>
          await this.halt(store, state, classificationOf(error, "required-checks-failed")));
        this.dependencies.emit?.(`checks:${observation.result === "passed"
          ? "pass"
          : observation.result === "failed" ? "red" : observation.result}`);
        const observedAt = this.now();
        const observedAtMs = Date.parse(observedAt);
        state = await store.update({
          expectedRevision: state.revision,
          update(draft) {
            draft.ciObservations.push({
              observedAt,
              result: observation.result,
              checks: structuredClone(observation.checks),
            });
          },
        });
        if (!Number.isFinite(observedAtMs) || observedAtMs >= deadlineMs) {
          return await this.halt(store, state, "required-checks-timeout");
        }
        if (checksAreNonEmptyAndPassing(observation)) break;
        if (observation.result === "missing" || observation.checks.length === 0) {
          return await this.halt(store, state, "required-checks-missing");
        }
        if (observation.result === "failed"
          || observation.checks.some(check =>
            check.bucket !== "pass" && check.bucket !== "pending")) {
          return await this.halt(store, state, "required-checks-red");
        }
        const remainingMs = deadlineMs - observedAtMs;
        await this.sleep(Math.min(this.pollIntervalMs, remainingMs)).catch(async error =>
          await this.halt(store, state, classificationOf(error, "checks-wait-failed")));
      }
      state = await store.transition({
        expectedRevision: state.revision,
        to: "marking-ready",
      });
    }

    if (state.phase === "marking-ready") {
      this.dependencies.emit?.("mark-ready");
      const readyPullRequest = await this.dependencies.hostingAdapter.markReady({
        checkoutPath: branch.worktreePath,
        target,
        pullRequestNumber: pullRequest.number,
      }).catch(async error =>
        await this.halt(store, state, classificationOf(error, "mark-ready-failed")));
      if (!pullRequestMatches(readyPullRequest, target, branch, expectedHead, false)
        || readyPullRequest.number !== pullRequest.number
        || readyPullRequest.url !== pullRequest.url) {
        return await this.halt(store, state, "mark-ready-identity-mismatch");
      }
      state = await store.transition({
        expectedRevision: state.revision,
        to: "cleaning-up",
      });
    }

    if (state.phase !== "cleaning-up") {
      throw new AutopilotControllerError(
        "resume-phase-unproven",
        "workflow phase cannot be safely resumed",
      );
    }
    const cleanup = await this.cleanupBranch(
      store,
      state,
      branch,
      expectedHead,
    );
    return { store, state, headCommitOid: expectedHead, pullRequest, cleanup };
  }

  private async cleanupBranch(
    store: WorkflowStorePort,
    state: AutopilotWorkflowState,
    branch: WorkflowBranchIdentity,
    expectedHead: string,
  ): Promise<BranchCleanupResult> {
    const key = cleanupIntentKey(expectedHead);
    const journal = await store.readIntentJournal();
    const completed = cleanupProofFrom(journal, expectedHead);
    if (completed !== null) return completed;

    const existing = journal.intents.find(intent =>
      intent.intent.operation === CLEANUP_INTENT_OPERATION
      && intent.intent.idempotencyKey === key);
    if (existing === undefined) {
      await store.beginIntent({
        expectedRevision: state.revision,
        operation: CLEANUP_INTENT_OPERATION,
        idempotencyKey: key,
        expectedIdentities: { headCommitOid: expectedHead },
      });
    }

    this.dependencies.emit?.("cleanup");
    const cleanup = await this.dependencies.branchManager.cleanup(branch, expectedHead)
      .catch((): BranchCleanupResult => ({ ok: false, classification: "cleanup-failed" }));
    if (cleanup.ok && cleanup.worktreeRemoved && cleanup.refsRemoved) {
      await store.completeIntent({
        expectedRevision: state.revision,
        idempotencyKey: key,
        completion: {
          worktreeRemoved: true,
          refsRemoved: true,
        },
      });
    }
    return cleanup;
  }

  private async halt(
    store: WorkflowStorePort,
    state: AutopilotWorkflowState,
    classification: string,
    update?: (draft: AutopilotWorkflowState) => void,
  ): Promise<never> {
    const phase = terminalPhase(classification);
    await store.transition({
      expectedRevision: state.revision,
      to: phase,
      update: draft => {
        update?.(draft);
        const task = draft.tasks[draft.currentTaskIndex];
        if (task !== undefined && task.status !== "promoted") task.status = "halted";
        draft.terminal = {
          classification: phase,
          reason: classification,
          evidenceRefs: [],
          completedAt: this.now(),
        };
      },
    });
    await store.releaseLease();
    throw new AutopilotControllerError(classification);
  }

  private async finishCleanup(
    context: CleanupContext,
    lockReleased: boolean,
    releaseError?: string,
  ): Promise<AutopilotWorkflowState> {
    const worktreeRemoved = context.cleanup.ok && context.cleanup.worktreeRemoved;
    const refsRemoved = context.cleanup.ok && context.cleanup.refsRemoved;
    const succeeded = worktreeRemoved && refsRemoved && lockReleased;
    const classification = releaseError ?? "cleanup-failed";
    const completedAt = this.now();
    const next = await context.store.transition({
      expectedRevision: context.state.revision,
      to: succeeded ? "ready-for-human-review" : "failed",
      update(draft) {
        draft.cleanup = {
          status: succeeded ? "succeeded" : "failed",
          worktreeRemoved,
          lockReleased,
          error: succeeded ? null : classification,
          completedAt,
        };
        draft.terminal = {
          classification: succeeded ? "ready-for-human-review" : "failed",
          reason: succeeded ? null : classification,
          evidenceRefs: draft.finalGate === null ? [] : [draft.finalGate.reportRef],
          completedAt,
        };
      },
    });
    await context.store.releaseLease();
    if (!succeeded) throw new AutopilotControllerError(classification);
    return next;
  }
}
