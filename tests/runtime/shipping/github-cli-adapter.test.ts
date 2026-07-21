import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  DraftPullRequestRequest,
  HostingTarget,
  PullRequestIdentity,
  PushRequest,
  RequiredCheck,
} from "../../../src/ship/hosting-adapter.js";
import {
  GitHubCliAdapter,
  HostingAdapterError,
  InMemoryHostingAdapter,
} from "../../../src/ship/github-cli-adapter.js";
import * as githubAdapterModule from "../../../src/ship/github-cli-adapter.js";

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

interface TestAdapterDependencies {
  createTemporaryDirectory?: () => Promise<string>;
  chmod?: (directory: string, mode: number) => Promise<void>;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
}

type CommandHandler = (
  request: HostingCommandRequest,
) => HostingCommandResult | Promise<HostingCommandResult>;

const commandHarness = vi.hoisted(() => ({
  calls: [] as HostingCommandRequest[],
  handler: undefined as CommandHandler | undefined,
  createTemporaryDirectory: async () => "/runtime-owned/quarantine",
  chmod: async (_directory: string, _mode: number) => {},
  removeTemporaryDirectory: async (_directory: string) => {},
}));

vi.mock("../../../src/platform/select-platform.js", () => ({
  getPlatformServices: () => ({
    resolveExecutable: async ({ name }: { name: string }) => name,
    createSecureTempDirectory: () => commandHarness.createTemporaryDirectory(),
  }),
}));

vi.mock("../../../src/platform/process-supervisor.js", () => ({
  supervise: async (
    _platformServices: unknown,
    request: HostingCommandRequest,
  ) => {
    const captured = { ...request, args: [...request.args], env: { ...request.env } };
    commandHarness.calls.push(captured);
    return commandHarness.handler?.(captured);
  },
}));

vi.mock("node:fs/promises", async importOriginal => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  chmod: (directory: string, mode: number) => commandHarness.chmod(directory, mode),
  rm: (directory: string) => commandHarness.removeTemporaryDirectory(directory),
}));

const HEAD = "1".repeat(40);
const OTHER_HEAD = "2".repeat(40);
const TARGET: HostingTarget = {
  provider: "github",
  repository: "example/project",
  canonicalHttpsUrl: "https://github.com/example/project.git",
};

function ok(stdout = ""): HostingCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    truncated: { stdout: false, stderr: false },
  };
}

function commandKey(request: HostingCommandRequest): string {
  return `${request.executable} ${JSON.stringify(request.args)}`;
}

function fakeAdapter(
  handler: (request: HostingCommandRequest) => HostingCommandResult | Promise<HostingCommandResult>,
  calls: HostingCommandRequest[] = [],
  dependencies: TestAdapterDependencies = {},
): GitHubCliAdapter {
  commandHarness.calls = calls;
  commandHarness.handler = handler;
  commandHarness.createTemporaryDirectory = dependencies.createTemporaryDirectory
    ?? (async () => "/runtime-owned/quarantine");
  commandHarness.chmod = dependencies.chmod ?? (async () => {});
  commandHarness.removeTemporaryDirectory = dependencies.removeTemporaryDirectory
    ?? (async () => {});
  return new GitHubCliAdapter();
}

function successfulPreflight(request: HostingCommandRequest): HostingCommandResult {
  if (request.args[0] === "version") return ok("gh version 2.96.0 (2026-07-16)\n");
  if (request.args[0] === "auth") return ok();
  if (request.args[0] === "repo") {
    return ok(JSON.stringify({
      nameWithOwner: "Example/Project",
      url: "https://github.com/Example/Project",
    }));
  }
  throw new Error(`unexpected command: ${commandKey(request)}`);
}

function pushRequest(overrides: Partial<PushRequest> = {}): PushRequest {
  return {
    checkoutPath: "/source/checkout",
    target: TARGET,
    branch: "feat/autopilot-01234567",
    headCommitOid: HEAD,
    ...overrides,
  };
}

function draftRequest(
  overrides: Partial<DraftPullRequestRequest> = {},
): DraftPullRequestRequest {
  return {
    checkoutPath: "/source/checkout",
    target: TARGET,
    baseBranch: "main",
    headBranch: "feat/autopilot-01234567",
    headCommitOid: HEAD,
    title: "Ship the candidate",
    body: "## Summary\n\nReady for review.",
    ...overrides,
  };
}

function pullRequestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 17,
    url: "https://github.com/example/project/pull/17",
    baseRefName: "main",
    headRefName: "feat/autopilot-01234567",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: "example/project" },
    isDraft: true,
    ...overrides,
  };
}

function pullRequestIdentity(overrides: Partial<PullRequestIdentity> = {}): PullRequestIdentity {
  return {
    number: 17,
    url: "https://github.com/example/project/pull/17",
    repository: "example/project",
    baseBranch: "main",
    headBranch: "feat/autopilot-01234567",
    headCommitOid: HEAD,
    draft: true,
    ...overrides,
  };
}

function checksJson(checks: RequiredCheck[]): string {
  return JSON.stringify(checks);
}

function successfulPush(
  request: HostingCommandRequest,
  remoteHead: string | null = null,
): HostingCommandResult {
  if (request.args[0] === "bundle" && request.args[1] === "unbundle") {
    return ok(`${HEAD} refs/heads/feat/autopilot-01234567\n`);
  }
  if (request.args[0] === "rev-parse") return ok(`${HEAD}\n`);
  if (request.args.includes("ls-remote")) {
    return ok(remoteHead === null
      ? ""
      : `${remoteHead}\trefs/heads/feat/autopilot-01234567\n`);
  }
  return ok();
}

async function expectClassification(
  operation: Promise<unknown>,
  classification: string,
): Promise<void> {
  const error = await operation.catch(cause => cause);
  expect(error).toBeInstanceOf(HostingAdapterError);
  expect(error).toMatchObject({ classification, message: classification });
}

it("exports only structured adapter operations and sanitized errors", () => {
  expect(Object.keys(githubAdapterModule).sort()).toEqual([
    "GitHubCliAdapter",
    "HostingAdapterError",
    "InMemoryHostingAdapter",
  ]);
  expect(GitHubCliAdapter.length).toBe(0);
});

describe("GitHubCliAdapter preflight", () => {
  it("uses fixed gh argv and returns a canonical credential-free target", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(successfulPreflight, calls);

    await expect(adapter.preflight({
      checkoutPath: "/repository",
      expectedRepository: "example/project",
    })).resolves.toEqual(TARGET);

    expect(calls.map(call => call.args)).toEqual([
      ["version"],
      ["auth", "status", "--hostname", "github.com"],
      ["repo", "view", "--json", "nameWithOwner,url"],
    ]);
    expect(calls.every(call => call.executable === "gh" && call.cwd === "/repository")).toBe(true);
    expect(calls.every(call => call.env.GH_PROMPT_DISABLED === "1")).toBe(true);
  });

  it.each([
    ["2.95.9", "preflight-gh-version-unsupported"],
    ["not-a-version", "preflight-gh-version-invalid"],
  ])("rejects gh %s with %s", async (version, classification) => {
    const adapter = fakeAdapter(request => request.args[0] === "version"
      ? ok(version === "not-a-version" ? version : `gh version ${version}\n`)
      : successfulPreflight(request));
    await expectClassification(
      adapter.preflight({ checkoutPath: "/repository" }),
      classification,
    );
  });

  it("accepts versions above the floor", async () => {
    const adapter = fakeAdapter(request => request.args[0] === "version"
      ? ok("gh version 3.0.0\n")
      : successfulPreflight(request));
    await expect(adapter.preflight({ checkoutPath: "/repository" })).resolves.toEqual(TARGET);
  });

  it("classifies authentication loss without exposing gh output", async () => {
    const secret = "ghp_do-not-leak";
    const adapter = fakeAdapter(request => request.args[0] === "auth"
      ? { ...ok(), exitCode: 4, stderr: `token ${secret} at /private/auth.yml` }
      : successfulPreflight(request));
    const error = await adapter.preflight({ checkoutPath: "/private/repository" }).catch(cause => cause);
    expect(error).toMatchObject({ classification: "preflight-auth-failed" });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("/private");
  });

  it.each([
    "http://github.com/example/project",
    "https://gitlab.com/example/project",
    "https://user:token@github.com/example/project",
    "https://github.com/example/project?token=secret",
    "https://github.com/example/project#secret",
    "https://github.com/example/%70roject",
  ])("rejects non-canonical repository URL %s", async url => {
    const adapter = fakeAdapter(request => request.args[0] === "repo"
      ? ok(JSON.stringify({ nameWithOwner: "example/project", url }))
      : successfulPreflight(request));
    const error = await adapter.preflight({ checkoutPath: "/repository" }).catch(cause => cause);
    expect(error).toMatchObject({ classification: "preflight-repository-url-invalid" });
    expect(String(error)).not.toContain(url);
  });

  it("rejects disagreement between repo identity and URL", async () => {
    const adapter = fakeAdapter(request => request.args[0] === "repo"
      ? ok(JSON.stringify({
        nameWithOwner: "example/project",
        url: "https://github.com/example/other",
      }))
      : successfulPreflight(request));
    await expectClassification(
      adapter.preflight({ checkoutPath: "/repository" }),
      "preflight-repository-identity-mismatch",
    );
  });
});

describe("GitHubCliAdapter quarantined push", () => {
  it("imports the bundle, isolates config, and pushes one exact full refspec", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => successfulPush(request), calls);

    await expect(adapter.pushBranch(pushRequest())).resolves.toEqual({ remoteHead: HEAD });

    const quarantine = calls[0]!.cwd;
    const bundlePath = path.join(quarantine, "branch.bundle");
    expect(calls.map(call => call.args)).toEqual([
      ["init", "--bare", "--quiet", "."],
      ["bundle", "create", bundlePath, "refs/heads/feat/autopilot-01234567"],
      ["bundle", "unbundle", bundlePath],
      ["rev-parse", "--verify", `${HEAD}^{commit}`],
      ["update-ref", "refs/heads/feat/autopilot-01234567", HEAD, "0".repeat(40)],
      [
        "-c", "credential.helper=",
        "-c", "credential.helper=!gh auth git-credential",
        "ls-remote", "--heads", TARGET.canonicalHttpsUrl,
        "refs/heads/feat/autopilot-01234567",
      ],
      [
        "-c", "credential.helper=",
        "-c", "credential.helper=!gh auth git-credential",
        "push", TARGET.canonicalHttpsUrl,
        "refs/heads/feat/autopilot-01234567:refs/heads/feat/autopilot-01234567",
      ],
    ]);
    expect(calls[1]!.cwd).toBe("/source/checkout");
    for (const [index, call] of calls.entries()) {
      if (index !== 1) expect(call.cwd).toBe(quarantine);
      expect(call.env).toMatchObject({
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
        HOME: quarantine,
        XDG_CONFIG_HOME: quarantine,
      });
      const isolatedKeys = [
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "PATH",
        "XDG_CONFIG_HOME",
      ];
      if (!call.args.includes("ls-remote") && !call.args.includes("push")) {
        expect(Object.keys(call.env).sort()).toEqual(isolatedKeys);
      } else {
        expect(Object.keys(call.env).every(key => isolatedKeys.includes(key)
          || ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"].includes(key))).toBe(true);
      }
    }
  });

  it("initializes a SHA-256 quarantine for a 64-character object ID", async () => {
    const sha256Head = "a".repeat(64);
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => {
      if (request.args[0] === "bundle" && request.args[1] === "unbundle") {
        return ok(`${sha256Head} refs/heads/feat/autopilot-01234567\n`);
      }
      if (request.args[0] === "rev-parse") return ok(`${sha256Head}\n`);
      return ok();
    }, calls);

    await expect(adapter.pushBranch(pushRequest({ headCommitOid: sha256Head }))).resolves
      .toEqual({ remoteHead: sha256Head });
    expect(calls[0]!.args).toEqual([
      "init", "--bare", "--quiet", "--object-format=sha256", ".",
    ]);
    expect(calls.find(call => call.args[0] === "update-ref")!.args.at(-1)).toBe("0".repeat(64));
  });

  it("preserves quarantine creation as primary when creation cleanup also fails", async () => {
    const adapter = fakeAdapter(request => successfulPush(request), [], {
      createTemporaryDirectory: async () => "/runtime-owned/partial-quarantine",
      chmod: async () => { throw new Error("chmod failed with github_pat_secret"); },
      removeTemporaryDirectory: async () => { throw new Error("cleanup failed /private/path"); },
    });

    const error = await adapter.pushBranch(pushRequest()).catch(cause => cause);
    expect(error).toMatchObject({
      classification: "push-quarantine-cleanup-failed",
      primaryClassification: "push-quarantine-create-failed",
    });
    expect(String(error)).not.toContain("github_pat_secret");
    expect(String(error)).not.toContain("/private/path");
  });

  it("is idempotent when the exact remote head already exists", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => successfulPush(request, HEAD), calls);
    await expect(adapter.pushBranch(pushRequest())).resolves.toEqual({ remoteHead: HEAD });
    expect(calls.some(call => call.args.includes("push"))).toBe(false);
  });

  it("halts before push when the remote head differs", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => successfulPush(request, OTHER_HEAD), calls);
    await expectClassification(
      adapter.pushBranch(pushRequest()),
      "push-remote-head-mismatch",
    );
    expect(calls.some(call => call.args.includes("push"))).toBe(false);
  });

  it("halts before any remote operation when the imported object differs", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => request.args[0] === "rev-parse"
      ? ok(`${OTHER_HEAD}\n`)
      : successfulPush(request), calls);
    await expectClassification(
      adapter.pushBranch(pushRequest()),
      "push-imported-oid-mismatch",
    );
    expect(calls.some(call => call.args.includes("ls-remote"))).toBe(false);
    expect(calls.some(call => call.args.includes("push"))).toBe(false);
  });

  it("rejects a bundle that advertises a different branch OID", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => request.args[0] === "bundle"
      && request.args[1] === "unbundle"
      ? ok(`${OTHER_HEAD} refs/heads/feat/autopilot-01234567\n`)
      : successfulPush(request), calls);
    await expectClassification(
      adapter.pushBranch(pushRequest()),
      "push-imported-oid-mismatch",
    );
    expect(calls.some(call => call.args.includes("rev-parse"))).toBe(false);
    expect(calls.some(call => call.args.includes("ls-remote"))).toBe(false);
  });

  it("redacts command failures and local paths", async () => {
    const secret = "github_pat_do-not-leak";
    const adapter = fakeAdapter(request => request.args.includes("push")
      ? {
        ...ok(),
        exitCode: 128,
        stderr: `credential ${secret} rejected for /source/checkout`,
      }
      : successfulPush(request));
    const error = await adapter.pushBranch(pushRequest()).catch(cause => cause);
    expect(error).toMatchObject({ classification: "push-command-failed" });
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("/source/checkout");
  });
});

describe("GitHubCliAdapter pull request lifecycle", () => {
  it("reuses the one exact draft pull request and verifies its head repository", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => request.args[1] === "list"
      ? ok(JSON.stringify([pullRequestJson()]))
      : (() => { throw new Error(`unexpected command: ${commandKey(request)}`); })(), calls);

    await expect(adapter.ensureDraftPullRequest(draftRequest())).resolves.toEqual(
      pullRequestIdentity(),
    );
    expect(calls.map(call => call.args)).toEqual([[
      "pr", "list",
      "--repo", "example/project",
      "--base", "main",
      "--head", "feat/autopilot-01234567",
      "--state", "open",
      "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
    ]]);
  });

  it.each([
    ["a fork", pullRequestJson({ headRepository: { nameWithOwner: "attacker/project" } }),
      "draft-pull-request-identity-mismatch"],
    ["a stale head", pullRequestJson({ headRefOid: OTHER_HEAD }),
      "draft-pull-request-head-mismatch"],
    ["a wrong base", pullRequestJson({ baseRefName: "release" }),
      "draft-pull-request-identity-mismatch"],
    ["a wrong head", pullRequestJson({ headRefName: "feat/other" }),
      "draft-pull-request-identity-mismatch"],
    ["a wrong repository URL", pullRequestJson({
      url: "https://github.com/example/other/pull/17",
    }), "draft-pull-request-identity-mismatch"],
  ])("rejects %s returned by the exact list", async (_label, listed, classification) => {
    const adapter = fakeAdapter(request => request.args[1] === "list"
      ? ok(JSON.stringify([listed]))
      : ok());
    await expectClassification(adapter.ensureDraftPullRequest(draftRequest()), classification);
  });

  it("halts on duplicate matching pull requests", async () => {
    const adapter = fakeAdapter(request => request.args[1] === "list"
      ? ok(JSON.stringify([
        pullRequestJson(),
        pullRequestJson({ number: 18, url: "https://github.com/example/project/pull/18" }),
      ]))
      : ok());
    await expectClassification(
      adapter.ensureDraftPullRequest(draftRequest()),
      "draft-pull-request-ambiguous",
    );
  });

  it("creates from an empty list with Markdown and shell-looking content kept in one argv", async () => {
    const calls: HostingCommandRequest[] = [];
    const body = "## Details\n\nRun `merge --admin` only as quoted documentation.";
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok("[]");
      if (request.args[1] === "create") {
        return ok("https://github.com/example/project/pull/17\n");
      }
      if (request.args[1] === "view") return ok(JSON.stringify(pullRequestJson()));
      throw new Error(`unexpected command: ${commandKey(request)}`);
    }, calls);

    await expect(adapter.ensureDraftPullRequest(draftRequest({ body }))).resolves.toEqual(
      pullRequestIdentity(),
    );
    const create = calls.find(call => call.args[1] === "create")!;
    expect(create.args).toEqual([
      "pr", "create",
      "--repo", "example/project",
      "--base", "main",
      "--head", "feat/autopilot-01234567",
      "--draft",
      "--title", "Ship the candidate",
      "--body", body,
    ]);
    expect(create.args.filter(argument => argument.includes("merge --admin"))).toEqual([body]);
  });

  it.each([
    ["malformed", "{"],
    ["truncated", "[{\"number\":17"],
    ["oversize", `"${"x".repeat(1_000_001)}"`],
  ])("fails closed on %s list JSON", async (_label, stdout) => {
    const adapter = fakeAdapter(() => ok(stdout));
    await expectClassification(
      adapter.ensureDraftPullRequest(draftRequest()),
      _label === "oversize"
        ? "draft-pull-request-list-failed"
        : "draft-pull-request-response-invalid",
    );
  });

  it.each([
    ["title control characters", { title: "bad\ntitle" }],
    ["body control characters", { body: "bad\u0000body" }],
    ["oversize title", { title: "x".repeat(257) }],
    ["oversize body", { body: "x".repeat(65_537) }],
  ])("rejects %s without running gh", async (_label, overrides) => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(() => ok(), calls);
    await expectClassification(
      adapter.ensureDraftPullRequest(draftRequest(overrides)),
      "draft-pull-request-request-invalid",
    );
    expect(calls).toEqual([]);
  });

  it("rejects a non-string title without running gh", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(() => ok(), calls);
    const request = draftRequest() as unknown as Record<string, unknown>;
    request.title = Buffer.from("not a string");

    await expectClassification(
      adapter.ensureDraftPullRequest(request as unknown as DraftPullRequestRequest),
      "draft-pull-request-request-invalid",
    );
    expect(calls).toEqual([]);
  });

  it("rejects a non-string body without running gh", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(() => ok(), calls);
    const request = draftRequest() as unknown as Record<string, unknown>;
    request.body = null;

    await expectClassification(
      adapter.ensureDraftPullRequest(request as unknown as DraftPullRequestRequest),
      "draft-pull-request-request-invalid",
    );
    expect(calls).toEqual([]);
  });
});

describe("GitHubCliAdapter required checks", () => {
  async function runChecks(
    checkResult: HostingCommandResult,
    view: Record<string, unknown> | Record<string, unknown>[] = pullRequestJson(),
    calls: HostingCommandRequest[] = [],
  ): ReturnType<GitHubCliAdapter["requiredChecks"]> {
    let viewIndex = 0;
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "checks") return checkResult;
      if (request.args[1] === "view") {
        const current = Array.isArray(view)
          ? view[Math.min(viewIndex++, view.length - 1)]!
          : view;
        return ok(JSON.stringify(current));
      }
      throw new Error(`unexpected command: ${commandKey(request)}`);
    }, calls);
    await adapter.ensureDraftPullRequest(draftRequest());
    return adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: HEAD,
    });
  }

  it.each([
    ["missing", 1, [], "missing"],
    ["red failure", 1, [{ bucket: "fail", name: "unit", state: "FAILURE", link: null }],
      "failed"],
    ["red cancellation", 1,
      [{ bucket: "cancel", name: "unit", state: "CANCELLED", link: null }], "failed"],
    ["pending", 8, [{ bucket: "pending", name: "unit", state: "QUEUED", link: null }],
      "pending"],
    ["pass", 0, [{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }],
      "passed"],
    ["skipping", 0,
      [{ bucket: "skipping", name: "optional", state: "SKIPPED", link: null }], "failed"],
  ])("maps the %s bucket path deterministically", async (_label, exitCode, checks, result) => {
    await expect(runChecks({ ...ok(checksJson(checks as RequiredCheck[])), exitCode })).resolves
      .toMatchObject({ result, checks });
  });

  it("uses exact fixed argv for checks and live identity revalidation", async () => {
    const calls: HostingCommandRequest[] = [];
    await runChecks({
      ...ok(checksJson([{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }])),
      exitCode: 0,
    }, pullRequestJson(), calls);

    expect(calls.slice(1).map(call => call.args)).toEqual([
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
      [
        "pr", "checks", "17",
        "--repo", "example/project",
        "--required",
        "--json", "bucket,name,state,link",
      ],
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
    ]);
  });

  it("rejects stale passing checks when the expected head differs before observation", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "view") return ok(JSON.stringify(pullRequestJson()));
      if (request.args[1] === "checks") {
        return ok(checksJson([{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }]));
      }
      throw new Error(`unexpected command: ${commandKey(request)}`);
    }, calls);
    await adapter.ensureDraftPullRequest(draftRequest());

    await expectClassification(adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: OTHER_HEAD,
    }), "required-checks-head-mismatch");
    expect(calls.map(call => call.args[1])).toEqual(["list", "view"]);
  });

  it("revalidates the live head after fetching checks and before parsing evidence", async () => {
    const calls: HostingCommandRequest[] = [];
    await expectClassification(
      runChecks({ ...ok("not-json"), exitCode: 0 }, [
        pullRequestJson(),
        pullRequestJson({ headRefOid: OTHER_HEAD }),
      ], calls),
      "required-checks-identity-mismatch",
    );
    expect(calls.map(call => call.args[1])).toEqual(["list", "view", "checks", "view"]);
  });

  it.each([
    ["unknown bucket", 1, JSON.stringify([
      { bucket: "neutral", name: "unit", state: "NEUTRAL", link: null },
    ])],
    ["unknown pass state", 0, JSON.stringify([
      { bucket: "pass", name: "unit", state: "NOT_A_GITHUB_STATE", link: null },
    ])],
    ["malformed JSON", 1, "["],
    ["truncated output", 1, JSON.stringify([])],
    ["oversize output", 1, `"${"x".repeat(1_000_001)}"`],
    ["inconsistent exit", 0, JSON.stringify([
      { bucket: "fail", name: "unit", state: "FAILURE", link: null },
    ])],
  ])("fails closed for %s", async (label, exitCode, stdout) => {
    const result = {
      ...ok(stdout),
      exitCode,
      ...(label === "truncated output"
        ? { truncated: { stdout: true, stderr: false } }
        : {}),
    };
    await expectClassification(
      runChecks(result),
      label === "truncated output" ? "required-checks-command-failed" :
        label === "oversize output" ? "required-checks-command-failed" :
          "required-checks-response-invalid",
    );
  });

  it.each([2, 4, null])("rejects gh checks exit code %s", async exitCode => {
    await expectClassification(
      runChecks({ ...ok("[]"), exitCode }),
      "required-checks-command-failed",
    );
  });
});

describe("GitHubCliAdapter mark ready", () => {
  it("refuses mutation until required checks have passed", async () => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => request.args[1] === "list"
      ? ok(JSON.stringify([pullRequestJson()]))
      : ok(), calls);
    await adapter.ensureDraftPullRequest(draftRequest());
    await expectClassification(adapter.markReady({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
    }), "mark-ready-checks-not-passed");
    expect(calls.some(call => call.args[1] === "ready")).toBe(false);
  });

  it("halts when the PR head changes inside the required-checks bracket", async () => {
    const calls: HostingCommandRequest[] = [];
    let views = 0;
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "checks") {
        return ok(checksJson([{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }]));
      }
      if (request.args[1] === "view") {
        views += 1;
        return ok(JSON.stringify(views === 1
          ? pullRequestJson()
          : pullRequestJson({ headRefOid: OTHER_HEAD })));
      }
      return ok();
    }, calls);
    await adapter.ensureDraftPullRequest(draftRequest());
    await expectClassification(adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: HEAD,
    }), "required-checks-identity-mismatch");
    expect(calls.some(call => call.args[1] === "ready")).toBe(false);
  });

  it.each([
    ["skipped", { bucket: "skipping", name: "required", state: "SKIPPED", link: null }],
    ["malformed pass", {
      bucket: "pass", name: "required", state: "NOT_A_GITHUB_STATE", link: null,
    }],
  ])("never marks ready from %s evidence", async (_label, check) => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "checks") {
        return { ...ok(JSON.stringify([check])), exitCode: 0 };
      }
      if (request.args[1] === "view") return ok(JSON.stringify(pullRequestJson()));
      return ok();
    }, calls);
    await adapter.ensureDraftPullRequest(draftRequest());
    const checksError = await adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: HEAD,
    }).catch(cause => cause);
    if (check.bucket === "pass") {
      expect(checksError).toMatchObject({ classification: "required-checks-response-invalid" });
    } else {
      expect(checksError).toMatchObject({ result: "failed" });
    }
    await expectClassification(adapter.markReady({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
    }), "mark-ready-checks-not-passed");
    expect(calls.some(call => call.args[1] === "ready")).toBe(false);
  });

  it("marks ready only after passing checks and confirms the resulting identity", async () => {
    const calls: HostingCommandRequest[] = [];
    let ready = false;
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "checks") {
        return ok(checksJson([{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }]));
      }
      if (request.args[1] === "ready") {
        ready = true;
        return ok();
      }
      if (request.args[1] === "view") {
        return ok(JSON.stringify(pullRequestJson({ isDraft: !ready })));
      }
      throw new Error(`unexpected command: ${commandKey(request)}`);
    }, calls);
    await adapter.ensureDraftPullRequest(draftRequest());
    await adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: HEAD,
    });
    await expect(adapter.markReady({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
    })).resolves.toEqual(pullRequestIdentity({ draft: false }));
    expect(calls.slice(1).map(call => call.args)).toEqual([
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
      [
        "pr", "checks", "17",
        "--repo", "example/project",
        "--required",
        "--json", "bucket,name,state,link",
      ],
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
      ["pr", "ready", "17", "--repo", "example/project"],
      [
        "pr", "view", "17",
        "--repo", "example/project",
        "--json", "number,url,baseRefName,headRefName,headRefOid,headRepository,isDraft",
      ],
    ]);
  });

  it("releases completed pull request lifecycle state", async () => {
    let ready = false;
    const adapter = fakeAdapter(request => {
      if (request.args[1] === "list") return ok(JSON.stringify([pullRequestJson()]));
      if (request.args[1] === "checks") {
        return ok(checksJson([{ bucket: "pass", name: "unit", state: "SUCCESS", link: null }]));
      }
      if (request.args[1] === "ready") {
        ready = true;
        return ok();
      }
      if (request.args[1] === "view") {
        return ok(JSON.stringify(pullRequestJson({ isDraft: !ready })));
      }
      throw new Error(`unexpected command: ${commandKey(request)}`);
    });
    await adapter.ensureDraftPullRequest(draftRequest());
    await adapter.requiredChecks({
      checkoutPath: "/source/checkout", target: TARGET, pullRequestNumber: 17,
      headCommitOid: HEAD,
    });
    await adapter.markReady({
      checkoutPath: "/source/checkout", target: TARGET, pullRequestNumber: 17,
    });

    await expectClassification(adapter.requiredChecks({
      checkoutPath: "/source/checkout", target: TARGET, pullRequestNumber: 17,
      headCommitOid: HEAD,
    }), "required-checks-identity-not-established");
  });
});

describe("InMemoryHostingAdapter", () => {
  it("provides an injectable skeleton and fails closed for absent operations", async () => {
    const adapter = new InMemoryHostingAdapter({
      preflight: async () => TARGET,
      pushBranch: async request => ({ remoteHead: request.headCommitOid }),
    });
    await expect(adapter.preflight({ checkoutPath: "/repository" })).resolves.toEqual(TARGET);
    await expect(adapter.pushBranch(pushRequest())).resolves.toEqual({ remoteHead: HEAD });
    await expectClassification(
      adapter.requiredChecks({
        checkoutPath: "/repository",
        target: TARGET,
        pullRequestNumber: 1,
        headCommitOid: HEAD,
      }),
      "in-memory-required-checks-not-configured",
    );
  });

  it("forwards all pull request lifecycle operations to injected implementations", async () => {
    const identity = pullRequestIdentity();
    const checks = {
      result: "passed" as const,
      headCommitOid: HEAD,
      checks: [{ bucket: "pass" as const, name: "unit", state: "SUCCESS", link: null }],
    };
    const adapter = new InMemoryHostingAdapter({
      ensureDraftPullRequest: async request => ({
        ...identity,
        headCommitOid: request.headCommitOid,
      }),
      requiredChecks: async () => checks,
      markReady: async () => ({ ...identity, draft: false }),
    });
    await expect(adapter.ensureDraftPullRequest(draftRequest())).resolves.toEqual(identity);
    await expect(adapter.requiredChecks({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
      headCommitOid: HEAD,
    })).resolves.toEqual(checks);
    await expect(adapter.markReady({
      checkoutPath: "/source/checkout",
      target: TARGET,
      pullRequestNumber: 17,
    })).resolves.toEqual({ ...identity, draft: false });
  });
});
