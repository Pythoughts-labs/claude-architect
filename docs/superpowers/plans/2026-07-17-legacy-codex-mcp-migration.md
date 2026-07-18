# Legacy Codex MCP migration implementation plan

> **Execution note:** Implement this plan in an isolated worktree with
> `using-git-worktrees`, follow `test-driven-development` for every behavior
> change, and run `verification-before-completion` before reporting success.
> Do not commit, publish, tag, or integrate without separate human approval.

**Goal:** Retire the Codex shell edit route after Claude Code and an external,
project-bound OpenCode profile use the existing MCP runtime through tested,
fail-closed interfaces.

**Architecture:** Keep the existing runtime and protocol unchanged. Add a deep
`src/opencode-profile/` module that owns profile identity, immutable rendering,
installation/recovery, process supervision, launcher validation, and the stdio
allowlist gateway. Package two generated Node entrypoints: a fixed profile CLI
and a gateway in front of `runtime/bootstrap.mjs`. `scripts/install-opencode.sh`
becomes a bounded router/bootstrap; it does not implement security policy in
Bash. Claude Code retains decision and integration authority. OpenCode ends at
a reviewed candidate whose status is `pending-human-decision`.

**Tech stack:** TypeScript 5.9, Node.js 22+, Vitest, esbuild, MCP JSON-RPC over
stdio, existing platform/process services, existing hardened Git runner, and
small POSIX bootstrap scripts. The profile is supported on macOS and Linux.
Windows must return a stable unavailable result before mutation.

## Fixed constraints

- Do not change `AttemptRuntime`, runtime recovery, pipeline behavior,
  verification semantics, protocol schemas, capability policy, model
  attestation, Producer certification, or confinement policy.
- Do not install a new `.opencode` directory, project ignore rule, Git config,
  index entry, hook, or other repository metadata.
- Do not add an OpenCode decision, integration, manual patch application, or
  cross-Host handoff path.
- Do not treat OpenCode config permissions as the sole authority boundary. The
  fixed launcher, isolated environment, effective-agent check, and MCP gateway
  are independent gates.
- Do not pass command strings to a shell. Resolve executables and pass argv
  arrays through existing platform services.
- Do not recursively delete project or profile paths. Every destructive action
  requires a checked regular-file/directory identity and exact ownership hash.
- Do not silently broaden the OpenCode compatibility range. The initial exact
  supported version is `1.18.3`.
- Do not remove the legacy shell route until its replacement lifecycle,
  upgrade, retirement, and generated-asset gates all pass.

## Stable public behavior

The installed launcher accepts only:

```text
launcher.mjs auth
launcher.mjs doctor
launcher.mjs run --model <provider/model> [--variant <value>]
launcher.mjs review --run-id <id>
```

`run` reads a bounded task from stdin. No operation accepts an arbitrary cwd,
agent, config, permission, plugin, command, attach/server, sharing, `--auto`, or
raw OpenCode argument.

The gateway exposes exactly:

```text
delegate
delegatePipeline
reviewCandidate
doctor
gitStatus
gitDiff
gitLog
gitChangedFiles
```

The generated OpenCode Build agent receives only repository read/search tools
and these eight MCP tools. Its successful final response must include the run
id, candidate manifest hash, independent review findings, the literal status
`pending-human-decision`, and a statement that no decision or integration was
performed.

## Implementation file map

### Add

- `src/opencode-profile/contracts.ts`: versioned records, limits, allowlists,
  parsers, and stable unavailable classifications.
- `src/opencode-profile/fs-policy.ts`: no-follow identity, containment,
  canonical JSON/hash, durable atomic file, and directory policy.
- `src/opencode-profile/locks.ts`: hard-link lock acquisition, owner liveness,
  quarantine, release, and stale-owner policy.
- `src/opencode-profile/process.ts`: bounded executable probes and supervised
  child processes for launcher and gateway use.
- `src/opencode-profile/legacy-inventory.ts`: checked legacy ownership inventory
  parser and exact cleanup classification.
- `src/opencode-profile/gateway.ts`: bidirectional bounded JSON-RPC filter and
  child lifecycle.
- `src/opencode-profile/profile-manager.ts`: project binding, render, immutable
  release hashing, install/upgrade transaction, and recovery.
- `src/opencode-profile/doctor.ts`: immutable/effective-profile checks with no
  model invocation.
- `src/opencode-profile/launcher.ts`: fixed `auth`, `doctor`, `run`, and `review`
  command implementation.
- `src/opencode-profile/gateway-entry.ts`: generated gateway entrypoint.
- `src/opencode-profile/cli-entry.ts`: generated installer/launcher entrypoint.
- `profiles/opencode/compatibility.v1.json`: exact platform, Node, OpenCode,
  environment, and recognized metadata policy.
- `profiles/opencode/legacy-assets.v1.json`: release-owned path/hash/mode
  inventory for supported project installs.
- `profiles/opencode/BUILD_PROMPT.md`: pending-only OpenCode compatibility Host
  instructions.
- `scripts/generate-opencode-legacy-inventory.mjs`: maintainer-only inventory
  generator from supported release tags.
- `tests/opencode-profile/contracts.test.ts`
- `tests/opencode-profile/fs-policy.test.ts`
- `tests/opencode-profile/locks.test.ts`
- `tests/opencode-profile/process.test.ts`
- `tests/opencode-profile/legacy-inventory.test.ts`
- `tests/opencode-profile/gateway.test.ts`
- `tests/opencode-profile/profile-manager.test.ts`
- `tests/opencode-profile/doctor.test.ts`
- `tests/opencode-profile/launcher.test.ts`
- `tests/opencode-profile/host-contract.test.ts`
- `tests/opencode-profile/lifecycle.test.ts`
- `tests/opencode-profile/retirement.test.ts`

### Modify

- `esbuild.config.mjs`: reproducibly generate the server, profile CLI, and
  gateway bundles.
- `package.json`: add generated-asset and narrow profile test commands only if
  they remove repeated command text.
- `scripts/install-opencode.sh`: route `--project` to the generated profile CLI;
  retain the separately scoped global Pi/Pythinker installation behavior.
- `scripts/validate-release.sh`: require profile manifests, regenerated bytes,
  exact compatibility, upgrade, Host, lifecycle, and retirement gates.
- `.opencode/agents/codex-implementer.md`: replace executable instructions with
  a read-only external-profile migration notice.
- `agents/codex-implementer.md`: replace executable instructions with a
  read-only Claude MCP migration notice.
- `skills/delegate/SKILL.md`: remove shell fallback and distinguish Claude's
  complete lifecycle from OpenCode's pending-only compatibility lifecycle.
- `.claude-plugin/plugin.json`: remove retired shell assets from packaging only
  after replacement gates pass.
- `README.md`, `SECURITY.md`, `PRIVACY.md`, `CHANGELOG.md`, and active
  installation/troubleshooting docs: document profile location, credential and
  retention boundaries, supported commands/version/platforms, cleanup, and
  limitations.
- `tests/codex-lifecycle.test.sh`: preserve characterization until retirement,
  then replace shell assertions with tombstone/no-fallback assertions.
- `tests/lane-contract.test.mjs`: remove Codex edit-lane expectations only after
  replacement lifecycle tests pass; keep unrelated lane coverage.
- `tests/runtime/isolated-scripts.test.ts`: remove retired Codex script cases
  only after profile process/isolation tests cover the same failure classes.

### Generate

- `runtime/opencode-profile-cli.mjs`
- `runtime/opencode-mcp-gateway.mjs`
- Existing `runtime/server.mjs` remains reproducibly generated.

### Delete last

- `scripts/run-codex-isolated.sh`

Do not delete either `codex-implementer.md` filename in this release. Both are
compatibility tombstones for one minor-version window.

## Task 1: Freeze current shell characterization

**Files:**

- Verify: `tests/codex-lifecycle.test.sh`
- Verify: `tests/lane-contract.test.mjs`
- Verify: `tests/runtime/isolated-scripts.test.ts`
- Modify only if missing: the same test files

1. Run the current characterization before production edits:

   ```bash
   bash tests/codex-lifecycle.test.sh
   node tests/lane-contract.test.mjs
   npx vitest run tests/runtime/isolated-scripts.test.ts
   ```

2. Confirm the tests assert the current `--lane-mode edit` contract, hidden
   option rejection, cleanup, timeout, and nested-delegation behavior. Do not
   add a RED test for the historical raw `--sandbox`/`--cd` exit-65 command.

3. If a characterization is absent, add the smallest assertion against current
   green behavior and rerun the exact command. Do not change implementation in
   this task.

4. Record the passing commands in the eventual change summary. Their purpose is
   deletion safety, not evidence that the replacement already works.

## Task 2: Define profile contracts and fail-closed parsers

**Files:**

- Create: `src/opencode-profile/contracts.ts`
- Create: `profiles/opencode/compatibility.v1.json`
- Create: `tests/opencode-profile/contracts.test.ts`

1. Write failing table tests for:

   - Exact profile/manifest/journal/inventory format versions.
   - Exact OpenCode version `1.18.3` and Node major `>=22`.
   - macOS/Linux support and deterministic Windows `unsupported-platform`.
   - Exact launcher command grammar and rejection of unknown/repeated/options
     with missing values.
   - Bounded task, run id, model, variant, JSON line, stderr, queue, pending
     request, manifest, journal, and executable-probe sizes.
   - Exact eight-tool allowlist and exact repository-taking subset.
   - Unknown object keys, invalid paths, control characters, malformed hashes,
     and unsupported record versions failing closed.
   - Stable redacted classifications such as `unsupported-platform`,
     `unsupported-opencode`, `invalid-profile`, `identity-mismatch`,
     `dirty-checkout`, `gateway-unavailable`, and `recovery-required`.

2. Run the test and confirm the missing module/contracts are RED:

   ```bash
   npx vitest run tests/opencode-profile/contracts.test.ts
   ```

3. Implement constants, discriminated TypeScript types, and strict parsers. Use
   one canonical error envelope:

   ```ts
   interface ProfileUnavailable {
     status: "unavailable";
     classification: ProfileUnavailableClassification;
     message: string;
   }
   ```

   Keep diagnostics actionable but never include prompts, credentials, provider
   environment, arbitrary argv, or unbounded child output.

4. Make `compatibility.v1.json` the checked data source for exact versions,
   supported platforms, required disable flags, recognized mutable config
   metadata names, and all byte/count limits. Parse it strictly at startup.

5. Rerun the narrow test and type-check:

   ```bash
   npx vitest run tests/opencode-profile/contracts.test.ts
   npx tsc --noEmit
   ```

## Task 3: Implement no-follow identity and durable filesystem policy

**Files:**

- Create: `src/opencode-profile/fs-policy.ts`
- Create: `tests/opencode-profile/fs-policy.test.ts`

1. Write failing tests for:

   - Canonical worktree and Git common-directory tuples producing a stable
     versioned SHA-256 project key.
   - Recorded no-follow identities detecting a replaced root at the same path.
   - Symlinked ancestors, leaves, hard-linked protected regular files, special
     files, owner/mode drift, and repository/profile escapes being rejected.
   - Canonical JSON sorting and byte-identical hashes across runs.
   - Same-directory temp creation with restrictive mode, file fsync, atomic
     rename/link, parent fsync, and identity revalidation.
   - Existing destination reuse only when byte hash, mode, identity, and owning
     manifest all match.
   - New-install helpers leaving every project and Git byte unchanged.

2. Run the test and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/fs-policy.test.ts
   ```

3. Implement a small no-follow API rather than ad hoc `stat`/`realpath` calls in
   later modules. It must return typed identities containing canonical path,
   device/inode where supported, type, mode, uid where supported, and size.

4. Implement canonical serialization and SHA-256 helpers with domain/version
   prefixes. Never hash JSON produced from insertion-order-dependent objects.

5. Implement durable atomic regular-file creation/replacement and checked empty
   directory removal. Do not expose a recursive delete helper.

6. Rerun:

   ```bash
   npx vitest run tests/opencode-profile/fs-policy.test.ts
   npx tsc --noEmit
   ```

## Task 4: Reuse hardened Git and build the legacy ownership inventory

**Files:**

- Modify only if needed: `src/git/git-exec.ts`
- Create: `src/opencode-profile/legacy-inventory.ts`
- Create: `profiles/opencode/legacy-assets.v1.json`
- Create: `scripts/generate-opencode-legacy-inventory.mjs`
- Create: `tests/opencode-profile/legacy-inventory.test.ts`
- Modify: `scripts/validate-release.sh`

1. Write failing tests proving project inspection uses the existing `git()`
   executable-plus-argv path and neutralizes inherited `GIT_*`, global/system
   config, hooks, fsmonitor, attributes, external diff/textconv, and filters.
   Add no second, weaker Git runner.

2. Write failing inventory tests for tags `v0.15.0` through `v0.19.0` covering
   every destination installed by each tag's project-mode installer. For each
   tag/path, record exact content hash, executable/non-executable mode, and
   owned empty parent directories.

3. Add adversarial classification tests:

   - Exact untracked path/hash/mode is removable.
   - Tracked, ignored-user-owned, modified, unknown, symlinked, hard-linked,
     special, missing-parent, and identity-raced paths are preserved conflicts.
   - An unrelated dirty path blocks activation.
   - Cleanup returns an explicit itemized plan before mutating anything.

4. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/legacy-inventory.test.ts
   ```

5. Implement the strict inventory parser and classifier. The production module
   consumes checked JSON; it never runs `git show` at install time.

6. Implement the maintainer generator using `git show <tag>:<path>` through
   executable-plus-argv with bounded output. Require an explicit tag allowlist,
   deterministic ordering, and a clean diff after regeneration.

7. Add a release-validation step that regenerates from the required tags and
   fails on drift. If release validation runs in a tagless source archive, fail
   with an actionable prerequisite rather than trusting stale ownership data.

8. Rerun the narrow test and inventory generation twice, asserting the second
   run has no diff:

   ```bash
   node scripts/generate-opencode-legacy-inventory.mjs
   npx vitest run tests/opencode-profile/legacy-inventory.test.ts
   git diff --exit-code -- profiles/opencode/legacy-assets.v1.json
   ```

## Task 5: Add locks and bounded process supervision

**Files:**

- Create: `src/opencode-profile/locks.ts`
- Create: `src/opencode-profile/process.ts`
- Create: `tests/opencode-profile/locks.test.ts`
- Create: `tests/opencode-profile/process.test.ts`

1. Write failing lock tests for:

   - A complete owner record being fsynced before atomic hard-link acquisition.
   - One winner under concurrent acquisition.
   - Live owner, ambiguous liveness, PID reuse, dead owner, inode race, corrupt
     owner, symlink, and special-file behavior.
   - Dead-owner quarantine only after process start-token and inode
     revalidation; the installer never signals a stale owner.
   - Release removing only the exact lock inode owned by the caller.

2. Write failing process tests for:

   - Executable resolution and identity/version probes with argv arrays.
   - Exact OpenCode `1.18.3`, Node 22+, bounded stdout/stderr, timeout,
     cancellation, process-tree escalation, early error, and no orphan.
   - Environment construction from an allowlist rather than `process.env`
     spread.
   - Removal of OpenCode overrides, provider secrets, delegation markers, user
     config/plugin/skill paths, shell startup variables, and unrelated
     credential variables.
   - Terminal/browser essentials passed only to `auth`; model `run` receives the
     smaller fixed environment.

3. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/locks.test.ts tests/opencode-profile/process.test.ts
   ```

4. Implement the lock protocol using `fs.link`, no-follow identities, bounded
   canonical owner records, PID/start-token liveness, and directory fsync.

5. Implement process helpers by composing existing `PlatformServices` and
   `supervise`. Do not duplicate process-tree logic or add shell interpolation.

6. Rerun the narrow tests and type-check.

## Task 6: Build the bidirectional stdio allowlist gateway

**Files:**

- Create: `src/opencode-profile/gateway.ts`
- Create: `src/opencode-profile/gateway-entry.ts`
- Create: `tests/opencode-profile/gateway.test.ts`

1. Build a fake child MCP server fixture in the test itself. Write failing tests
   for initialize, requests, responses, notifications, error objects, string and
   numeric ids, progress tokens, and both traffic directions.

2. Add failing authority tests:

   - Every `tools/list` result is reduced to the exact eight names.
   - `decideCandidate`, `integrateCandidate`, unknown future tools, malformed
     names, and non-tool methods that try to smuggle a call are denied before
     child forwarding.
   - Repository-taking calls require the exact canonical bound checkout in the
     expected argument field; omitted, relative, alternate-spelling, sibling,
     symlink, and second-worktree paths fail closed.
   - Allowed payloads pass through structurally unchanged.

3. Add failing protocol/lifecycle tests:

   - Parent-to-child and child-to-parent pending-id maps are independent.
   - The same id may be outstanding once in each direction, but duplicate ids
     within one direction fail.
   - Only the response matching the gateway's tracked `tools/list` request is
     filtered.
   - Oversized lines, malformed JSON, invalid JSON-RPC shape, queue flood,
     pending-request flood, stderr flood, blocked writers, write errors, early
     child exit, timeout, cancellation, and ambiguous shutdown fail closed.
   - Backpressure pauses and resumes the correct source stream.
   - Stdout contains protocol only; bounded redacted diagnostics use stderr.
   - Shutdown forwards termination, escalates after the existing grace, and
     waits for child exit with no orphan.

4. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/gateway.test.ts
   ```

5. Implement a line-framed JSON-RPC state machine. Keep policy tables immutable
   and sourced from `contracts.ts`. Spawn only the release-local sibling
   `runtime/bootstrap.mjs`; set `CLAUDE_ARCHITECT_STATE_DIR` to the profile's
   `architect-data`, pass the separately validated Producer home required by the
   selected adapter, and remove `CLAUDE_ARCHITECT_DELEGATED`.

6. Do not reinterpret runtime success/error payloads or synthesize Candidate
   Artifacts. The gateway filters exposure only.

7. Rerun the narrow tests, type-check, and inspect the gateway output for any
   accidental non-protocol stdout.

## Task 7: Render a reproducible immutable profile release

**Files:**

- Create: `profiles/opencode/BUILD_PROMPT.md`
- Create: `src/opencode-profile/profile-manager.ts`
- Create: `tests/opencode-profile/profile-manager.test.ts`
- Modify: `esbuild.config.mjs`
- Generate: `runtime/opencode-profile-cli.mjs`
- Generate: `runtime/opencode-mcp-gateway.mjs`

1. Write failing renderer tests for the exact release closure:

   - Profile CLI and gateway bundles.
   - `runtime/bootstrap.mjs`, `runtime/server.mjs`, `runtime/watchdog.mjs`, and
     physical runtime schema files required by role prompts.
   - Generated `opencode.jsonc`, Build prompt, compatibility manifest, legacy
     inventory, release manifest, and modes.

2. Write failing non-circular hash tests:

   - Tokenized canonical deployment body produces `deploymentHash`.
   - Final release path is rendered only after that hash exists.
   - Canonical install-manifest body produces `installManifestHash` before only
     its own field is added.
   - Re-rendering is byte-identical; changing any policy, static byte, mode,
     binding, executable identity, or prompt changes the appropriate hash.
   - An existing immutable release is reused only on complete exact equality
     and is never updated in place.

3. Write failing generated-config tests. The JSONC must contain:

   - A single local MCP command targeting the release gateway with fixed bound
     project/profile arguments.
   - Global default deny and explicit Build allows only for read, glob, grep,
     and the eight namespaced gateway tools.
   - Explicit denies for shell, edit, write, patch, task, web, skill,
     external-directory access, decision, integration, and wildcard future MCP
     tools.
   - Empty plugin/instruction inputs and no external command/tool directories.
   - The generated pending-only Build prompt.

4. Write prompt contract tests proving it requires a canonical version-1
   Delegation Spec, foregrounded terminal result, independent review, exact
   evidence, pending-only final status, and no shell fallback, decision,
   integration, handoff, or manual patch application.

5. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/profile-manager.test.ts
   ```

6. Implement the pure renderer before installation logic. Keep deployment
   templates literal and substitute only validated values. The active
   `opencode-config/` is mutable only for OpenCode-generated metadata; the
   release stores and hashes the expected protected `opencode.jsonc` bytes.

7. Extend `esbuild.config.mjs` with shared Node 22 ESM build settings and
   separate explicit output files. Preserve the existing CommonJS dependency
   shim and generated-file banner on every bundle.

8. Generate twice and prove no drift:

   ```bash
   npm run build
   npx vitest run tests/opencode-profile/profile-manager.test.ts
   git diff --exit-code -- runtime/server.mjs runtime/opencode-profile-cli.mjs runtime/opencode-mcp-gateway.mjs
   ```

## Task 8: Implement transactional install, legacy upgrade, and recovery

**Files:**

- Modify: `src/opencode-profile/profile-manager.ts`
- Create or extend: `tests/opencode-profile/profile-manager.test.ts`
- Modify: `scripts/install-opencode.sh`

1. Write failing new-install tests that snapshot the project tree, `.git`
   metadata, status, index hash, config, refs, and HEAD before and after install.
   Require exact equality and assert all new bytes are under the external
   profile root with restrictive modes.

2. Write failing upgrade tests for every inventoried release shape. Require:

   - Read-only preflight before lock/mutation.
   - Exact release-owned untracked files backed up externally and removed.
   - Only checked empty plugin-owned directories removed.
   - Unknown, modified, tracked, ignored-user-owned, symlinked, hard-linked,
     special, or identity-raced paths preserved and reported as conflicts.
   - An unrelated dirty path blocks activation.
   - No local exclude, Git config, index, ref, or HEAD mutation.

3. Add a failpoint after every durable transition in the approved ten-step
   transaction. For each failpoint, restart recovery and assert one of two
   complete outcomes only:

   - Previous current pointer plus exact restored legacy bytes/modes.
   - New validated current pointer plus clean project and no executable old
     route.

   Contradictory journal, backup, inode, hash, pointer, or stage evidence must
   return `recovery-required` without guessing or deleting.

4. Add concurrent installer tests proving one lock winner, no mixed release,
   no partial active config, no lost backup, and rerunnable exact success.

5. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/profile-manager.test.ts
   ```

6. Implement the default root and binding exactly as designed:

   ```text
   ${XDG_DATA_HOME:-$HOME/.local/share}/claude-architect/opencode-profiles/<project-key>/
   ```

   Record canonical worktree root, canonical Git common directory, no-follow
   root identities, separately validated canonical Producer credential home,
   executable identities, and both release hashes. Never copy credentials.

7. Implement the journaled transaction in the approved order. `current.json`
   is the last activation write. Use external backups for legacy bytes and
   restore exact bytes/modes on ordinary failure. Recovery must validate before
   completing or restoring.

8. Replace the Bash project installer body with a bounded Node bootstrap that
   resolves the checked generated CLI and invokes:

   ```text
   node runtime/opencode-profile-cli.mjs install --project <root>
   ```

   Preserve the existing public `scripts/install-opencode.sh --project <root>`
   syntax. Do not allow raw forwarded arguments. Keep `--global` behavior
   separately scoped until its Pi/Pythinker migration is designed.

9. Rerun the narrow tests plus a real temporary Git worktree integration test.

## Task 9: Implement doctor and the fixed launcher

**Files:**

- Create: `src/opencode-profile/doctor.ts`
- Create: `src/opencode-profile/launcher.ts`
- Create: `src/opencode-profile/cli-entry.ts`
- Create: `tests/opencode-profile/doctor.test.ts`
- Create: `tests/opencode-profile/launcher.test.ts`

1. Write failing doctor tests using a fake OpenCode executable that records
   argv/env/cwd without starting a model. Doctor must validate before success:

   - Stable launcher, `current.json`, release manifest, deployment hash, every
     immutable byte/mode, protected active config hash, and recognized mutable
     config metadata only.
   - Bound project/Git paths and identities, HEAD, exact clean status, profile
     roots, lock/journal state, Node identity/version, and exact OpenCode
     identity/version.
   - Required disable flags and absence of inherited config/plugin/skill,
     provider-secret, credential, shell, and delegation variables.
   - `opencode debug config --pure`, `opencode debug agent build --pure`, MCP
     connection/list, and a direct `doctor` tool call.
   - Exact effective Build read/search plus eight-MCP tool set, with every
     mutation/process/external/future-MCP capability denied.

2. Add malicious discovery sentinels in the project and fake user global roots:
   `.opencode` config/custom tools/plugins/agents/skills/commands, root OpenCode
   config, `AGENTS.md`, `CLAUDE.md`, external skills, default plugins, provider
   config, and credentials. Each sentinel attempts to write a marker. Doctor
   and run must neither load nor execute any sentinel.

3. Write failing mutable-config tests. Allow only the protected
   `opencode.jsonc` plus exact compatibility-manifest-recognized OpenCode package
   metadata. Reject changed JSONC, unknown files, executable content,
   instructions, tool/plugin/agent/skill/command directories, symlinks, special
   files, owner/mode drift, and dependency metadata outside the allowed shape.

4. Write failing launcher grammar/argv tests:

   - `auth` invokes only profile-scoped `opencode auth login` with bounded
     terminal/browser essentials and writes credentials only under
     `opencode-data`.
   - `doctor` never invokes a model or Producer.
   - `run` first performs all doctor checks, then invokes fixed `opencode run`
     with `--pure`, fixed `--agent build`, fixed canonical `--dir`, explicit
     validated model/optional variant, bounded stdin, and no `--auto`.
   - `review` performs all doctor checks and invokes the exact debug-agent tool
     interface for `reviewCandidate` with a validated run id and no model.
   - Unknown/reordered/repeated flags, raw argv, stdin overflow, unsupported
     platform/version, dirty project, profile drift, and child failure return a
     stable unavailable envelope and start no model/Producer.
   - One Host lock serializes `auth`, `doctor`, `run`, and `review`.

5. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/doctor.test.ts tests/opencode-profile/launcher.test.ts
   ```

6. Implement doctor as explicit checks with bounded evidence. Do not infer
   safety from exit code alone; parse and compare effective config/agent/tool
   output against the exact expected set.

7. Implement launcher dispatch with no extension hook and no raw argument
   forwarding. Revalidate the profile and clean checkout on every operation,
   including after acquiring the Host lock and immediately before model start.

8. Return the launcher's stable path from installation and print exact usage,
   profile location, bound project, OpenCode version, and separate-auth next
   step. Do not print credentials or sensitive environment values.

9. Rerun the narrow tests and generated build.

## Task 10: Migrate Host prompts without enabling acceptance

**Files:**

- Modify: `.opencode/agents/codex-implementer.md`
- Modify: `agents/codex-implementer.md`
- Modify: `skills/delegate/SKILL.md`
- Create: `tests/opencode-profile/host-contract.test.ts`

1. Write failing static/contract tests proving:

   - Neither active agent invokes `run-codex-isolated.sh`, raw Codex, manual
     worktree lifecycle, manual patch application, or shell fallback.
   - Claude's tombstone directs users to
     `/claude-architect:delegate` and does not change the existing complete MCP
     lifecycle or tool namespace.
   - OpenCode's tombstone directs users to the printed external launcher and
     says candidates remain pending and cannot be accepted/integrated there.
   - `skills/delegate/SKILL.md` distinguishes Claude's complete lifecycle from
     OpenCode's compatibility lifecycle and never claims OpenCode Host
     certification.
   - Runtime blockers produce unavailable/failure guidance, not fallback.

2. Run and confirm RED:

   ```bash
   npx vitest run tests/opencode-profile/host-contract.test.ts
   ```

3. Replace both long executable Codex agent bodies with concise read-only
   migration notices. Preserve filenames for the compatibility window.

4. Update the skill's active route. Keep all existing Delegation Spec,
   independent review, human decision, and exact-hash Controlled Integration
   requirements for Claude Code. Add the bounded OpenCode flow only as a
   separate pending-only section.

5. Rerun the test and validate the plugin:

   ```bash
   npx vitest run tests/opencode-profile/host-contract.test.ts
   claude plugin validate .
   ```

## Task 11: Prove installed lifecycle, concurrency, and no mutation

**Files:**

- Create: `tests/opencode-profile/lifecycle.test.ts`
- Extend: profile fake executable fixtures within the test directory

1. Build the real generated profile CLI and gateway. Install into a temporary
   external profile for a temporary clean Git project. Use fake OpenCode and
   fake Codex executables, but use the real launcher, profile renderer, gateway,
   `runtime/bootstrap.mjs`, bundled server, runtime, worktree creation,
   verification, archive, and cleanup.

2. Add the successful compatibility flow:

   - Install with zero new project/Git bytes.
   - Authenticate only under profile data.
   - Doctor with no model.
   - Run a canonical edit Delegation Spec through `delegatePipeline`.
   - Keep the call foregrounded to terminal result.
   - Review the frozen candidate through `reviewCandidate`.
   - Report exact run id, manifest hash, findings, and
     `pending-human-decision`.
   - Confirm no decision record, integration, main-checkout edit, or manual
     patch application.

3. Add two simultaneous sentinel attempts with distinct prompts and edits.
   Assert they cannot exchange prompts, ids, progress, worktrees, logs,
   archives, patches, candidates, stderr, or final reports. Runtime locks may
   serialize repository operations, but Host/profile streams must remain
   isolated.

4. Add fail-closed lifecycle cases:

   - Zero edit and edit success.
   - Timeout before edit and timeout after edit.
   - Cancellation and process-tree cleanup.
   - Dirty checkout and stale base.
   - Invalid protocol and oversized gateway data.
   - Missing/tampered runtime or profile bytes.
   - Nested delegation marker.
   - Unsupported platform/OpenCode/Node.
   - Ineligible confinement.
   - Producer self-report contradicting frozen artifact.
   - Forbidden decision/integration and alternate checkout calls.

5. Snapshot the main project and Git metadata around every case. A failure may
   leave durable redacted profile evidence, but never a project edit, partial
   active release, accepted status, or shell fallback.

6. Run:

   ```bash
   npm run build
   npx vitest run tests/opencode-profile/lifecycle.test.ts
   ```

7. Add opt-in real OpenCode `1.18.3` and real provider/Codex smoke tests only
   behind explicit environment gates. Record exact executable versions, model,
   platform, and confinement. A smoke pass does not expand certification.

## Task 12: Retire the shell route and enforce release gates

**Files:**

- Delete: `scripts/run-codex-isolated.sh`
- Modify: `scripts/install-opencode.sh`
- Modify: `.claude-plugin/plugin.json`
- Modify: `tests/codex-lifecycle.test.sh`
- Modify: `tests/lane-contract.test.mjs`
- Modify: `tests/runtime/isolated-scripts.test.ts`
- Create: `tests/opencode-profile/retirement.test.ts`
- Modify: `scripts/validate-release.sh`

1. First run Tasks 1 through 11 together. Do not begin deletion if any
   replacement gate is skipped, flaky, or failing.

2. Write a failing retirement test that searches active source, generated
   assets, manifests, installers, agents, skills, and docs for:

   - Executable references to `run-codex-isolated.sh`.
   - Active Codex shell fallback/resolver instructions.
   - Raw `codex exec` edit-lane construction outside the unchanged Codex
     Producer adapter.
   - OpenCode decision/integration or manual patch application claims.
   - Project-local Codex MCP installation.

   Permit only explicit historical/changelog text and compatibility tombstone
   filenames, not executable instructions.

3. Run and confirm RED while the wrapper still exists:

   ```bash
   npx vitest run tests/opencode-profile/retirement.test.ts
   ```

4. Delete `scripts/run-codex-isolated.sh`, remove it from every installer and
   package manifest, and replace obsolete shell tests only where the profile
   suite now proves the same property. Preserve unrelated isolation/lane tests.

5. Extend release validation to require, in order:

   - Clean generated profile/runtime assets.
   - Strict TypeScript.
   - Full Vitest and shell/contract suites.
   - Legacy inventory regeneration and supported-tag fixture coverage.
   - New install/upgrade/recovery gates.
   - Exact real OpenCode `1.18.3` Host gate where release infrastructure
     provides it; otherwise release validation fails rather than certifying an
     untested version.
   - Claude plugin validation.
   - Retirement scan.
   - Existing synchronized release-version surfaces.

6. Run the retirement and prior characterization suites. Update any test name
   that still describes the historical exit-65 command as current.

## Task 13: Update user-facing security, privacy, and operations documentation

**Files:**

- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `PRIVACY.md`
- Modify: active installation/troubleshooting documents found by search
- Modify: `CHANGELOG.md`

1. Add documentation contract assertions to
   `tests/opencode-profile/host-contract.test.ts` for all security-relevant
   claims before editing prose.

2. Document:

   - Exact install command and printed fixed launcher path.
   - `auth`, `doctor`, `run`, and `review` syntax.
   - macOS/Linux and exact OpenCode `1.18.3` support; Windows unavailable.
   - External profile/data/session/archive/worktree/lock/backup locations and
     cleanup procedure.
   - Separate OpenCode provider authentication and separately referenced
     Producer credential home; no credential copying.
   - The eight-tool allowlist, read/search capability, project/global discovery
     disablement, effective-agent validation, and no shell/edit tools.
   - Pending-only OpenCode candidates and the absence of decision, integration,
     handoff, or first-class Host certification.
   - Claude Code's unchanged complete lifecycle.
   - Legacy exact-hash cleanup, preservation conflicts, recovery behavior, and
     no new project writes.
   - Residual trust in the exact OpenCode binary and existing runtime gaps.

3. Remove active instructions for the retired shell route. Keep changelog
   history factual and clearly historical.

4. Update version surfaces only when the human selects the migration release
   version. Follow the repository's minor-only release rule; do not invent a
   version in implementation.

5. Run documentation/Host contracts and search for stale active instructions.

## Task 14: Full verification and independent acceptance review

**Files:** All changed and generated files.

1. Regenerate all assets and require no generated diff after the second build:

   ```bash
   npm run build
   npm run build
   git diff --exit-code -- runtime/server.mjs runtime/opencode-profile-cli.mjs runtime/opencode-mcp-gateway.mjs profiles/opencode/legacy-assets.v1.json
   ```

2. Run narrow profile suites first, then all repository gates:

   ```bash
   npx vitest run tests/opencode-profile
   npx tsc --noEmit
   npx vitest run
   bash tests/codex-lifecycle.test.sh
   node tests/lane-contract.test.mjs
   bash scripts/validate-release.sh
   claude plugin validate .
   ```

   If retirement intentionally removes a command, replace that command in this
   list with the new retirement/lifecycle command in the same change and state
   why. Do not silently skip it.

3. Run platform coverage on macOS and Linux. Run the Windows unavailable test
   in Windows CI and assert no mutation/process launch before the classification.

4. Inspect status and the complete diff. Every changed line must map to this
   plan. Preserve unrelated user changes and do not stage them.

5. Request two independent read-only reviews of the complete candidate bytes:

   - Security/trust-boundary review focused on profile escape, OpenCode
     discovery, permissions, gateway protocol, identity, credentials,
     installation, lock/recovery, cleanup, and no decision/integration.
   - Acceptance review focused on the design criteria, cross-platform behavior,
     generated assets, docs, and test evidence.

6. Fix every Critical and Important finding test-first. After any fix, rerun
   the affected narrow test and the complete gate set. Reviewers recommend;
   only the human may accept or integrate the resulting candidate.

## Final evidence checklist

- Current shell characterization was green before deletion.
- New install and every launcher operation leave project/Git bytes unchanged.
- Every supported legacy project asset has checked tag/path/hash/mode ownership
  evidence; unknown/user-owned paths are preserved conflicts.
- Immutable release hashing is reproducible and non-circular.
- Locking, activation, ordinary rollback, and crash recovery expose no partial
  executable profile after recovery.
- Malicious project/global OpenCode, Claude, and agent discovery sentinels never
  execute.
- Profile auth remains separate and no credentials or provider secrets appear
  in model tools, prompts, logs, manifests, or diagnostics.
- Effective Build capability is read/search plus exactly eight gateway tools.
- Gateway protocol, backpressure, limits, bound checkout, future-tool denial,
  and process cleanup pass adversarial tests.
- Installed lifecycle and concurrent isolation pass through the real generated
  launcher/gateway/runtime closure.
- OpenCode produces only reviewed `pending-human-decision` candidates and cannot
  decide, integrate, hand off, or manually apply them.
- Claude Code retains the unchanged complete MCP lifecycle.
- No supported path invokes the retired shell wrapper or falls back to it.
- TypeScript, full tests, generated assets, release validation, plugin
  validation, macOS/Linux gates, and Windows fail-closed coverage all pass.
