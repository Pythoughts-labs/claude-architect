import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import type { PlatformServices, SupervisedExit } from "../platform/platform-services.js";
import { supervise } from "../platform/process-supervisor.js";
import { getPlatformServices } from "../platform/select-platform.js";
import type {
  ChecksRequest,
  DraftPullRequestRequest,
  HostingAdapter,
  HostingPreflight,
  HostingTarget,
  MarkReadyRequest,
  PullRequestIdentity,
  PushRequest,
  RequiredCheck,
  RequiredChecksResult,
} from "./hosting-adapter.js";

const MINIMUM_GH_VERSION = [2, 96, 0] as const;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY_COMPONENT = /^[A-Za-z0-9_.-]+$/u;
const MAX_OUTPUT_BYTES = 1_000_000;
const COMMAND_TIMEOUT_MS = 60_000;
const CREDENTIAL_HELPER_ARGS = [
  "-c", "credential.helper=",
  "-c", "credential.helper=!gh auth git-credential",
] as const;

export type HostingAdapterErrorClassification =
  | "preflight-gh-unavailable"
  | "preflight-gh-version-invalid"
  | "preflight-gh-version-unsupported"
  | "preflight-auth-failed"
  | "preflight-repository-query-failed"
  | "preflight-repository-response-invalid"
  | "preflight-repository-url-invalid"
  | "preflight-repository-identity-mismatch"
  | "push-request-invalid"
  | "push-quarantine-create-failed"
  | "push-quarantine-init-failed"
  | "push-bundle-create-failed"
  | "push-bundle-import-failed"
  | "push-imported-oid-mismatch"
  | "push-remote-precheck-failed"
  | "push-remote-response-invalid"
  | "push-remote-head-mismatch"
  | "push-command-failed"
  | "push-quarantine-cleanup-failed"
  | "draft-pull-request-request-invalid"
  | "draft-pull-request-list-failed"
  | "draft-pull-request-response-invalid"
  | "draft-pull-request-identity-mismatch"
  | "draft-pull-request-head-mismatch"
  | "draft-pull-request-ambiguous"
  | "draft-pull-request-create-failed"
  | "required-checks-request-invalid"
  | "required-checks-identity-not-established"
  | "required-checks-identity-query-failed"
  | "required-checks-identity-response-invalid"
  | "required-checks-identity-mismatch"
  | "required-checks-command-failed"
  | "required-checks-response-invalid"
  | "mark-ready-request-invalid"
  | "mark-ready-identity-not-established"
  | "mark-ready-identity-query-failed"
  | "mark-ready-identity-response-invalid"
  | "mark-ready-identity-mismatch"
  | "mark-ready-checks-not-passed"
  | "mark-ready-command-failed"
  | "in-memory-preflight-not-configured"
  | "in-memory-push-not-configured"
  | "in-memory-draft-pull-request-not-configured"
  | "in-memory-required-checks-not-configured"
  | "in-memory-mark-ready-not-configured";

export class HostingAdapterError extends Error {
  constructor(
    readonly classification: HostingAdapterErrorClassification,
    readonly primaryClassification?: HostingAdapterErrorClassification,
  ) {
    super(classification);
    this.name = "HostingAdapterError";
  }
}

interface HostingCommandRequest {
  executable: "gh" | "git";
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface HostingCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: { stdout: boolean; stderr: boolean };
  spawnError?: unknown;
}

type HostingCommandRunner = (
  request: HostingCommandRequest,
) => Promise<HostingCommandResult>;

export interface InMemoryHostingOperations {
  preflight?: (request: HostingPreflight) => Promise<HostingTarget>;
  pushBranch?: (request: PushRequest) => Promise<{ remoteHead: string }>;
  ensureDraftPullRequest?: (
    request: DraftPullRequestRequest,
  ) => Promise<PullRequestIdentity>;
  requiredChecks?: (request: ChecksRequest) => Promise<RequiredChecksResult>;
  markReady?: (request: MarkReadyRequest) => Promise<PullRequestIdentity>;
}

function fail(classification: HostingAdapterErrorClassification): never {
  throw new HostingAdapterError(classification);
}

function cleanExit(result: HostingCommandResult): boolean {
  return result.exitCode === 0
    && result.timedOut !== true
    && result.cancelled !== true
    && result.spawnError === undefined
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true;
}

function commandEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function githubCredentialEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (process.env.GH_CONFIG_DIR !== undefined) {
    environment.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR;
  } else if (process.platform === "win32" && process.env.APPDATA !== undefined) {
    environment.GH_CONFIG_DIR = path.join(process.env.APPDATA, "GitHub CLI");
  } else if (process.env.XDG_CONFIG_HOME !== undefined) {
    environment.GH_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME, "gh");
  } else if (process.env.HOME !== undefined) {
    environment.GH_CONFIG_DIR = path.join(process.env.HOME, ".config", "gh");
  }
  return environment;
}

function isolatedGitEnvironment(
  repository: string,
  withGithubCredentials = false,
): Record<string, string> {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_TERMINAL_PROMPT: "0",
    HOME: repository,
    XDG_CONFIG_HOME: repository,
    ...(withGithubCredentials ? githubCredentialEnvironment() : {}),
  };
}

function toCommandResult(exit: SupervisedExit): HostingCommandResult {
  return {
    exitCode: exit.exitCode,
    stdout: exit.stdout,
    stderr: exit.stderr,
    timedOut: exit.timedOut,
    cancelled: exit.cancelled,
    truncated: { ...exit.truncated },
    ...(exit.spawnError === undefined ? {} : { spawnError: exit.spawnError }),
  };
}

function createHostingCommandRunner(
  platformServices: PlatformServices = getPlatformServices(),
): HostingCommandRunner {
  return async request => {
    const executable = await platformServices.resolveExecutable({ name: request.executable });
    const exit = await supervise(platformServices, {
      executable,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    }, {});
    return toCommandResult(exit);
  };
}

function parseVersion(output: string): readonly [number, number, number] | null {
  const firstLine = output.split(/\r?\n/u, 1)[0] ?? "";
  const match = /^gh version (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(firstLine);
  if (match === null) return null;
  const parsed = match.slice(1).map(value => Number.parseInt(value, 10));
  if (parsed.some(value => !Number.isSafeInteger(value))) return null;
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function canonicalRepository(value: string): string | null {
  if (/[%\0\r\n]/u.test(value)) return null;
  const components = value.split("/");
  if (components.length !== 2) return null;
  if (components.some(component => !REPOSITORY_COMPONENT.test(component)
    || component === "."
    || component === "..")) return null;
  return `${components[0]!.toLowerCase()}/${components[1]!.toLowerCase()}`;
}

function canonicalGithubUrl(raw: string): { repository: string; url: string } | null {
  if (/[\0\r\n]/u.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.pathname.includes("%")
    || parsed.pathname.includes("//")
    || parsed.pathname.endsWith("/")) return null;
  const pathname = parsed.pathname.slice(1);
  const withoutSuffix = pathname.endsWith(".git") ? pathname.slice(0, -4) : pathname;
  const repository = canonicalRepository(withoutSuffix);
  if (repository === null) return null;
  return { repository, url: `https://github.com/${repository}.git` };
}

function validBranch(branch: string): boolean {
  if (branch.length < 1
    || branch.length > 240
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch === "@"
    || branch.includes("..")
    || branch.includes("@{")
    || branch.includes("//")) return false;
  return !/[\0-\x20\x7f~^:?*[\\]/u.test(branch)
    && branch.split("/").every(component => component !== ""
      && !component.startsWith(".")
      && !component.endsWith(".lock"));
}

function validCheckoutPath(checkoutPath: string): boolean {
  return checkoutPath.length > 0 && !/[\0\r\n]/u.test(checkoutPath);
}

function validTarget(target: HostingTarget): boolean {
  const repository = canonicalRepository(target.repository);
  const url = canonicalGithubUrl(target.canonicalHttpsUrl);
  return target.provider === "github"
    && repository !== null
    && target.repository === repository
    && url !== null
    && url.repository === repository
    && url.url === target.canonicalHttpsUrl;
}

function parseRemoteHead(output: string, branchRef: string): string | null | undefined {
  if (output === "") return null;
  const lines = output.split("\n").filter(line => line !== "");
  if (lines.length !== 1) return undefined;
  const match = /^(\S+)\t(\S+)$/u.exec(lines[0]!);
  if (match === null || !OID.test(match[1]!) || match[2] !== branchRef) return undefined;
  return match[1]!;
}

function parseBundledHead(output: string, branchRef: string): string | undefined {
  const lines = output.split(/\r?\n/u).filter(line => line !== "");
  if (lines.length !== 1) return undefined;
  const match = /^(\S+) (\S+)$/u.exec(lines[0]!);
  if (match === null || !OID.test(match[1]!) || match[2] !== branchRef) return undefined;
  return match[1]!;
}

const PR_JSON_FIELDS = "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft";
const CHECK_JSON_FIELDS = "bucket,name,state,link";
const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 65_536;
const MAX_CHECK_FIELD_BYTES = 4_096;

function boundedOutput(result: HostingCommandResult): boolean {
  return result.timedOut !== true
    && result.cancelled !== true
    && result.spawnError === undefined
    && result.truncated?.stdout !== true
    && result.truncated?.stderr !== true
    && Buffer.byteLength(result.stdout, "utf8") <= MAX_OUTPUT_BYTES
    && Buffer.byteLength(result.stderr, "utf8") <= MAX_OUTPUT_BYTES;
}

function validPullRequestText(title: unknown, body: unknown): boolean {
  if (typeof title !== "string" || typeof body !== "string") return false;
  const titleBytes = Buffer.byteLength(title, "utf8");
  const bodyBytes = Buffer.byteLength(body, "utf8");
  return titleBytes > 0
    && titleBytes <= MAX_TITLE_BYTES
    && bodyBytes <= MAX_BODY_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(title)
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(body);
}

function validPullRequestNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseJson(output: string): unknown | undefined {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) return undefined;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

function canonicalPullRequestUrl(
  raw: string,
  repository: string,
  number: number,
): string | undefined {
  if (/[\0\r\n%]/u.test(raw)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  const components = parsed.pathname.split("/");
  const urlRepository = canonicalRepository(`${components[1] ?? ""}/${components[2] ?? ""}`);
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port !== ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || components.length !== 5
    || components[3] !== "pull"
    || components[4] !== String(number)
    || urlRepository !== repository) return undefined;
  return pullRequestUrl(repository, number);
}

function parsePullRequestIdentity(
  value: unknown,
  target: HostingTarget,
): PullRequestIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.number !== "number"
    || !validPullRequestNumber(record.number)
    || typeof record.url !== "string"
    || typeof record.baseRefName !== "string"
    || typeof record.headRefName !== "string"
    || typeof record.headRefOid !== "string"
    || typeof record.isDraft !== "boolean"
    || typeof record.headRepository !== "object"
    || record.headRepository === null
    || Array.isArray(record.headRepository)) return undefined;
  const headRepository = record.headRepository as Record<string, unknown>;
  if (typeof headRepository.nameWithOwner !== "string") return undefined;
  const repository = canonicalRepository(headRepository.nameWithOwner);
  const url = canonicalPullRequestUrl(record.url, target.repository, record.number);
  if (repository === null
    || repository !== target.repository
    || url === undefined
    || !validBranch(record.baseRefName)
    || !validBranch(record.headRefName)
    || !OID.test(record.headRefOid)) return undefined;
  return {
    number: record.number,
    url,
    repository,
    baseBranch: record.baseRefName,
    headBranch: record.headRefName,
    headCommitOid: record.headRefOid,
    draft: record.isDraft,
  };
}

function samePullRequestIdentity(
  actual: PullRequestIdentity,
  expected: PullRequestIdentity,
): boolean {
  return actual.number === expected.number
    && actual.url === expected.url
    && actual.repository === expected.repository
    && actual.baseBranch === expected.baseBranch
    && actual.headBranch === expected.headBranch
    && actual.headCommitOid === expected.headCommitOid
    && actual.draft === expected.draft;
}

function pullRequestKey(repository: string, number: number): string {
  return `${repository}#${number}`;
}

function parseCreatedPullRequestNumber(output: string, repository: string): number | undefined {
  const trimmed = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n")
      ? output.slice(0, -1)
      : output;
  const prefix = `https://github.com/${repository}/pull/`;
  if (!trimmed.startsWith(prefix) || trimmed.includes("\n") || trimmed.includes("\r")) {
    return undefined;
  }
  const numberText = trimmed.slice(prefix.length);
  if (!/^[1-9]\d*$/u.test(numberText)) return undefined;
  const number = Number(numberText);
  return validPullRequestNumber(number) ? number : undefined;
}

function validCheckField(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_CHECK_FIELD_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function parseRequiredChecks(output: string): RequiredCheck[] | undefined {
  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) return undefined;
  const checks: RequiredCheck[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !["bucket", "name", "state", "link"].includes(key))
      || typeof record.bucket !== "string"
      || !["pass", "pending", "fail", "cancel", "skipping"].includes(record.bucket)
      || typeof record.name !== "string"
      || record.name.length === 0
      || !validCheckField(record.name)
      || typeof record.state !== "string"
      || record.state.length === 0
      || !validCheckField(record.state)
      || !validCheckState(record.bucket, record.state)
      || (record.link !== null && typeof record.link !== "string")
      || (typeof record.link === "string" && !validCheckField(record.link))) return undefined;
    checks.push({
      bucket: record.bucket as RequiredCheck["bucket"],
      name: record.name,
      state: record.state,
      link: record.link as string | null,
    });
  }
  return checks;
}

function validCheckState(bucket: string, state: string): boolean {
  switch (bucket) {
    case "pass":
      return state === "SUCCESS";
    case "pending":
      return ["EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"]
        .includes(state);
    case "fail":
      return [
        "ACTION_REQUIRED",
        "ERROR",
        "FAILURE",
        "STALE",
        "STARTUP_FAILURE",
        "TIMED_OUT",
      ].includes(state);
    case "cancel":
      return state === "CANCELLED";
    case "skipping":
      return ["NEUTRAL", "SKIPPED"].includes(state);
    default:
      return false;
  }
}

export class GitHubCliAdapter implements HostingAdapter {
  private readonly runner: HostingCommandRunner;
  private readonly platformServices: PlatformServices;
  private readonly pullRequests = new Map<string, PullRequestIdentity>();
  private readonly checksPassed = new Set<string>();

  constructor() {
    this.platformServices = getPlatformServices();
    this.runner = createHostingCommandRunner(this.platformServices);
  }

  private run(
    executable: "gh" | "git",
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<HostingCommandResult> {
    return this.runner({
      executable,
      args,
      cwd,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  async preflight(request: HostingPreflight): Promise<HostingTarget> {
    if (!validCheckoutPath(request.checkoutPath)
      || (request.expectedRepository !== undefined
        && canonicalRepository(request.expectedRepository) === null)) {
      fail("preflight-repository-identity-mismatch");
    }

    let version: HostingCommandResult;
    try {
      version = await this.run("gh", ["version"], request.checkoutPath, commandEnvironment());
    } catch {
      fail("preflight-gh-unavailable");
    }
    if (!cleanExit(version)) fail("preflight-gh-unavailable");
    const parsedVersion = parseVersion(version.stdout);
    if (parsedVersion === null) fail("preflight-gh-version-invalid");
    if (!versionAtLeast(parsedVersion, MINIMUM_GH_VERSION)) {
      fail("preflight-gh-version-unsupported");
    }

    let auth: HostingCommandResult;
    try {
      auth = await this.run(
        "gh",
        ["auth", "status", "--hostname", "github.com"],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("preflight-auth-failed");
    }
    if (!cleanExit(auth)) fail("preflight-auth-failed");

    let repositoryView: HostingCommandResult;
    try {
      repositoryView = await this.run(
        "gh",
        ["repo", "view", "--json", "nameWithOwner,url"],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("preflight-repository-query-failed");
    }
    if (!cleanExit(repositoryView)) fail("preflight-repository-query-failed");

    let parsed: unknown;
    try {
      parsed = JSON.parse(repositoryView.stdout);
    } catch {
      fail("preflight-repository-response-invalid");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail("preflight-repository-response-invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== "nameWithOwner" && key !== "url")
      || typeof record.nameWithOwner !== "string"
      || typeof record.url !== "string") {
      fail("preflight-repository-response-invalid");
    }
    const repository = canonicalRepository(record.nameWithOwner);
    if (repository === null) fail("preflight-repository-response-invalid");
    const canonicalUrl = canonicalGithubUrl(record.url);
    if (canonicalUrl === null) fail("preflight-repository-url-invalid");
    if (canonicalUrl.repository !== repository) fail("preflight-repository-identity-mismatch");
    if (request.expectedRepository !== undefined) {
      const expected = canonicalRepository(request.expectedRepository);
      if (expected === null || expected !== repository) {
        fail("preflight-repository-identity-mismatch");
      }
    }
    return {
      provider: "github",
      repository,
      canonicalHttpsUrl: canonicalUrl.url,
    };
  }

  async pushBranch(request: PushRequest): Promise<{ remoteHead: string }> {
    if (!validCheckoutPath(request.checkoutPath)
      || !validTarget(request.target)
      || !validBranch(request.branch)
      || !OID.test(request.headCommitOid)) fail("push-request-invalid");

    let quarantine: string | undefined;
    try {
      quarantine = await this.platformServices.createSecureTempDirectory();
      await chmod(quarantine, 0o700);
    } catch {
      if (quarantine !== undefined) {
        try {
          await rm(quarantine, { recursive: true });
        } catch {
          throw new HostingAdapterError(
            "push-quarantine-cleanup-failed",
            "push-quarantine-create-failed",
          );
        }
      }
      fail("push-quarantine-create-failed");
    }
    const environment = isolatedGitEnvironment(quarantine);
    const remoteEnvironment = isolatedGitEnvironment(quarantine, true);
    const branchRef = `refs/heads/${request.branch}`;
    const bundlePath = path.join(quarantine, "branch.bundle");
    let outcome: { remoteHead: string } | undefined;
    let failure: HostingAdapterError | undefined;

    try {
      let result = await this.run(
        "git",
        [
          "init",
          "--bare",
          "--quiet",
          ...(request.headCommitOid.length === 64 ? ["--object-format=sha256"] : []),
          ".",
        ],
        quarantine,
        environment,
      );
      if (!cleanExit(result)) fail("push-quarantine-init-failed");

      result = await this.run(
        "git",
        ["bundle", "create", bundlePath, branchRef],
        request.checkoutPath,
        environment,
      );
      if (!cleanExit(result)) fail("push-bundle-create-failed");

      result = await this.run(
        "git",
        ["bundle", "unbundle", bundlePath],
        quarantine,
        environment,
      );
      if (!cleanExit(result)) fail("push-bundle-import-failed");
      if (parseBundledHead(result.stdout, branchRef) !== request.headCommitOid) {
        fail("push-imported-oid-mismatch");
      }

      result = await this.run(
        "git",
        ["rev-parse", "--verify", `${request.headCommitOid}^{commit}`],
        quarantine,
        environment,
      );
      if (!cleanExit(result) || result.stdout.trim() !== request.headCommitOid) {
        fail("push-imported-oid-mismatch");
      }

      result = await this.run(
        "git",
        ["update-ref", branchRef, request.headCommitOid, "0".repeat(request.headCommitOid.length)],
        quarantine,
        environment,
      );
      if (!cleanExit(result)) fail("push-imported-oid-mismatch");

      result = await this.run(
        "git",
        [...CREDENTIAL_HELPER_ARGS, "ls-remote", "--heads", request.target.canonicalHttpsUrl, branchRef],
        quarantine,
        remoteEnvironment,
      );
      if (!cleanExit(result)) fail("push-remote-precheck-failed");
      const remoteHead = parseRemoteHead(result.stdout, branchRef);
      if (remoteHead === undefined) fail("push-remote-response-invalid");
      if (remoteHead !== null && remoteHead !== request.headCommitOid) {
        fail("push-remote-head-mismatch");
      }
      if (remoteHead === request.headCommitOid) {
        outcome = { remoteHead };
      } else {
        result = await this.run(
          "git",
          [
            ...CREDENTIAL_HELPER_ARGS,
            "push",
            request.target.canonicalHttpsUrl,
            `${branchRef}:${branchRef}`,
          ],
          quarantine,
          remoteEnvironment,
        );
        if (!cleanExit(result)) fail("push-command-failed");
        outcome = { remoteHead: request.headCommitOid };
      }
    } catch (error) {
      failure = error instanceof HostingAdapterError
        ? error
        : new HostingAdapterError("push-command-failed");
    }

    try {
      await rm(quarantine, { recursive: true });
    } catch {
      throw new HostingAdapterError("push-quarantine-cleanup-failed", failure?.classification);
    }
    if (failure !== undefined) throw failure;
    return outcome!;
  }

  async ensureDraftPullRequest(
    request: DraftPullRequestRequest,
  ): Promise<PullRequestIdentity> {
    if (!validCheckoutPath(request.checkoutPath)
      || !validTarget(request.target)
      || !validBranch(request.baseBranch)
      || !validBranch(request.headBranch)
      || !OID.test(request.headCommitOid)
      || !validPullRequestText(request.title, request.body)) {
      fail("draft-pull-request-request-invalid");
    }

    let listed: HostingCommandResult;
    try {
      listed = await this.run(
        "gh",
        [
          "pr", "list",
          "--repo", request.target.repository,
          "--base", request.baseBranch,
          "--head", request.headBranch,
          "--state", "open",
          "--json", PR_JSON_FIELDS,
        ],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("draft-pull-request-list-failed");
    }
    if (!cleanExit(listed) || !boundedOutput(listed)) {
      fail("draft-pull-request-list-failed");
    }
    const parsedList = parseJson(listed.stdout);
    if (!Array.isArray(parsedList)) fail("draft-pull-request-response-invalid");
    const identities = parsedList.map(value => parsePullRequestIdentity(value, request.target));
    if (identities.some(identity => identity === undefined)) {
      fail("draft-pull-request-identity-mismatch");
    }
    if (identities.length > 1) fail("draft-pull-request-ambiguous");
    if (identities.length === 1) {
      const identity = identities[0]!;
      if (identity.baseBranch !== request.baseBranch
        || identity.headBranch !== request.headBranch
        || !identity.draft) fail("draft-pull-request-identity-mismatch");
      if (identity.headCommitOid !== request.headCommitOid) {
        fail("draft-pull-request-head-mismatch");
      }
      const key = pullRequestKey(identity.repository, identity.number);
      this.pullRequests.set(key, identity);
      this.checksPassed.delete(key);
      return identity;
    }

    let created: HostingCommandResult;
    try {
      created = await this.run(
        "gh",
        [
          "pr", "create",
          "--repo", request.target.repository,
          "--base", request.baseBranch,
          "--head", request.headBranch,
          "--draft",
          "--title", request.title,
          "--body", request.body,
        ],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("draft-pull-request-create-failed");
    }
    if (!cleanExit(created) || !boundedOutput(created)) {
      fail("draft-pull-request-create-failed");
    }
    const createdNumber = parseCreatedPullRequestNumber(
      created.stdout,
      request.target.repository,
    );
    if (createdNumber === undefined) fail("draft-pull-request-response-invalid");

    const identity = await this.viewPullRequest(
      request.checkoutPath,
      request.target,
      createdNumber,
      "draft-pull-request-create-failed",
      "draft-pull-request-response-invalid",
    );
    if (identity.baseBranch !== request.baseBranch
      || identity.headBranch !== request.headBranch
      || identity.headCommitOid !== request.headCommitOid
      || !identity.draft) fail("draft-pull-request-identity-mismatch");
    const key = pullRequestKey(identity.repository, identity.number);
    this.pullRequests.set(key, identity);
    this.checksPassed.delete(key);
    return identity;
  }

  async requiredChecks(request: ChecksRequest): Promise<RequiredChecksResult> {
    if (!validCheckoutPath(request.checkoutPath)
      || !validTarget(request.target)
      || !validPullRequestNumber(request.pullRequestNumber)) {
      fail("required-checks-request-invalid");
    }
    const key = pullRequestKey(request.target.repository, request.pullRequestNumber);
    const expected = this.pullRequests.get(key);
    if (expected === undefined) fail("required-checks-identity-not-established");

    let result: HostingCommandResult;
    try {
      result = await this.run(
        "gh",
        [
          "pr", "checks", String(request.pullRequestNumber),
          "--repo", request.target.repository,
          "--required",
          "--json", CHECK_JSON_FIELDS,
        ],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("required-checks-command-failed");
    }
    if (!boundedOutput(result) || ![0, 1, 8].includes(result.exitCode ?? -1)) {
      fail("required-checks-command-failed");
    }

    const live = await this.viewPullRequest(
      request.checkoutPath,
      request.target,
      request.pullRequestNumber,
      "required-checks-identity-query-failed",
      "required-checks-identity-response-invalid",
    );
    if (!samePullRequestIdentity(live, expected)) {
      this.checksPassed.delete(key);
      fail("required-checks-identity-mismatch");
    }

    const checks = parseRequiredChecks(result.stdout);
    if (checks === undefined) fail("required-checks-response-invalid");
    const aggregate = checks.length === 0
      ? "missing"
      : checks.some(check => ["fail", "cancel", "skipping"].includes(check.bucket))
        ? "failed"
        : checks.some(check => check.bucket === "pending")
          ? "pending"
          : "passed";
    const expectedExitCode = checks.length === 0
      ? 1
      : checks.some(check => check.bucket === "fail" || check.bucket === "cancel")
        ? 1
        : checks.some(check => check.bucket === "pending")
          ? 8
          : 0;
    if (result.exitCode !== expectedExitCode) fail("required-checks-response-invalid");
    if (aggregate === "passed") this.checksPassed.add(key);
    else this.checksPassed.delete(key);
    return { result: aggregate, checks };
  }

  async markReady(request: MarkReadyRequest): Promise<PullRequestIdentity> {
    if (!validCheckoutPath(request.checkoutPath)
      || !validTarget(request.target)
      || !validPullRequestNumber(request.pullRequestNumber)) {
      fail("mark-ready-request-invalid");
    }
    const key = pullRequestKey(request.target.repository, request.pullRequestNumber);
    const expected = this.pullRequests.get(key);
    if (expected === undefined) fail("mark-ready-identity-not-established");
    if (!this.checksPassed.has(key)) fail("mark-ready-checks-not-passed");

    const live = await this.viewPullRequest(
      request.checkoutPath,
      request.target,
      request.pullRequestNumber,
      "mark-ready-identity-query-failed",
      "mark-ready-identity-response-invalid",
    );
    if (!samePullRequestIdentity(live, expected)) {
      this.checksPassed.delete(key);
      fail("mark-ready-identity-mismatch");
    }

    let ready: HostingCommandResult;
    try {
      ready = await this.run(
        "gh",
        [
          "pr", "ready", String(request.pullRequestNumber),
          "--repo", request.target.repository,
        ],
        request.checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail("mark-ready-command-failed");
    }
    if (!cleanExit(ready) || !boundedOutput(ready)) fail("mark-ready-command-failed");

    const updated = await this.viewPullRequest(
      request.checkoutPath,
      request.target,
      request.pullRequestNumber,
      "mark-ready-identity-query-failed",
      "mark-ready-identity-response-invalid",
    );
    const readyExpected = { ...expected, draft: false };
    if (!samePullRequestIdentity(updated, readyExpected)) {
      this.checksPassed.delete(key);
      fail("mark-ready-identity-mismatch");
    }
    this.pullRequests.delete(key);
    this.checksPassed.delete(key);
    return updated;
  }

  private async viewPullRequest(
    checkoutPath: string,
    target: HostingTarget,
    number: number,
    queryFailure: HostingAdapterErrorClassification,
    responseFailure: HostingAdapterErrorClassification,
  ): Promise<PullRequestIdentity> {
    let viewed: HostingCommandResult;
    try {
      viewed = await this.run(
        "gh",
        [
          "pr", "view", String(number),
          "--repo", target.repository,
          "--json", PR_JSON_FIELDS,
        ],
        checkoutPath,
        commandEnvironment(),
      );
    } catch {
      fail(queryFailure);
    }
    if (!cleanExit(viewed) || !boundedOutput(viewed)) fail(queryFailure);
    const identity = parsePullRequestIdentity(parseJson(viewed.stdout), target);
    if (identity === undefined || identity.number !== number) fail(responseFailure);
    return identity;
  }
}

export class InMemoryHostingAdapter implements HostingAdapter {
  constructor(private readonly operations: InMemoryHostingOperations = {}) {}

  preflight(request: HostingPreflight): Promise<HostingTarget> {
    return this.operations.preflight?.(request)
      ?? Promise.reject(new HostingAdapterError("in-memory-preflight-not-configured"));
  }

  pushBranch(request: PushRequest): Promise<{ remoteHead: string }> {
    return this.operations.pushBranch?.(request)
      ?? Promise.reject(new HostingAdapterError("in-memory-push-not-configured"));
  }

  ensureDraftPullRequest(request: DraftPullRequestRequest): Promise<PullRequestIdentity> {
    return this.operations.ensureDraftPullRequest?.(request)
      ?? Promise.reject(new HostingAdapterError("in-memory-draft-pull-request-not-configured"));
  }

  requiredChecks(request: ChecksRequest): Promise<RequiredChecksResult> {
    return this.operations.requiredChecks?.(request)
      ?? Promise.reject(new HostingAdapterError("in-memory-required-checks-not-configured"));
  }

  markReady(request: MarkReadyRequest): Promise<PullRequestIdentity> {
    return this.operations.markReady?.(request)
      ?? Promise.reject(new HostingAdapterError("in-memory-mark-ready-not-configured"));
  }
}
