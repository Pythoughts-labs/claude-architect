export interface HostingPreflight {
  checkoutPath: string;
  expectedRepository?: string;
}

export interface HostingTarget {
  provider: "github";
  repository: string;
  canonicalHttpsUrl: string;
}

export interface PushRequest {
  checkoutPath: string;
  target: HostingTarget;
  branch: string;
  headCommitOid: string;
}

export interface DraftPullRequestRequest {
  checkoutPath: string;
  target: HostingTarget;
  baseBranch: string;
  headBranch: string;
  headCommitOid: string;
  title: string;
  body: string;
}

export interface PullRequestIdentity {
  number: number;
  url: string;
  repository: string;
  baseBranch: string;
  headBranch: string;
  headCommitOid: string;
  draft: boolean;
}

export interface ChecksRequest {
  checkoutPath: string;
  target: HostingTarget;
  pullRequestNumber: number;
}

export type RequiredCheckBucket = "pass" | "pending" | "fail" | "cancel" | "skipping";

export interface RequiredCheck {
  bucket: RequiredCheckBucket;
  name: string;
  state: string;
  link: string | null;
}

export interface RequiredChecksResult {
  result: "missing" | "pending" | "failed" | "passed";
  checks: RequiredCheck[];
}

export interface MarkReadyRequest {
  checkoutPath: string;
  target: HostingTarget;
  pullRequestNumber: number;
}

export interface HostingAdapter {
  preflight(request: HostingPreflight): Promise<HostingTarget>;
  pushBranch(request: PushRequest): Promise<{ remoteHead: string }>;
  ensureDraftPullRequest(request: DraftPullRequestRequest): Promise<PullRequestIdentity>;
  requiredChecks(request: ChecksRequest): Promise<RequiredChecksResult>;
  markReady(request: MarkReadyRequest): Promise<PullRequestIdentity>;
}
