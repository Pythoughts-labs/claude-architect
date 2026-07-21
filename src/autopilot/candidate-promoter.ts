import { createHash } from "node:crypto";
import { git, type GitResult } from "../git/git-exec.js";
import { stageCandidateTreeUnderLock, type IntegrationResult } from "../integrate/controlled-integrator.js";
import type { CheckoutLock, PlatformServices } from "../platform/platform-services.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type { PipelineResult } from "../pipeline/pipeline-runtime.js";
import type { CandidateArtifact, ChangedPath } from "../protocol/attempt-result.js";
import { ArtifactStore } from "../runtime/artifact-store.js";
import { reviewSnapshotHash } from "../runtime/review-snapshot.js";
import {
  WorkflowBranchManager,
  type WorkflowBranchIdentity,
} from "./branch-manager.js";
import {
  advisorReportHash,
  autopilotEligibilityRecordHash,
  pipelineResultHash,
  type AutopilotEligibilityRecord,
} from "./autopilot-eligibility.js";
import type { AutopilotWorkflowState } from "./types.js";
import { WorkflowStore } from "./workflow-store.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type PromotionClassification =
  | "invalid-request"
  | "invalid-commit-message"
  | "workflow-state-mismatch"
  | "run-evidence-missing"
  | "eligibility-missing"
  | "eligibility-red"
  | "eligibility-stale"
  | "artifact-hash-mismatch"
  | "evidence-mismatch"
  | "decision-conflict"
  | "branch-identity-changed"
  | "dirty-worktree"
  | "head-changed"
  | "apply-conflict"
  | "git-identity-missing"
  | "commit-creation-failed"
  | "commit-proof-failed"
  | "update-ref-race"
  | "post-commit-divergence"
  | "journal-failed"
  | "anchor-deletion-failed"
  | "lock-release-failed"
  | "human-decision-required";

export type PromotionResult =
  | { status: "committed"; commitOid: string }
  | { status: "rejected"; classification: PromotionClassification };

export interface PromotionRequest {
  workflowId: string;
  runId: string;
  workflowCheckoutPath: string;
  expectedHead: string;
  expectedArtifactHash: string;
  commitMessage: string;
}

export interface CandidatePromoterDependencies {
  git?: typeof git;
  platformServices?: PlatformServices;
  branchManager?: WorkflowBranchManager;
  workflowStore?: (workflowId: string) => WorkflowStore;
  artifactStore?: (runId: string) => ArtifactStore;
  stageCandidate?: typeof stageCandidateTreeUnderLock;
  now?: () => string;
}

function safeCommitMessage(message: string): boolean {
  return message.trim().length > 0
    && Buffer.byteLength(message, "utf8") <= 200
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(message)
    && !/\bco-authored-by\s*:/iu.test(message)
    && !/\bgenerated(?:-|\s+)(?:by|with)\b/iu.test(message)
    && !/\b(?:ai|claude|codex|chatgpt|copilot|gemini|llm)[ -]generated\b/iu.test(message);
}

function succeeded(result: GitResult): boolean {
  return result.exitCode === 0
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true;
}

function rejected(classification: PromotionClassification): PromotionResult {
  return { status: "rejected", classification };
}

function commitMessageHash(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function statusMatchesArtifact(output: string, changedPaths: ChangedPath[]): boolean {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.length !== changedPaths.length) return false;
  const actual = new Map<string, string>();
  for (const record of records) {
    if (record.length < 4 || record[1] !== " " || record[2] !== " ") return false;
    const pathname = record.slice(3);
    if (actual.has(pathname)) return false;
    actual.set(pathname, record[0]!);
  }
  return changedPaths.every(change => actual.get(change.path) === (
    change.changeType === "added" ? "A" : change.changeType === "deleted" ? "D" : "M"
  ));
}

function workflowStillAuthorizes(
  workflow: AutopilotWorkflowState,
  request: PromotionRequest,
  taskId: string,
  eligibilityHash: string,
  expectedWorkflowRef: string,
  expectedRepositoryIdentity: string,
): boolean {
  const task = workflow.tasks[workflow.currentTaskIndex];
  return workflow.phase === "promoting-task"
    && workflow.workflowId === request.workflowId
    && workflow.worktreePath === request.workflowCheckoutPath
    && workflow.workflowRef === expectedWorkflowRef
    && workflow.repositoryIdentity === expectedRepositoryIdentity
    && task?.id === taskId
    && task.runId === request.runId
    && task.candidateManifestHash === request.expectedArtifactHash
    && task.eligibilityHash === eligibilityHash;
}

type LockedPromotionOutcome =
  | { kind: "committed"; commitOid: string; needsJournal: boolean }
  | { kind: "rejected"; classification: PromotionClassification; journalFailure: boolean };

function classifyStage(result: IntegrationResult): PromotionClassification {
  if (result.detail === "artifact-hash-mismatch") return "artifact-hash-mismatch";
  if (result.detail === "base-changed") return "head-changed";
  if (result.integration === "conflicted") return "apply-conflict";
  return "evidence-mismatch";
}

function completionCommit(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const commitOid = (value as { commitOid?: unknown }).commitOid;
  return typeof commitOid === "string" && OBJECT_ID.test(commitOid) ? commitOid : null;
}

function completionFailure(value: unknown): PromotionClassification | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const classification = (value as { classification?: unknown }).classification;
  return typeof classification === "string" ? classification as PromotionClassification : null;
}

export class CandidatePromoter {
  private readonly runGit: typeof git;
  private readonly platformServices: PlatformServices;
  private readonly branchManager: WorkflowBranchManager;
  private readonly workflowStore: (workflowId: string) => WorkflowStore;
  private readonly artifactStore: (runId: string) => ArtifactStore;
  private readonly stageCandidate: typeof stageCandidateTreeUnderLock;
  private readonly now: () => string;

  constructor(dependencies: CandidatePromoterDependencies = {}) {
    this.runGit = dependencies.git ?? git;
    this.platformServices = dependencies.platformServices ?? getPlatformServices();
    this.branchManager = dependencies.branchManager ?? new WorkflowBranchManager();
    this.workflowStore = dependencies.workflowStore ?? (workflowId => new WorkflowStore(workflowId));
    this.artifactStore = dependencies.artifactStore ?? (runId => new ArtifactStore(runId));
    this.stageCandidate = dependencies.stageCandidate ?? stageCandidateTreeUnderLock;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  private async proveCommit(
    checkout: string,
    commitOid: string,
    treeOid: string,
    parentOid: string,
    message: string,
  ): Promise<boolean> {
    const [tree, parent, body] = await Promise.all([
      this.runGit(checkout, ["rev-parse", "--verify", `${commitOid}^{tree}`]),
      this.runGit(checkout, ["rev-parse", "--verify", `${commitOid}^`]),
      this.runGit(checkout, ["log", "-1", "--format=%B", commitOid]),
    ]);
    return succeeded(tree) && tree.stdout.trim() === treeOid
      && succeeded(parent) && parent.stdout.trim() === parentOid
      && succeeded(body) && body.stdout.trimEnd() === message;
  }

  private async deleteAnchor(checkout: string, artifact: CandidateArtifact): Promise<boolean> {
    const current = await this.runGit(checkout, [
      "rev-parse", "--verify", "--quiet", artifact.anchorRef,
    ]);
    if (current.exitCode === 1 && current.stdout === "") return true;
    if (!succeeded(current) || current.stdout.trim().split(/\s/u)[0] !== artifact.candidateCommitOid) {
      return false;
    }
    return succeeded(await this.runGit(checkout, [
      "update-ref", "--no-deref", "-d", artifact.anchorRef, artifact.candidateCommitOid,
    ]));
  }

  private async provePromotedCheckout(
    identity: WorkflowBranchIdentity,
    lock: CheckoutLock,
    commitOid: string,
    treeOid: string,
  ): Promise<boolean> {
    const proven = await this.branchManager.revalidateUnderLock(identity, commitOid, lock);
    if (!proven.ok) return false;
    const [directRef, head, index, diff, status] = await Promise.all([
      this.runGit(identity.worktreePath, ["show-ref", "--verify", identity.branchRef]),
      this.runGit(identity.worktreePath, ["rev-parse", "--verify", "HEAD"]),
      this.runGit(identity.worktreePath, ["write-tree"]),
      this.runGit(identity.worktreePath, ["diff", "--quiet", "--no-ext-diff"]),
      this.runGit(identity.worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none", "--no-renames",
      ]),
    ]);
    return succeeded(directRef) && directRef.stdout.trim().split(/\s/u)[0] === commitOid
      && succeeded(head) && head.stdout.trim() === commitOid
      && succeeded(index) && index.stdout.trim() === treeOid
      && succeeded(diff) && succeeded(status) && status.stdout === "";
  }

  private async proveStagedCandidate(
    identity: WorkflowBranchIdentity,
    artifact: CandidateArtifact,
  ): Promise<boolean> {
    const [head, branch, index, diff, status] = await Promise.all([
      this.runGit(identity.worktreePath, ["rev-parse", "--verify", "HEAD"]),
      this.runGit(identity.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
      this.runGit(identity.worktreePath, ["write-tree"]),
      this.runGit(identity.worktreePath, ["diff", "--quiet", "--no-ext-diff"]),
      this.runGit(identity.worktreePath, [
        "status", "--porcelain=v1", "-z", "--untracked-files=all",
        "--ignore-submodules=none", "--no-renames",
      ]),
    ]);
    return succeeded(head) && head.stdout.trim() === artifact.baseCommitOid
      && succeeded(branch) && branch.stdout.trim() === identity.branchRef
      && succeeded(index) && index.stdout.trim() === artifact.candidateTreeOid
      && succeeded(diff)
      && succeeded(status) && statusMatchesArtifact(status.stdout, artifact.changedPaths);
  }

  private async ensureAcceptedDecision(
    artifactStore: ArtifactStore,
    runId: string,
    artifact: CandidateArtifact,
    eligibility: AutopilotEligibilityRecord,
    eligibilityHash: string,
  ): Promise<boolean> {
    try {
      let decision = await artifactStore.readCandidateDecision(runId);
      if (decision === null) {
        await artifactStore.writeAutopilotDecision(artifact, eligibility, this.now());
        decision = await artifactStore.readCandidateDecision(runId);
      }
      return decision?.decisionVersion === "2"
        && decision.authority === "autopilot-policy"
        && decision.decision === "accepted"
        && decision.candidateManifestHash === artifact.manifestHash
        && decision.evidenceHash === eligibilityHash;
    } catch {
      return false;
    }
  }

  async promote(request: PromotionRequest): Promise<PromotionResult> {
    if (!OBJECT_ID.test(request.expectedHead)
      || !SHA256.test(request.expectedArtifactHash)
      || request.workflowCheckoutPath.length === 0) return rejected("invalid-request");
    if (!safeCommitMessage(request.commitMessage)) return rejected("invalid-commit-message");

    const workflowStore = this.workflowStore(request.workflowId);
    const artifactStore = this.artifactStore(request.runId);
    let workflow;
    try {
      workflow = await workflowStore.read();
    } catch {
      return rejected("workflow-state-mismatch");
    }
    const task = workflow.tasks[workflow.currentTaskIndex];
    if (workflow.phase !== "promoting-task"
      || workflow.worktreePath !== request.workflowCheckoutPath
      || workflow.workflowId !== request.workflowId
      || task === undefined
      || task.runId !== request.runId
      || task.candidateManifestHash !== request.expectedArtifactHash) {
      return rejected("workflow-state-mismatch");
    }

    const idempotencyKey = `promote:${task.id}`;
    let intent;
    try {
      intent = await workflowStore.beginIntent({
        expectedRevision: workflow.revision,
        operation: "promote-candidate",
        idempotencyKey,
        expectedIdentities: {
          runId: request.runId,
          expectedHead: request.expectedHead,
          candidateManifestHash: request.expectedArtifactHash,
          commitMessageHash: commitMessageHash(request.commitMessage),
          workflowRef: workflow.workflowRef,
        },
      });
    } catch {
      return rejected("journal-failed");
    }
    const priorFailure = completionFailure(intent.completion?.failure);
    if (priorFailure !== null) return rejected(priorFailure);

    const finishFailure = async (classification: PromotionClassification): Promise<PromotionResult> => {
      if (intent.completion === null) {
        try {
          await workflowStore.completeIntent({
            idempotencyKey,
            failure: { classification, message: classification },
          });
        } catch {
          return rejected("journal-failed");
        }
      }
      return rejected(classification);
    };

    let result;
    let manifest;
    let pipelineResult;
    let snapshot;
    let advisor;
    let eligibility: AutopilotEligibilityRecord | null;
    try {
      [result, manifest, pipelineResult, snapshot, advisor, eligibility] = await Promise.all([
        artifactStore.readResult(request.runId),
        artifactStore.readManifest(request.runId),
        artifactStore.readPipelineArtifact<PipelineResult>(request.runId, "pipeline-result"),
        artifactStore.readReviewSnapshot(request.runId),
        artifactStore.readAdvisorReport(request.runId),
        artifactStore.readAutopilotEligibility(request.runId),
      ]);
    } catch {
      return finishFailure("evidence-mismatch");
    }
    if (eligibility === null) return finishFailure("eligibility-missing");
    if (!eligibility.eligible || eligibility.reasons.length !== 0) {
      return finishFailure("eligibility-red");
    }
    const eligibilityHash = autopilotEligibilityRecordHash(eligibility);
    if (task.eligibilityHash !== eligibilityHash) return finishFailure("eligibility-stale");
    const artifact = result?.candidate ?? null;
    if (result === null || manifest === null || pipelineResult === null || snapshot === null
      || advisor === null || artifact === null) return finishFailure("run-evidence-missing");
    let evidenceHashesMatch = false;
    try {
      evidenceHashesMatch = eligibility.pipelineResultHash === pipelineResultHash(pipelineResult)
        && eligibility.reviewSnapshotHash === reviewSnapshotHash(snapshot)
        && eligibility.advisorReportHash === advisorReportHash(advisor);
    } catch {
      return finishFailure("evidence-mismatch");
    }
    if (result.status !== "verified-candidate"
      || result.runId !== request.runId
      || manifest.runId !== request.runId
      || manifest.repoRoot !== request.workflowCheckoutPath
      || manifest.baseCommitOid !== request.expectedHead
      || manifest.candidateManifestHash !== request.expectedArtifactHash
      || artifact.baseCommitOid !== request.expectedHead
      || artifact.manifestHash !== request.expectedArtifactHash
      || eligibility.baseCommitOid !== request.expectedHead
      || eligibility.candidateCommitOid !== artifact.candidateCommitOid
      || eligibility.candidateTreeOid !== artifact.candidateTreeOid
      || eligibility.candidateManifestHash !== artifact.manifestHash
      || !evidenceHashesMatch) {
      return finishFailure("evidence-mismatch");
    }

    const identity = await this.branchManager.load(request.workflowId);
    if (identity === null
      || identity.worktreePath !== request.workflowCheckoutPath
      || identity.branchRef !== workflow.workflowRef
      || identity.repositoryIdentity !== workflow.repositoryIdentity) {
      return finishFailure("branch-identity-changed");
    }

    let lock;
    try {
      lock = await this.platformServices.acquireCheckoutLock(request.workflowCheckoutPath);
    } catch {
      return finishFailure("branch-identity-changed");
    }
    let terminal: PromotionResult;
    try {
      const completedOid = intent.completion === null
        ? null
        : completionCommit(intent.completion.completion);
      let lockedOutcome: LockedPromotionOutcome;
      try {
        lockedOutcome = await workflowStore.withLockedState(workflow.revision, async locked => {
          if (!workflowStillAuthorizes(
            locked,
            request,
            task.id,
            eligibilityHash,
            workflow.workflowRef,
            workflow.repositoryIdentity,
          )) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          if (completedOid !== null) {
            const proven = await this.provePromotedCheckout(
              identity, lock, completedOid, artifact.candidateTreeOid,
            ) && await this.proveCommit(request.workflowCheckoutPath, completedOid,
              artifact.candidateTreeOid, request.expectedHead, request.commitMessage);
            if (proven && !await this.ensureAcceptedDecision(
              artifactStore, request.runId, artifact, eligibility, eligibilityHash,
            )) {
              return {
                kind: "rejected", classification: "decision-conflict", journalFailure: true,
              };
            }
            return proven
              ? { kind: "committed", commitOid: completedOid, needsJournal: false }
              : {
                kind: "rejected", classification: "human-decision-required",
                journalFailure: false,
              };
          }

          const currentHead = await this.runGit(
            request.workflowCheckoutPath, ["rev-parse", "--verify", "HEAD"],
          );
          if (!succeeded(currentHead)) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          if (currentHead.stdout.trim() !== request.expectedHead) {
            const existingOid = currentHead.stdout.trim();
            const proven = OBJECT_ID.test(existingOid)
              && await this.provePromotedCheckout(
                identity, lock, existingOid, artifact.candidateTreeOid,
              )
              && await this.proveCommit(request.workflowCheckoutPath, existingOid,
                artifact.candidateTreeOid, request.expectedHead, request.commitMessage);
            if (proven && !await this.ensureAcceptedDecision(
              artifactStore, request.runId, artifact, eligibility, eligibilityHash,
            )) {
              return {
                kind: "rejected", classification: "decision-conflict", journalFailure: true,
              };
            }
            return proven
              ? { kind: "committed", commitOid: existingOid, needsJournal: true }
              : {
                kind: "rejected", classification: "human-decision-required",
                journalFailure: false,
              };
          }

          const liveIdentity = await this.branchManager.revalidateForStagedPromotionUnderLock(
            identity, request.expectedHead, lock,
          );
          if (!liveIdentity.ok) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          const exactStagedRecovery = await this.proveStagedCandidate(identity, artifact);
          if (!exactStagedRecovery) {
            const branch = await this.branchManager.revalidateUnderLock(
              identity, request.expectedHead, lock,
            );
            if (!branch.ok) {
              return {
                kind: "rejected", classification: "human-decision-required",
                journalFailure: false,
              };
            }
            if (!await this.ensureAcceptedDecision(
              artifactStore, request.runId, artifact, eligibility, eligibilityHash,
            )) {
              return {
                kind: "rejected", classification: "decision-conflict", journalFailure: true,
              };
            }
            const staged = await this.stageCandidate({
              repoRoot: request.workflowCheckoutPath,
              artifact,
              expectedArtifactHash: request.expectedArtifactHash,
              borrowedCheckoutLock: lock,
              platformServices: this.platformServices,
            });
            if (staged.integration !== "applied") {
              return staged.integration === "conflicted"
                ? {
                  kind: "rejected", classification: "human-decision-required",
                  journalFailure: false,
                }
                : {
                  kind: "rejected", classification: classifyStage(staged), journalFailure: true,
                };
            }
          } else if (!await this.ensureAcceptedDecision(
            artifactStore, request.runId, artifact, eligibility, eligibilityHash,
          )) {
            return {
              kind: "rejected", classification: "decision-conflict", journalFailure: true,
            };
          }
          if (!await this.proveStagedCandidate(identity, artifact)) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          const [author, committer] = await Promise.all([
            this.runGit(request.workflowCheckoutPath, ["var", "GIT_AUTHOR_IDENT"]),
            this.runGit(request.workflowCheckoutPath, ["var", "GIT_COMMITTER_IDENT"]),
          ]);
          if (!succeeded(author) || !succeeded(committer)) {
            return {
              kind: "rejected", classification: "git-identity-missing", journalFailure: true,
            };
          }
          const created = await this.runGit(request.workflowCheckoutPath, [
            "commit-tree", artifact.candidateTreeOid, "-p", request.expectedHead,
            "-m", request.commitMessage,
          ]);
          const commitOid = created.stdout.trim();
          if (!succeeded(created) || !OBJECT_ID.test(commitOid)) {
            return {
              kind: "rejected", classification: "commit-creation-failed", journalFailure: true,
            };
          }
          if (!await this.proveCommit(request.workflowCheckoutPath, commitOid,
            artifact.candidateTreeOid, request.expectedHead, request.commitMessage)) {
            return {
              kind: "rejected", classification: "commit-proof-failed", journalFailure: true,
            };
          }
          const updated = await this.runGit(request.workflowCheckoutPath, [
            "update-ref", "--no-deref", identity.branchRef, commitOid, request.expectedHead,
          ]);
          if (!succeeded(updated)) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          if (!await this.provePromotedCheckout(
            identity, lock, commitOid, artifact.candidateTreeOid,
          )) {
            return {
              kind: "rejected", classification: "human-decision-required", journalFailure: false,
            };
          }
          return { kind: "committed", commitOid, needsJournal: true };
        });
      } catch (error) {
        const toolError = (error as { detail?: { toolError?: unknown } }).detail?.toolError;
        if (toolError !== "workflow-revision-conflict") throw error;
        lockedOutcome = {
          kind: "rejected", classification: "human-decision-required", journalFailure: false,
        };
      }

      if (lockedOutcome.kind === "rejected") {
        terminal = lockedOutcome.journalFailure
          ? await finishFailure(lockedOutcome.classification)
          : rejected(lockedOutcome.classification);
      } else {
        let journaled = !lockedOutcome.needsJournal;
        if (!journaled) {
          try {
            await workflowStore.completeIntent({
              idempotencyKey, completion: { commitOid: lockedOutcome.commitOid },
            });
            journaled = true;
          } catch {
            journaled = false;
          }
        }
        terminal = !journaled
          ? rejected("journal-failed")
          : await this.deleteAnchor(request.workflowCheckoutPath, artifact)
            ? { status: "committed", commitOid: lockedOutcome.commitOid }
            : rejected("anchor-deletion-failed");
      }
    } finally {
      try {
        await lock.release();
      } catch {
        terminal = rejected("lock-release-failed");
      }
    }
    return terminal!;
  }
}
