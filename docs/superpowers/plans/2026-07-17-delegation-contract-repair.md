# Delegation Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the Delegation Spec guidance, tracked-file symlink precondition, and legacy Codex edit wrapper without weakening clean-checkout, repository-escape, or caller-override defenses.

**Architecture:** Keep the canonical JSON schema authoritative and add reviewer focus as one backward-compatible optional field rendered only to reviewers. Refine the precondition scanner with index-mode and canonical-target checks that accept only tracked links to contained non-Git regular files. Make the legacy Codex wrapper, rather than its caller, select sandbox mode and physical working root.

**Tech Stack:** TypeScript 5.9, Node.js 22, AJV JSON Schema 2020-12, Vitest, Bash, Git worktrees, esbuild.

## Global Constraints

- Preserve protocol marker `1.1.0`; this is an additive schema change.
- Preserve exact clean-checkout rejection; add no dirty-path exceptions.
- Accept only tracked mode-`120000` links to regular files inside the checkout and outside `.git`.
- Reject directory, broken, cyclic, external, untracked, ignored, and Git-metadata symlinks in write scope.
- Preserve raw Codex `--sandbox`, `--cd`, `--add-dir`, approval, feature-enable, and unsafe config rejection.
- Default the legacy wrapper to read-only; only `--lane-mode edit` selects `workspace-write`.
- Keep generated `runtime/server.mjs` byte-reproducible from `src/` and runtime schemas.
- Do not bump a release version.
- Do not create commits unless the user explicitly requests one.

## File Map

- `runtime/schemas/delegation-spec.v1.json`: canonical optional `review.focus` contract.
- `src/protocol/delegation-spec.ts`: TypeScript representation of `review.focus`.
- `src/pipeline/role-prompts.ts`: reviewer-only rendering of host focus guidance.
- `skills/delegate/SKILL.md`: exact Delegation Spec syntax, limits, overrides, review focus, and clean-checkout preparation.
- `src/git/repo-preconditions.ts`: tracked symlink mode parsing and fail-closed target qualification.
- `scripts/run-codex-isolated.sh`: wrapper-owned lane mode, sandbox, and physical cwd.
- `agents/codex-implementer.md`: Claude legacy lane invocation and flag contract.
- `.opencode/agents/codex-implementer.md`: OpenCode mirror of the same invocation contract.
- `tests/runtime/spec-validator-review.test.ts`: schema acceptance and rejection cases.
- `tests/runtime/role-prompts.test.ts`: reviewer-only focus propagation.
- `tests/delegate-routing.test.mjs`: delegate skill prose contract.
- `tests/runtime/repo-preconditions.test.ts`: real-Git symlink regressions.
- `tests/runtime/isolated-scripts.test.ts`: fake-Codex argv and wrapper-mode regressions.
- `tests/codex-lifecycle.test.sh`: release-only shell coverage of injected defaults.
- `tests/lane-contract.test.mjs`: both agent definitions use the private edit selector and no raw scope flags.
- `runtime/server.mjs`: generated bundle.
- `CHANGELOG.md`: Unreleased user-visible fixes.
- `scratchpad.md`: durable dogfood regression descriptions.

---

### Task 1: Delegation Spec And Skill Contract

**Files:**
- Modify: `tests/runtime/spec-validator-review.test.ts`
- Modify: `tests/runtime/role-prompts.test.ts`
- Modify: `tests/delegate-routing.test.mjs`
- Modify: `runtime/schemas/delegation-spec.v1.json`
- Modify: `src/protocol/delegation-spec.ts`
- Modify: `src/pipeline/role-prompts.ts`
- Modify: `skills/delegate/SKILL.md`

**Interfaces:**
- Consumes: `validateSpec(input)`, `renderRolePrompt(role, pkg)`, and the closed `review` schema.
- Produces: `ReviewConfig.focus?: string[]`; reviewer prompts containing a `## Review focus` section; exact public skill guidance.

- [ ] **Step 1: Add failing schema tests for reviewer focus**

Add these cases inside `describe("delegation spec review block", ...)`:

```ts
it("accepts non-empty reviewer focus guidance", () => {
  const spec = {
    ...makeValidSpec(),
    review: {
      reviewers: ["correctness"],
      maxRounds: 1,
      focus: ["Check cancellation cleanup on Windows."],
    },
  };
  expect(validateSpec(spec).ok).toBe(true);
});

it("rejects empty or malformed reviewer focus guidance", () => {
  expect(validateSpec({
    ...makeValidSpec(),
    review: { reviewers: ["systems"], maxRounds: 2, focus: [] },
  }).ok).toBe(false);
  expect(validateSpec({
    ...makeValidSpec(),
    review: { reviewers: ["systems"], maxRounds: 2, focus: [""] },
  }).ok).toBe(false);
  expect(validateSpec({
    ...makeValidSpec(),
    review: { reviewers: ["systems"], maxRounds: 2, notes: "unsupported" },
  }).ok).toBe(false);
});
```

- [ ] **Step 2: Add failing reviewer-prompt tests and correct the invalid fixture token**

Change the typed fixture's network value from `"deny"` to `"denied"`, then add a focus block:

```ts
const spec: DelegationSpec = {
  specVersion: "1", objective: "Add rate limiting", context: "SECRET-IMPLEMENTER-REASONING must never appear",
  writeAllowlist: ["src/api/**"], forbiddenScope: ["src/auth/**"], successCriteria: ["429 after 10 req/s"],
  verification: [{ id: "unit", executable: "npm", args: ["test"], cwd: ".", timeoutMs: 60_000,
    network: "denied", expectedExitCodes: [0] }],
  executionMode: "edit", timeoutMs: 600_000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
  review: {
    reviewers: ["correctness", "systems"],
    maxRounds: 2,
    focus: ["Check token-bucket races under concurrent requests."],
  },
};
```

Add these assertions:

```ts
it("includes host-authored focus only in reviewer prompts", () => {
  for (const role of ["reviewer-correctness", "reviewer-systems"] as const) {
    const prompt = renderRolePrompt(role, pkg);
    expect(prompt).toContain("## Review focus");
    expect(prompt).toContain("Check token-bucket races under concurrent requests.");
  }
  for (const role of ["fixer", "verifier"] as const) {
    const prompt = renderRolePrompt(role, pkg);
    expect(prompt).not.toContain("## Review focus");
    expect(prompt).not.toContain("Check token-bucket races under concurrent requests.");
  }
});
```

- [ ] **Step 3: Add failing skill-contract assertions**

Append these checks before the final `console.log` in `tests/delegate-routing.test.mjs`:

```js
assert.match(skill, /verification command uses `args`, not `argv`/u);
assert.match(skill, /`network` is exactly `"denied"` or `"allowed"`/u);
assert.match(skill, /command `timeoutMs` must be 1\.\.1800000/u);
assert.match(skill, /attempt `timeoutMs` must be 600000\.\.1800000/u);
assert.match(skill, /`producerPreferences` is an ordered array of Producer id strings/u);
assert.match(skill, /`producerOverrides: \{ model\?, reasoningEffort\? \}`/u);
assert.match(skill, /`review\.focus`/u);
assert.match(skill, /tracked or unignored changes must be committed before delegation/u);
```

- [ ] **Step 4: Run the focused tests to prove the new behavior fails**

Run:

```bash
npx vitest run tests/runtime/spec-validator-review.test.ts tests/runtime/role-prompts.test.ts
node tests/delegate-routing.test.mjs
```

Expected: Vitest rejects `review.focus` or the role-prompt assertion fails; the Node contract test also fails because the skill lacks the exact guidance.

- [ ] **Step 5: Add `review.focus` to the canonical schema and TypeScript type**

Add `focus` beside `maxRounds` in `runtime/schemas/delegation-spec.v1.json`:

```json
"focus": {
  "type": "array",
  "minItems": 1,
  "items": {
    "type": "string",
    "minLength": 1
  }
}
```

Update `ReviewConfig` in `src/protocol/delegation-spec.ts`:

```ts
export interface ReviewConfig {
  reviewers: ReviewerKind[];
  maxRounds: number;
  focus?: string[];
}
```

- [ ] **Step 6: Render focus only in reviewer prompts**

Add this helper before `reviewerPrompt`:

```ts
function reviewerFocusSection(spec: DelegationSpec): string | null {
  const focus = spec.review?.focus;
  if (focus === undefined || focus.length === 0) return null;
  return `## Review focus\n${focus.map(item => `- ${item}`).join("\n")}`;
}
```

Change `reviewerPrompt` so the trusted focus section is inserted after the common spec section and before the fixed rubric:

```ts
function reviewerPrompt(rubric: string, pkg: RolePackage): string {
  const focusSection = reviewerFocusSection(pkg.spec);
  return [
    "You are an untrusted, READ-ONLY code reviewer in a fresh session. You cannot edit files;",
    "the sandbox denies writes. Do not attempt to fix anything. Do not delegate to other agents.",
    "Judge ONLY the candidate diff against the delegation spec below.",
    commonSections(pkg),
    ...(focusSection === null ? [] : [focusSection]),
    rubric,
    CRITERION_DISCIPLINE,
    SEVERITY_RUBRIC,
    "## Output",
    "Reply with ONLY a fenced ```json block matching this schema exactly (no prose after it):",
    "```json", REVIEW_SCHEMA, "```",
  ].join("\n\n");
}
```

Do not add focus to `commonSections`; that function is also used by fixer and verifier roles.

- [ ] **Step 7: Rewrite the skill's schema guidance with exact accepted syntax**

Replace the ambiguous verification and execution bullets with text containing these exact contracts:

```markdown
7. `verification`: Host-authorized command objects. Each command uses `args`, not `argv`; `network` is exactly `"denied"` or `"allowed"`; command `timeoutMs` must be 1..1800000; include a repository-relative `cwd`, expected exit codes, and optional platform filters.
8. `executionMode: "edit"`; attempt `timeoutMs` must be 600000..1800000; `producerPreferences` is an ordered array of Producer id strings; use optional `producerOverrides: { model?, reasoningEffort? }`; and set `expectedOutput: "candidate-patch"`.
```

Replace the subjective-criteria instruction with:

```markdown
- Keep observable outcomes in `successCriteria`. Put reviewer-only, non-commandable concerns in `review.focus`; no undocumented review keys are accepted.
```

Extend the pipeline example:

```yaml
review:
  reviewers: [correctness, systems]
  maxRounds: 2
  focus:
    - Check platform-specific process cleanup.
```

Add this precondition guidance before the trusted lifecycle:

```markdown
**Repository precondition:** delegation and controlled integration require an exact clean checkout. Tracked or unignored changes must be committed before delegation, including tracked planning files such as `tasks/todo.md`. Git-ignored local planning files do not affect the clean check. Do not use skip-worktree or assume-unchanged flags as a workaround.
```

- [ ] **Step 8: Re-run Task 1 tests**

Run:

```bash
npx vitest run tests/runtime/spec-validator-review.test.ts tests/runtime/role-prompts.test.ts
node tests/delegate-routing.test.mjs
```

Expected: all focused Vitest tests pass and the Node script prints `PASS: unspecified delegations require an explicit CLI selection.`

- [ ] **Step 9: Review the Task 1 diff checkpoint**

Run:

```bash
git diff --check -- runtime/schemas/delegation-spec.v1.json src/protocol/delegation-spec.ts src/pipeline/role-prompts.ts skills/delegate/SKILL.md tests/runtime/spec-validator-review.test.ts tests/runtime/role-prompts.test.ts tests/delegate-routing.test.mjs
```

Expected: exit 0. Do not commit without explicit user authorization.

---

### Task 2: Safe Tracked-File Symlink Precondition

**Files:**
- Modify: `tests/runtime/repo-preconditions.test.ts`
- Modify: `src/git/repo-preconditions.ts`

**Interfaces:**
- Consumes: `git ls-files --stage -z`, canonical checkout root, write allowlist, existing `checkPreconditions()` result vocabulary.
- Produces: tracked-mode sets and a target qualification predicate used only by nested-repository discovery.

- [ ] **Step 1: Add the failing contained-file regression for primary and linked worktrees**

Add this POSIX real-Git test:

```ts
it.skipIf(process.platform === "win32")("accepts a tracked symlink to a contained regular file in primary and linked worktrees", async () => {
  const directory = await initRepo();
  await writeFile(join(directory, "CHANGELOG.md"), "release notes\n");
  await mkdir(join(directory, "src", "package"), { recursive: true });
  await symlink("../../CHANGELOG.md", join(directory, "src", "package", "CHANGELOG.md"), "file");
  await runGit(directory, ["add", "CHANGELOG.md", "src/package/CHANGELOG.md"]);
  await runGit(directory, ["commit", "-q", "-m", "add packaged changelog link"]);

  await expect(checkPreconditions(directory, {
    writeAllowlist: ["src/**"],
  })).resolves.toMatchObject({ ok: true });

  const base = await runGit(directory, ["rev-parse", "HEAD"]);
  const linked = await temporaryDirectory("ca-symlink-linked-");
  await rm(linked, { recursive: true, force: true });
  await runGit(directory, ["worktree", "add", "--detach", "-q", linked, base]);
  try {
    await expect(checkPreconditions(linked, {
      writeAllowlist: ["src/**"],
    })).resolves.toMatchObject({ ok: true, baseCommitOid: base });
  } finally {
    await runGit(directory, ["worktree", "remove", "--force", linked]);
  }
});
```

- [ ] **Step 2: Add fail-closed tests for internal directories, external files, broken links, ignored links, and Git metadata**

Add separate POSIX tests using the existing `initRepo`, `temporaryDirectory`, and `runGit` helpers. Each test must commit any tracked symlink before calling `checkPreconditions`.

Use these constructions and expectations:

```ts
// Contained directory target remains unsafe.
await mkdir(join(directory, "shared"));
await mkdir(join(directory, "src"));
await symlink("../shared", join(directory, "src", "shared"), "dir");
await runGit(directory, ["add", "src/shared"]);
await runGit(directory, ["commit", "-q", "-m", "add directory link"]);
await expect(checkPreconditions(directory, { writeAllowlist: ["src/**"] }))
  .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["src/shared"] });

// External regular-file target remains unsafe.
const external = await temporaryDirectory("ca-symlink-file-target-");
await writeFile(join(external, "outside.txt"), "outside\n");
await symlink(join(external, "outside.txt"), join(directory, "outside-link"), "file");
await runGit(directory, ["add", "outside-link"]);
await runGit(directory, ["commit", "-q", "-m", "add external file link"]);
await expect(checkPreconditions(directory, { writeAllowlist: ["outside-link"] }))
  .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["outside-link"] });

// Broken tracked link remains unsafe.
await symlink("missing.txt", join(directory, "broken-link"), "file");
await runGit(directory, ["add", "broken-link"]);
await runGit(directory, ["commit", "-q", "-m", "add broken link"]);
await expect(checkPreconditions(directory, { writeAllowlist: ["broken-link"] }))
  .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["broken-link"] });

// Ignored, untracked link remains unsafe even when its target is contained.
await writeFile(join(directory, ".gitignore"), "ignored-link\n");
await writeFile(join(directory, "target.txt"), "target\n");
await runGit(directory, ["add", ".gitignore", "target.txt"]);
await runGit(directory, ["commit", "-q", "-m", "prepare ignored link"]);
await symlink("target.txt", join(directory, "ignored-link"), "file");
await expect(checkPreconditions(directory, { writeAllowlist: ["ignored-link"] }))
  .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["ignored-link"] });

// A linked worktree's regular-file .git entry is never an allowed target.
await symlink(".git", join(linked, "git-link"), "file");
await runGit(linked, ["add", "git-link"]);
await runGit(linked, ["commit", "-q", "-m", "add git metadata link"]);
await expect(checkPreconditions(linked, { writeAllowlist: ["git-link"] }))
  .resolves.toEqual({ ok: false, reason: "nested-repository", detail: ["git-link"] });
```

Give every construction its own repository so one unsafe entry cannot mask another. Wrap linked-worktree creation in `try/finally` and remove it through the primary repository.

- [ ] **Step 3: Run the symlink tests to prove the contained-file case fails**

Run:

```bash
npx vitest run tests/runtime/repo-preconditions.test.ts
```

Expected: the new contained regular-file test fails with `{ ok: false, reason: "nested-repository", detail: ["src/package/CHANGELOG.md"] }`; existing and new unsafe-link cases remain rejected.

- [ ] **Step 4: Parse tracked paths by Git index mode**

Replace `submodulePaths` with a generic helper:

```ts
function indexPathsWithMode(output: string, mode: "120000" | "160000"): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record.startsWith(`${mode} `)) continue;
    const separator = record.indexOf("\t");
    if (separator !== -1) paths.add(record.slice(separator + 1).replace(/\\/g, "/"));
  }
  return paths;
}
```

In `checkPreconditions`, derive both sets from the one staged-entry result:

```ts
const registeredSubmodules = indexPathsWithMode(stagedEntries.stdout, "160000");
const trackedSymlinks = indexPathsWithMode(stagedEntries.stdout, "120000");
```

Pass both sets to `findNestedRepositories`.

- [ ] **Step 5: Add canonical containment and safe-target qualification**

Import `canonicalizeForScope` from `src/platform/windows-platform-services.ts`, then add:

```ts
function pathIsWithin(root: string, candidate: string): boolean {
  if (getPlatformServices().os === "win32") {
    return canonicalizeForScope(candidate, root);
  }
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && codes.includes(String(error.code));
}

async function isSafeTrackedFileSymlink(
  repositoryRoot: string,
  symlinkPath: string,
  relativePath: string,
  trackedSymlinks: Set<string>,
): Promise<boolean> {
  if (!trackedSymlinks.has(relativePath)) return false;

  let target: string;
  try {
    target = await realpath(symlinkPath);
  } catch (error) {
    if (hasCode(error, ["ENOENT", "ENOTDIR", "ELOOP"])) return false;
    throw error;
  }

  if (!pathIsWithin(repositoryRoot, target)) return false;
  if (pathIsWithin(path.join(repositoryRoot, ".git"), target)) return false;
  return (await lstat(target)).isFile();
}
```

`repositoryRoot` is already canonical when `findNestedRepositories` is called. Any unexpected realpath or lstat error must escape to the existing `nested-repository-scan-failed` catch.

- [ ] **Step 6: Qualify symlinks without traversing them**

Add `trackedSymlinks: Set<string>` to `findNestedRepositories`. Replace the unconditional symlink branch with:

```ts
if (entry.isSymbolicLink()) {
  if (!await isSafeTrackedFileSymlink(
    repositoryRoot,
    child,
    relativeChild,
    trackedSymlinks,
  )) {
    nested.push(relativeChild);
  }
  continue;
}
```

Do not enqueue a safe file target in `pendingDirectories`; this is the no-follow guarantee.

- [ ] **Step 7: Re-run repository precondition tests**

Run:

```bash
npx vitest run tests/runtime/repo-preconditions.test.ts
```

Expected: all tests pass. On Windows, POSIX symlink creation cases are skipped while existing ordinary-file behavior remains covered by the platform suite.

- [ ] **Step 8: Run cross-layer precondition consumers**

Run:

```bash
npx vitest run tests/runtime/attempt-runtime.test.ts tests/runtime/controlled-integrator.test.ts tests/runtime/structural-verifier.test.ts
```

Expected: all tests pass; clean checkout, integration, and immutable-candidate symlink defenses remain unchanged.

- [ ] **Step 9: Review the Task 2 diff checkpoint**

Run:

```bash
git diff --check -- src/git/repo-preconditions.ts tests/runtime/repo-preconditions.test.ts
```

Expected: exit 0. Do not commit without explicit user authorization.

---

### Task 3: Wrapper-Owned Legacy Codex Edit Mode

**Files:**
- Modify: `tests/runtime/isolated-scripts.test.ts`
- Modify: `tests/codex-lifecycle.test.sh`
- Modify: `tests/lane-contract.test.mjs`
- Modify: `scripts/run-codex-isolated.sh`
- Modify: `agents/codex-implementer.md`
- Modify: `.opencode/agents/codex-implementer.md`

**Interfaces:**
- Consumes: wrapper argv and physical current directory.
- Produces: private `--lane-mode edit|read-only`; authoritative Codex `--sandbox` and `--cd` argv.

- [ ] **Step 1: Extend the test runner with an explicit cwd seam**

Import `realpath` from `node:fs/promises`, then change the helper in `tests/runtime/isolated-scripts.test.ts`:

```ts
function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<RunResult> {
  return new Promise(resolve => {
    execFile("/bin/bash", [script, ...args], { env, cwd }, (error, stdout, stderr) => {
      const exitCode = error !== null && "code" in error && typeof error.code === "number"
        ? error.code
        : 0;
      resolve({ stdout, stderr, exitCode });
    });
  });
}
```

- [ ] **Step 2: Make default read-only and explicit edit argv tests fail first**

Rename the safe-forwarding test to `"injects a read-only sandbox and physical cwd by default"`, run it with `fixture.root` as cwd, and compare against its physical path:

```ts
const physicalRoot = await realpath(fixture.root);
expect(forwarded).toEqual([
  "exec", "--ignore-user-config", "--ephemeral",
  "--sandbox", "read-only",
  "--cd", physicalRoot,
  ...safeArgs,
  "--disable", "multi_agent",
  "-c", "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
]);
```

Add an edit-mode test using the same fake Codex capture:

```ts
const physicalRoot = await realpath(fixture.root);
const result = await run(runCodexIsolated, ["--lane-mode", "edit", ...safeArgs], {
  PATH: fixture.bin,
  CODEX_TIMEOUT_SECONDS: "0",
}, fixture.root);

expect(result.exitCode).toBe(0);
const forwarded = (await readFile(argsFile, "utf8")).split("\0").filter(Boolean);
expect(forwarded).toEqual([
  "exec", "--ignore-user-config", "--ephemeral",
  "--sandbox", "workspace-write",
  "--cd", physicalRoot,
  ...safeArgs,
  "--disable", "multi_agent",
  "-c", "features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}",
]);
expect(forwarded).not.toContain("--lane-mode");
```

- [ ] **Step 3: Add malformed and repeated private-mode rejection tests**

Use a fake Codex marker and assert each invocation exits 64 without creating it:

```ts
for (const args of [
  ["--lane-mode"],
  ["--lane-mode", "danger-full-access"],
  ["--lane-mode", "edit", "--lane-mode", "read-only"],
]) {
  const result = await run(runCodexIsolated, args, {
    PATH: fixture.bin,
    CODEX_TIMEOUT_SECONDS: "0",
  }, fixture.root);
  expect(result.exitCode).toBe(64);
}
await expect(access(marker)).rejects.toBeDefined();
```

Keep the existing unsafe-argument table unchanged so raw `--sandbox`, `--cd`, and unsafe config remain exit 65.

- [ ] **Step 4: Add failing lane-prose and release-shell assertions**

Inside the `codexLaneFiles` loop in `tests/lane-contract.test.mjs`, identify the shell command that invokes `$RUNTIME` and assert:

```js
const invocation = shellFenceCommands(source).find(command => command.includes("$RUNTIME") && command.includes("--output-last-message"));
assert.ok(invocation, `${context}: missing Codex runtime invocation`);
requirePattern(invocation, /--lane-mode\s+edit/u, `${context}: implementation invocation must select wrapper-owned edit mode`);
assert.doesNotMatch(invocation, /--sandbox(?:=|\s)|--cd(?:=|\s)|(?:^|\s)-C(?:=|\s)/u, `${context}: invocation must not pass raw Codex sandbox or cwd controls`);
```

In `tests/codex-lifecycle.test.sh`, add these checks after the existing `--ephemeral` check in `run_case`:

```bash
assert_adjacent_args "$state/args" --sandbox read-only "$mode default sandbox"
assert_adjacent_args "$state/args" --cd "$(pwd -P)" "$mode physical cwd"
```

- [ ] **Step 5: Run the wrapper and lane tests to prove they fail**

Run:

```bash
npx vitest run tests/runtime/isolated-scripts.test.ts
node tests/lane-contract.test.mjs
bash tests/codex-lifecycle.test.sh
```

Expected: argv assertions fail because no wrapper-owned sandbox/cwd is present, and lane contract assertions fail because both agent definitions still pass raw Codex flags.

- [ ] **Step 6: Parse and validate the private lane mode before caller arguments**

Insert this block before `reject_unsafe_args "$@"` in `scripts/run-codex-isolated.sh`:

```bash
LANE_MODE=read-only
if [[ "${1:-}" == --lane-mode ]]; then
  if (( $# < 2 )); then
    printf 'ERROR: --lane-mode requires edit or read-only\n' >&2
    exit 64
  fi
  LANE_MODE=$2
  shift 2
fi

case "$LANE_MODE" in
  edit) CODEX_SANDBOX=workspace-write ;;
  read-only) CODEX_SANDBOX=read-only ;;
  *)
    printf 'ERROR: --lane-mode must be edit or read-only; got %q\n' "$LANE_MODE" >&2
    exit 64
    ;;
esac
```

Add a `--lane-mode|--lane-mode=*` branch to `reject_unsafe_args` that prints `ERROR: --lane-mode must appear once at the start` and returns 64. This rejects repeated or misplaced selectors after the leading selector is consumed.

- [ ] **Step 7: Bind Codex to the wrapper-owned physical workspace**

After argument validation, resolve the current directory:

```bash
if ! WORKSPACE_ROOT=$(pwd -P); then
  printf 'ERROR: unable to resolve the Codex workspace root\n' >&2
  exit 69
fi
```

Update both Codex launch branches to inject the same controls before `"$@"`:

```bash
codex exec --ignore-user-config --ephemeral \
  --sandbox "$CODEX_SANDBOX" --cd "$WORKSPACE_ROOT" "$@" \
  --disable multi_agent \
  -c 'features.multi_agent_v2={enabled=false,max_concurrent_threads_per_session=1}'
```

Keep `--sandbox` and `--cd` in the raw caller denylist. The wrapper injection occurs only after caller arguments have passed that denylist.

- [ ] **Step 8: Reconcile both legacy implementer definitions**

Change the Claude invocation to:

```bash
bash "$RUNTIME" \
  --lane-mode edit \
  --model gpt-5.6-sol \
  -c model_reasoning_effort=low \
  --skip-git-repo-check \
  --output-last-message "$FINAL" \
  - < "$SPEC"
```

Change the OpenCode invocation to:

```bash
"$RUNTIME" --lane-mode edit --model gpt-5.6-sol -c model_reasoning_effort=low \
  --skip-git-repo-check --output-last-message "$FINAL" - < "$SPEC"
```

Update each nearby explanation to state that `--lane-mode edit` makes the wrapper inject `--sandbox workspace-write` and `--cd` for the physical current worktree. Do not claim that callers pass `--ignore-user-config`, `--ephemeral`, sandbox, or cwd directly.

- [ ] **Step 9: Re-run wrapper, lane, and release-shell tests**

Run:

```bash
npx vitest run tests/runtime/isolated-scripts.test.ts
node tests/lane-contract.test.mjs
bash tests/codex-lifecycle.test.sh
```

Expected: Vitest passes, lane contracts print `PASS: implementation lane contracts are guarded across both hosts.`, and both lifecycle branches plus timeout/logging cases pass.

- [ ] **Step 10: Review the Task 3 diff checkpoint**

Run:

```bash
bash -n scripts/run-codex-isolated.sh tests/codex-lifecycle.test.sh
git diff --check -- scripts/run-codex-isolated.sh agents/codex-implementer.md .opencode/agents/codex-implementer.md tests/runtime/isolated-scripts.test.ts tests/codex-lifecycle.test.sh tests/lane-contract.test.mjs
```

Expected: both commands exit 0. Do not commit without explicit user authorization.

---

### Task 4: Generated Runtime, Dogfood Record, And Full Verification

**Files:**
- Modify: `runtime/server.mjs` through the build script only
- Modify: `CHANGELOG.md`
- Modify: `scratchpad.md`
- Verify: every file changed by Tasks 1-3 plus the design and plan documents

**Interfaces:**
- Consumes: all completed source/schema/script changes.
- Produces: reproducible packaged runtime, release-visible notes, durable regressions, and final evidence.

- [ ] **Step 1: Record the user-visible fixes under Unreleased**

Add concise entries under `## [Unreleased]`:

```markdown
### Fixed

- The delegate skill now matches the closed Delegation Spec schema, documents exact command/network/timeout and Producer override fields, supports reviewer-only `review.focus`, and explains the clean-checkout precondition.
- Repository preflight now accepts tracked symlinks to contained regular files while continuing to reject directory, external, broken, untracked, and Git-metadata links in write scope.
- The legacy Codex wrapper now owns read-only versus edit sandbox selection and physical cwd binding, so implementation lanes receive `workspace-write` without permitting caller scope overrides.
```

- [ ] **Step 2: Append dogfood regression descriptions**

Append a new heading and these regression requirements to `scratchpad.md`:

```markdown
## Dogfood regressions - 2026-07-17 (v0.18.0 delegate lifecycle report)

- Delegation Spec prose must be tested against the closed schema: `args`, `network: denied|allowed`, both timeout ceilings, string Producer preferences, `producerOverrides`, and reviewer focus must remain executable examples.
- Clean-checkout failures must name tracked planning files and the delegate skill must require committing them; no skip-worktree workaround is permitted.
- A tracked package-file symlink to a contained repository file must pass preflight in primary and linked worktrees, while external, directory, broken, ignored, and `.git` targets remain rejected.
- The legacy Codex implementer command must execute through a wrapper-owned `workspace-write` mode; fake argv tests must fail if the wrapper reverts to an implicit read-only sandbox or accepts raw sandbox/cwd overrides.
```

- [ ] **Step 3: Regenerate the packaged runtime**

Run:

```bash
bash scripts/build-runtime.sh
```

Expected stderr: `built runtime/server.mjs`. Do not edit the generated file manually.

- [ ] **Step 4: Run focused regression gates together**

Run:

```bash
npx vitest run tests/runtime/spec-validator-review.test.ts tests/runtime/role-prompts.test.ts tests/runtime/repo-preconditions.test.ts tests/runtime/isolated-scripts.test.ts tests/runtime/attempt-runtime.test.ts tests/runtime/controlled-integrator.test.ts tests/runtime/structural-verifier.test.ts
node tests/delegate-routing.test.mjs
node tests/lane-contract.test.mjs
bash tests/codex-lifecycle.test.sh
```

Expected: every command exits 0.

- [ ] **Step 5: Run TypeScript and the full Vitest suite**

Run:

```bash
npx tsc --noEmit
npx vitest run
```

Expected: TypeScript exits 0 and every Vitest file passes with no unhandled errors.

- [ ] **Step 6: Attempt the canonical release validator**

Run:

```bash
bash scripts/validate-release.sh
```

Expected in an uncommitted implementation worktree: the deterministic rebuild succeeds, then the script reports `runtime artifacts differ from the committed release state.` because the regenerated bundle is intentionally uncommitted. If the user has explicitly authorized and requested a commit before this step, expected result is full exit 0 instead.

- [ ] **Step 7: Run the release-only gates that follow the committed-artifact guard**

When Step 6 stops at the intentional uncommitted-bundle guard, run the remaining commands directly:

```bash
claude plugin validate --strict .
node tests/plugin-manifest.test.mjs
npx vitest run tests/runtime/plugin-wiring.test.mjs
node tests/delegate-routing.test.mjs
bash tests/codex-lifecycle.test.sh
bash tests/validate-release.test.sh
bash tests/run-isolated.test.sh
bash tests/lane-launchers.test.sh
bash tests/install-opencode.test.sh
bash tests/claude-runtime-resolver.test.sh
node tests/lane-contract.test.mjs
node tests/lane-model-fallback.test.mjs
node tests/lane-roster.test.mjs
```

Expected: every command exits 0. Report the canonical validator's committed-artifact limitation separately rather than claiming it passed.

- [ ] **Step 8: Verify generated-byte stability without changing source**

Run:

```bash
SNAPSHOT=$(mktemp "${TMPDIR:-/tmp}/claude-architect-server.XXXXXX.mjs")
cp runtime/server.mjs "$SNAPSHOT"
bash scripts/build-runtime.sh
cmp "$SNAPSHOT" runtime/server.mjs
rm "$SNAPSHOT"
```

Expected: `cmp` exits 0, proving the checked working-tree bundle is reproducible. The temporary file is outside the repository.

- [ ] **Step 9: Inspect final status and complete diff**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff -- runtime/schemas/delegation-spec.v1.json src/protocol/delegation-spec.ts src/pipeline/role-prompts.ts src/git/repo-preconditions.ts scripts/run-codex-isolated.sh skills/delegate/SKILL.md agents/codex-implementer.md .opencode/agents/codex-implementer.md CHANGELOG.md scratchpad.md
```

Expected: only planned files are changed, `git diff --check` exits 0, and no unrelated user changes are altered.

- [ ] **Step 10: Perform final trust-boundary review**

Confirm each statement against the final bytes and test output:

```text
review.focus is optional, schema-valid, and reviewer-only.
The skill uses args, exact network values, both timeout ranges, string preferences, and producerOverrides.
Dirty checkout remains exact and documented.
Safe symlinks are tracked, contained regular files outside .git and are never traversed.
Unsafe or ambiguous symlinks still fail closed.
Legacy edit mode is wrapper-owned; default remains read-only.
Raw sandbox, cwd, additional-directory, approval, and unsafe config overrides remain denied.
runtime/server.mjs is regenerated and byte-stable.
No version surface changed and no commit was created without authorization.
```

Expected: every statement is true. Any mismatch returns to the owning task before completion is reported.
