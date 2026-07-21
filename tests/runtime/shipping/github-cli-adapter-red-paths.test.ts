import { describe, expect, it, vi } from "vitest";
import type {
  ChecksRequest,
  DraftPullRequestRequest,
  HostingTarget,
  MarkReadyRequest,
  PushRequest,
} from "../../../src/ship/hosting-adapter.js";
import {
  GitHubCliAdapter,
  HostingAdapterError,
  InMemoryHostingAdapter,
  type HostingAdapterErrorClassification,
} from "../../../src/ship/github-cli-adapter.js";

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
const SECRET = "github_pat_red_path_secret";
const LEAK_PATH = "/private/red-path-leak";
const TARGET: HostingTarget = {
  provider: "github",
  repository: "example/project",
  canonicalHttpsUrl: "https://github.com/example/project.git",
};

function result(
  stdout = "",
  overrides: Partial<HostingCommandResult> = {},
): HostingCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: `credential ${SECRET} at ${LEAK_PATH}`,
    truncated: { stdout: false, stderr: false },
    ...overrides,
  };
}

function stage(request: HostingCommandRequest): string {
  if (request.executable === "gh") {
    if (request.args[0] === "version") return "version";
    if (request.args[0] === "auth") return "auth";
    if (request.args[0] === "repo") return "repo";
    return `pr-${request.args[1]}`;
  }
  if (request.args[0] === "init") return "init";
  if (request.args[0] === "bundle") return `bundle-${request.args[1]}`;
  if (request.args[0] === "rev-parse") return "rev-parse";
  if (request.args[0] === "update-ref") return "update-ref";
  if (request.args.includes("ls-remote")) return "ls-remote";
  if (request.args.includes("push")) return "push";
  return "unexpected";
}

function preflightSuccess(request: HostingCommandRequest): HostingCommandResult {
  switch (stage(request)) {
    case "version": return result("gh version 2.96.0\n");
    case "auth": return result();
    case "repo": return result(JSON.stringify({
      nameWithOwner: "example/project",
      url: "https://github.com/example/project",
    }));
    default: throw new Error(`unexpected ${stage(request)} ${SECRET} ${LEAK_PATH}`);
  }
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

function pushSuccess(request: HostingCommandRequest): HostingCommandResult {
  switch (stage(request)) {
    case "bundle-unbundle":
      return result(`${HEAD} refs/heads/feat/autopilot-01234567\n`);
    case "rev-parse": return result(`${HEAD}\n`);
    default: return result();
  }
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
    body: "Ready for review.",
    ...overrides,
  };
}

function checksRequest(overrides: Partial<ChecksRequest> = {}): ChecksRequest {
  return {
    checkoutPath: "/source/checkout",
    target: TARGET,
    pullRequestNumber: 17,
    ...overrides,
  };
}

function markReadyRequest(overrides: Partial<MarkReadyRequest> = {}): MarkReadyRequest {
  return {
    checkoutPath: "/source/checkout",
    target: TARGET,
    pullRequestNumber: 17,
    ...overrides,
  };
}

interface Scenario {
  operation: Promise<unknown>;
  calls: HostingCommandRequest[];
  expectedStages: string[];
  dispose?: () => Promise<void>;
}

interface RedCase {
  classification: HostingAdapterErrorClassification;
  create: () => Promise<Scenario> | Scenario;
}

function fakeAdapter(
  handler: (request: HostingCommandRequest) => HostingCommandResult | Promise<HostingCommandResult>,
  calls: HostingCommandRequest[],
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

function preflightCase(
  classification: HostingAdapterErrorClassification,
  failedStage: string,
  failure: HostingCommandResult | Error,
): RedCase {
  return {
    classification,
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(request => {
        if (stage(request) === failedStage) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return preflightSuccess(request);
      }, calls);
      const sequence = ["version", "auth", "repo"];
      return {
        operation: adapter.preflight({ checkoutPath: LEAK_PATH }),
        calls,
        expectedStages: sequence.slice(0, sequence.indexOf(failedStage) + 1),
      };
    },
  };
}

function pushCase(
  classification: HostingAdapterErrorClassification,
  failedStage: string,
  failure: HostingCommandResult | Error,
): RedCase {
  return {
    classification,
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(request => {
        if (stage(request) === failedStage) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return pushSuccess(request);
      }, calls);
      const sequence = [
        "init", "bundle-create", "bundle-unbundle", "rev-parse", "update-ref", "ls-remote", "push",
      ];
      return {
        operation: adapter.pushBranch(pushRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: sequence.slice(0, sequence.indexOf(failedStage) + 1),
      };
    },
  };
}

function draftCase(
  classification: HostingAdapterErrorClassification,
  failedStage: "pr-list" | "pr-create" | "pr-view",
  failure: HostingCommandResult | Error,
): RedCase {
  return {
    classification,
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(request => {
        const current = stage(request);
        if (current === failedStage) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        if (current === "pr-list") return result("[]");
        if (current === "pr-create") {
          return result("https://github.com/example/project/pull/17\n");
        }
        if (current === "pr-view") return result(JSON.stringify(pullRequestJson()));
        throw new Error(`unexpected ${current} ${SECRET} ${LEAK_PATH}`);
      }, calls);
      const sequence = ["pr-list", "pr-create", "pr-view"];
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: sequence.slice(0, sequence.indexOf(failedStage) + 1),
      };
    },
  };
}

async function checksCase(
  classification: HostingAdapterErrorClassification,
  failedStage: "pr-checks" | "pr-view",
  failure: HostingCommandResult | Error,
): Promise<Scenario> {
  const calls: HostingCommandRequest[] = [];
  const adapter = fakeAdapter(request => {
    const current = stage(request);
    if (current === failedStage) {
      if (failure instanceof Error) throw failure;
      return failure;
    }
    if (current === "pr-list") return result(JSON.stringify([pullRequestJson()]));
    if (current === "pr-checks") return result("[]", { exitCode: 1 });
    if (current === "pr-view") return result(JSON.stringify(pullRequestJson()));
    throw new Error(`unexpected ${current} ${SECRET} ${LEAK_PATH}`);
  }, calls);
  await adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH }));
  const sequence = ["pr-list", "pr-checks", "pr-view"];
  return {
    operation: adapter.requiredChecks(checksRequest({ checkoutPath: LEAK_PATH })),
    calls,
    expectedStages: classification === "required-checks-response-invalid"
      ? sequence
      : sequence.slice(0, sequence.indexOf(failedStage) + 1),
  };
}

async function markReadyCase(
  classification: HostingAdapterErrorClassification,
  failedView: 2 | 3 | undefined,
  failure: HostingCommandResult | Error,
): Promise<Scenario> {
  const calls: HostingCommandRequest[] = [];
  let views = 0;
  const adapter = fakeAdapter(request => {
    const current = stage(request);
    if (current === "pr-list") return result(JSON.stringify([pullRequestJson()]));
    if (current === "pr-checks") {
      return result(JSON.stringify([
        { bucket: "pass", name: "unit", state: "SUCCESS", link: null },
      ]));
    }
    if (current === "pr-view") {
      views += 1;
      if (views === failedView) {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return result(JSON.stringify(pullRequestJson({ isDraft: views < 3 })));
    }
    if (current === "pr-ready") {
      if (failedView === undefined) {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      return result();
    }
    throw new Error(`unexpected ${current} ${SECRET} ${LEAK_PATH}`);
  }, calls);
  await adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH }));
  await adapter.requiredChecks(checksRequest({ checkoutPath: LEAK_PATH }));
  const expectedStages = failedView === 2
    ? ["pr-list", "pr-checks", "pr-view", "pr-view"]
    : failedView === 3
      ? ["pr-list", "pr-checks", "pr-view", "pr-view", "pr-ready", "pr-view"]
      : ["pr-list", "pr-checks", "pr-view", "pr-view", "pr-ready"];
  return {
    operation: adapter.markReady(markReadyRequest({ checkoutPath: LEAK_PATH })),
    calls,
    expectedStages,
  };
}

const redCases: RedCase[] = [
  preflightCase("preflight-gh-unavailable", "version", new Error(`${SECRET} ${LEAK_PATH}`)),
  preflightCase("preflight-gh-version-invalid", "version", result("not a version")),
  preflightCase("preflight-gh-version-unsupported", "version", result("gh version 2.95.9\n")),
  preflightCase("preflight-auth-failed", "auth", result("", { exitCode: 4 })),
  preflightCase("preflight-repository-query-failed", "repo", result("", { timedOut: true })),
  preflightCase("preflight-repository-response-invalid", "repo", result(`{"leak":"${SECRET}"}`)),
  preflightCase("preflight-repository-url-invalid", "repo", result(JSON.stringify({
    nameWithOwner: "example/project", url: `https://github.com/example/project?token=${SECRET}`,
  }))),
  preflightCase("preflight-repository-identity-mismatch", "repo", result(JSON.stringify({
    nameWithOwner: "example/project", url: "https://github.com/example/other",
  }))),
  {
    classification: "push-request-invalid",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(pushSuccess, calls);
      return { operation: adapter.pushBranch(pushRequest({ branch: "--force" })), calls, expectedStages: [] };
    },
  },
  {
    classification: "push-quarantine-create-failed",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(pushSuccess, calls, {
        createTemporaryDirectory: async () => { throw new Error(`${SECRET} ${LEAK_PATH}`); },
      });
      return { operation: adapter.pushBranch(pushRequest()), calls, expectedStages: [] };
    },
  },
  {
    classification: "push-quarantine-cleanup-failed",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(pushSuccess, calls, {
        createTemporaryDirectory: async () => "/runtime-owned/quarantine",
        removeTemporaryDirectory: async () => { throw new Error(`${SECRET} ${LEAK_PATH}`); },
      });
      return {
        operation: adapter.pushBranch(pushRequest()),
        calls,
        expectedStages: [
          "init", "bundle-create", "bundle-unbundle", "rev-parse", "update-ref", "ls-remote", "push",
        ],
      };
    },
  },
  pushCase("push-quarantine-init-failed", "init", result("", { exitCode: 1 })),
  pushCase("push-bundle-create-failed", "bundle-create", result("", { exitCode: 1 })),
  pushCase("push-bundle-import-failed", "bundle-unbundle", result("", { exitCode: 1 })),
  pushCase("push-imported-oid-mismatch", "bundle-unbundle",
    result(`${OTHER_HEAD} refs/heads/feat/autopilot-01234567\n`)),
  pushCase("push-remote-precheck-failed", "ls-remote", result("", { exitCode: 1 })),
  pushCase("push-remote-response-invalid", "ls-remote", result(`invalid ${SECRET}\n`)),
  pushCase("push-remote-head-mismatch", "ls-remote",
    result(`${OTHER_HEAD}\trefs/heads/feat/autopilot-01234567\n`)),
  pushCase("push-command-failed", "push", new Error(`${SECRET} ${LEAK_PATH}`)),
  {
    classification: "draft-pull-request-request-invalid",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(), calls);
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ title: "bad\ntitle" })),
        calls,
        expectedStages: [],
      };
    },
  },
  draftCase("draft-pull-request-list-failed", "pr-list", result("", { cancelled: true })),
  {
    classification: "draft-pull-request-response-invalid",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(`{"leak":"${SECRET}"}`), calls);
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: ["pr-list"],
      };
    },
  },
  {
    classification: "draft-pull-request-identity-mismatch",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(JSON.stringify([
        pullRequestJson({ headRepository: { nameWithOwner: "attacker/project" } }),
      ])), calls);
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: ["pr-list"],
      };
    },
  },
  {
    classification: "draft-pull-request-head-mismatch",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(JSON.stringify([
        pullRequestJson({ headRefOid: OTHER_HEAD }),
      ])), calls);
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: ["pr-list"],
      };
    },
  },
  {
    classification: "draft-pull-request-ambiguous",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(JSON.stringify([
        pullRequestJson(),
        pullRequestJson({ number: 18, url: "https://github.com/example/project/pull/18" }),
      ])), calls);
      return {
        operation: adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: ["pr-list"],
      };
    },
  },
  draftCase("draft-pull-request-create-failed", "pr-create", new Error(`${SECRET} ${LEAK_PATH}`)),
  {
    classification: "required-checks-request-invalid",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(), calls);
      return {
        operation: adapter.requiredChecks(checksRequest({ pullRequestNumber: 0 })),
        calls,
        expectedStages: [],
      };
    },
  },
  {
    classification: "required-checks-identity-not-established",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(), calls);
      return { operation: adapter.requiredChecks(checksRequest()), calls, expectedStages: [] };
    },
  },
  { classification: "required-checks-command-failed", create: () => checksCase(
    "required-checks-command-failed", "pr-checks", new Error(`${SECRET} ${LEAK_PATH}`),
  ) },
  { classification: "required-checks-identity-query-failed", create: () => checksCase(
    "required-checks-identity-query-failed", "pr-view", result("", { exitCode: 1 }),
  ) },
  { classification: "required-checks-identity-response-invalid", create: () => checksCase(
    "required-checks-identity-response-invalid", "pr-view", result(`{"leak":"${SECRET}"}`),
  ) },
  { classification: "required-checks-identity-mismatch", create: () => checksCase(
    "required-checks-identity-mismatch", "pr-view",
    result(JSON.stringify(pullRequestJson({ headRefOid: OTHER_HEAD }))),
  ) },
  { classification: "required-checks-response-invalid", create: () => checksCase(
    "required-checks-response-invalid", "pr-checks", result(`[{"bucket":"${SECRET}"}]`, { exitCode: 1 }),
  ) },
  {
    classification: "mark-ready-request-invalid",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(), calls);
      return {
        operation: adapter.markReady(markReadyRequest({ pullRequestNumber: 0 })),
        calls,
        expectedStages: [],
      };
    },
  },
  {
    classification: "mark-ready-identity-not-established",
    create: () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(() => result(), calls);
      return { operation: adapter.markReady(markReadyRequest()), calls, expectedStages: [] };
    },
  },
  {
    classification: "mark-ready-checks-not-passed",
    create: async () => {
      const calls: HostingCommandRequest[] = [];
      const adapter = fakeAdapter(request => result(JSON.stringify([pullRequestJson()])), calls);
      await adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH }));
      return {
        operation: adapter.markReady(markReadyRequest({ checkoutPath: LEAK_PATH })),
        calls,
        expectedStages: ["pr-list"],
      };
    },
  },
  { classification: "mark-ready-identity-query-failed", create: () => markReadyCase(
    "mark-ready-identity-query-failed", 2, new Error(`${SECRET} ${LEAK_PATH}`),
  ) },
  { classification: "mark-ready-identity-response-invalid", create: () => markReadyCase(
    "mark-ready-identity-response-invalid", 2, result(`{"leak":"${SECRET}"}`),
  ) },
  { classification: "mark-ready-identity-mismatch", create: () => markReadyCase(
    "mark-ready-identity-mismatch", 2,
    result(JSON.stringify(pullRequestJson({ headRefOid: OTHER_HEAD }))),
  ) },
  { classification: "mark-ready-command-failed", create: () => markReadyCase(
    "mark-ready-command-failed", undefined, new Error(`${SECRET} ${LEAK_PATH}`),
  ) },
  ...([
    ["in-memory-preflight-not-configured", (adapter: InMemoryHostingAdapter) =>
      adapter.preflight({ checkoutPath: LEAK_PATH })],
    ["in-memory-push-not-configured", (adapter: InMemoryHostingAdapter) =>
      adapter.pushBranch(pushRequest({ checkoutPath: LEAK_PATH }))],
    ["in-memory-draft-pull-request-not-configured", (adapter: InMemoryHostingAdapter) =>
      adapter.ensureDraftPullRequest(draftRequest({ checkoutPath: LEAK_PATH }))],
    ["in-memory-required-checks-not-configured", (adapter: InMemoryHostingAdapter) =>
      adapter.requiredChecks(checksRequest({ checkoutPath: LEAK_PATH }))],
    ["in-memory-mark-ready-not-configured", (adapter: InMemoryHostingAdapter) =>
      adapter.markReady(markReadyRequest({ checkoutPath: LEAK_PATH }))],
  ] as const).map(([classification, operation]): RedCase => ({
    classification,
    create: () => ({
      operation: operation(new InMemoryHostingAdapter()),
      calls: [],
      expectedStages: [],
    }),
  })),
];

const allRedClassifications = [
  "preflight-gh-unavailable",
  "preflight-gh-version-invalid",
  "preflight-gh-version-unsupported",
  "preflight-auth-failed",
  "preflight-repository-query-failed",
  "preflight-repository-response-invalid",
  "preflight-repository-url-invalid",
  "preflight-repository-identity-mismatch",
  "push-request-invalid",
  "push-quarantine-create-failed",
  "push-quarantine-init-failed",
  "push-bundle-create-failed",
  "push-bundle-import-failed",
  "push-imported-oid-mismatch",
  "push-remote-precheck-failed",
  "push-remote-response-invalid",
  "push-remote-head-mismatch",
  "push-command-failed",
  "push-quarantine-cleanup-failed",
  "draft-pull-request-request-invalid",
  "draft-pull-request-list-failed",
  "draft-pull-request-response-invalid",
  "draft-pull-request-identity-mismatch",
  "draft-pull-request-head-mismatch",
  "draft-pull-request-ambiguous",
  "draft-pull-request-create-failed",
  "required-checks-request-invalid",
  "required-checks-identity-not-established",
  "required-checks-identity-query-failed",
  "required-checks-identity-response-invalid",
  "required-checks-identity-mismatch",
  "required-checks-command-failed",
  "required-checks-response-invalid",
  "mark-ready-request-invalid",
  "mark-ready-identity-not-established",
  "mark-ready-identity-query-failed",
  "mark-ready-identity-response-invalid",
  "mark-ready-identity-mismatch",
  "mark-ready-checks-not-passed",
  "mark-ready-command-failed",
  "in-memory-preflight-not-configured",
  "in-memory-push-not-configured",
  "in-memory-draft-pull-request-not-configured",
  "in-memory-required-checks-not-configured",
  "in-memory-mark-ready-not-configured",
] as const satisfies readonly HostingAdapterErrorClassification[];

type MissingRedClassification = Exclude<
  HostingAdapterErrorClassification,
  (typeof allRedClassifications)[number]
>;
const allRedClassificationsAreRepresented: MissingRedClassification extends never ? true : false = true;
void allRedClassificationsAreRepresented;

describe("GitHubCliAdapter complete red-path matrix", () => {
  it("contains exactly one case for every reachable classification", () => {
    expect(redCases.map(redCase => redCase.classification).sort()).toEqual(
      [...allRedClassifications].sort(),
    );
  });

  it.each(redCases)("classifies $classification, stops, and redacts", async redCase => {
    const scenario = await redCase.create();
    try {
      const error = await scenario.operation.catch(cause => cause);
      expect(error).toBeInstanceOf(HostingAdapterError);
      expect(error).toMatchObject({
        classification: redCase.classification,
        message: redCase.classification,
      });
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain(LEAK_PATH);
      expect(scenario.calls.map(stage)).toEqual(scenario.expectedStages);
    } finally {
      await scenario.dispose?.();
    }
  });
});

describe("GitHubCliAdapter request injection matrix", () => {
  const injectedTarget = (field: keyof HostingTarget): HostingTarget => ({
    ...TARGET,
    [field]: field === "provider"
      ? "github\n--hostname=attacker.invalid"
      : `${TARGET[field]}\n--config=credential.helper=attacker`,
  } as HostingTarget);

  const cases: Array<{
    field: string;
    classification: HostingAdapterErrorClassification;
    run: (adapter: GitHubCliAdapter) => Promise<unknown>;
  }> = [
    {
      field: "preflight.checkoutPath",
      classification: "preflight-repository-identity-mismatch",
      run: adapter => adapter.preflight({ checkoutPath: `/source\0${SECRET}` }),
    },
    {
      field: "preflight.expectedRepository",
      classification: "preflight-repository-identity-mismatch",
      run: adapter => adapter.preflight({
        checkoutPath: "/source", expectedRepository: `example/project\n${SECRET}`,
      }),
    },
    ...(["checkoutPath", "target.provider", "target.repository", "target.canonicalHttpsUrl", "branch", "headCommitOid"] as const)
      .map(field => ({
        field: `push.${field}`,
        classification: "push-request-invalid" as const,
        run: (adapter: GitHubCliAdapter) => adapter.pushBranch(pushRequest(
          field === "checkoutPath" ? { checkoutPath: `/source\0${SECRET}` }
            : field === "branch" ? { branch: `--upload-pack=${SECRET}` }
              : field === "headCommitOid" ? { headCommitOid: `${HEAD}\n${SECRET}` }
                : { target: injectedTarget(field.slice("target.".length) as keyof HostingTarget) },
        )),
      })),
    ...(["checkoutPath", "target.provider", "target.repository", "target.canonicalHttpsUrl", "baseBranch", "headBranch", "headCommitOid", "title", "body"] as const)
      .map(field => ({
        field: `draft.${field}`,
        classification: "draft-pull-request-request-invalid" as const,
        run: (adapter: GitHubCliAdapter) => adapter.ensureDraftPullRequest(draftRequest(
          field === "checkoutPath" ? { checkoutPath: `/source\0${SECRET}` }
            : field === "baseBranch" ? { baseBranch: `--upload-pack=${SECRET}` }
              : field === "headBranch" ? { headBranch: `--upload-pack=${SECRET}` }
                : field === "headCommitOid" ? { headCommitOid: `${HEAD}\n${SECRET}` }
                  : field === "title" ? { title: `title\n${SECRET}` }
                    : field === "body" ? { body: `body\0${SECRET}` }
                      : { target: injectedTarget(field.slice("target.".length) as keyof HostingTarget) },
        )),
      })),
    ...(["requiredChecks", "markReady"] as const).flatMap(operation =>
      (["checkoutPath", "target.provider", "target.repository", "target.canonicalHttpsUrl", "pullRequestNumber"] as const)
        .map(field => ({
          field: `${operation}.${field}`,
          classification: operation === "requiredChecks"
            ? "required-checks-request-invalid" as const
            : "mark-ready-request-invalid" as const,
          run: (adapter: GitHubCliAdapter) => {
            const overrides = field === "checkoutPath" ? { checkoutPath: `/source\0${SECRET}` }
              : field === "pullRequestNumber" ? { pullRequestNumber: Number.NaN }
                : { target: injectedTarget(field.slice("target.".length) as keyof HostingTarget) };
            return operation === "requiredChecks"
              ? adapter.requiredChecks(checksRequest(overrides))
              : adapter.markReady(markReadyRequest(overrides));
          },
        }))),
  ];

  it.each(cases)("rejects $field before spawn", async injection => {
    const calls: HostingCommandRequest[] = [];
    const adapter = fakeAdapter(() => {
      throw new Error(`spawned ${SECRET} ${LEAK_PATH}`);
    }, calls);
    const error = await injection.run(adapter).catch(cause => cause);
    expect(error).toMatchObject({ classification: injection.classification });
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(LEAK_PATH);
    expect(calls).toEqual([]);
  });
});

it("pushes without setting an upstream", async () => {
  const calls: HostingCommandRequest[] = [];
  const adapter = fakeAdapter(pushSuccess, calls);
  await expect(adapter.pushBranch(pushRequest())).resolves.toEqual({ remoteHead: HEAD });
  const argumentsUsed = calls.flatMap(call => call.args);
  expect(argumentsUsed).not.toContain("upstream");
  expect(argumentsUsed).not.toContain("--set-upstream");
  expect(argumentsUsed).not.toContain("-u");
  expect(calls.some(call => call.args.includes("remote"))).toBe(false);
});
