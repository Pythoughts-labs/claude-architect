# Legacy Codex MCP migration design

Date: 2026-07-17
Status: Approved direction, isolated OpenCode profile

## Decision

Retire the prose-driven Codex shell edit route after its structured replacement
is proven. Claude Code continues to use the packaged MCP server and retains the
complete delegation, review, human-decision, and Controlled Integration flow.

OpenCode does not receive project-root configuration. Instead,
`install-opencode.sh --project <root>` creates an external profile bound to the
canonical Git worktree and prints one fixed launcher path. The launcher starts
OpenCode with isolated HOME/XDG/config/data/cache/state roots, disables project
configuration and instruction discovery, disables external/Claude skills and
default plugins, validates the effective agent before every run, and allows no
caller-selected config, cwd, agent, permission, plugin, attach, or `--auto`
option.

The profile exposes the existing MCP runtime through a narrow stdio gateway.
OpenCode may use only:

- `delegate`
- `delegatePipeline`
- `reviewCandidate`
- `doctor`
- `gitStatus`
- `gitDiff`
- `gitLog`
- `gitChangedFiles`

It cannot discover or forward `decideCandidate`, `integrateCandidate`, or an
unknown future tool. OpenCode compatibility ends at a frozen, independently
verified and reviewed candidate. Acceptance and integration remain Claude
Code-only in this scope. A pending OpenCode candidate must not be manually
applied or described as accepted.

## Why project-local config was rejected

A managed `.opencode/opencode.jsonc` and permission rules are not an authority
boundary:

- `--pure` still allows discovered project custom tools to be imported.
- Project agents/config loaded after global rules can override permissions.
- `opencode run --auto` approves operations left at `ask`.
- The interactive "Allow always" choice persists an approval within the
  process and can affect later agents/sessions.
- An ordinary Build agent with process or edit tools can bypass a gateway by
  starting the installed unfiltered runtime, changing ignored config, or
  editing the checkout directly.

An MCP filter constrains only its connection. It is useful defense in depth but
cannot make an ordinary project OpenCode process pending-only. The fixed
external launcher removes project/global discovery and mutation/process tools
before the model starts, while the gateway independently limits the runtime
surface.

## Current evidence

The initial investigation found a composed command that failed before Codex
started because both legacy agents passed raw `--sandbox` and `--cd` options
that the wrapper rejected. That failure is historical at current `main`:
commits `2652ddf` and `d466f8e` moved those controls behind wrapper-owned
`--lane-mode edit` and tightened hidden-option rejection.

These checks now pass:

```text
bash tests/codex-lifecycle.test.sh
node tests/lane-contract.test.mjs
npx vitest run tests/runtime/isolated-scripts.test.ts
```

The repaired shell route remains migration debt:

- Agent prose owns prompt/final tempfiles, worktree selection, timeout
  coordination, diff collection, verification order, and cleanup.
- Claude Code and OpenCode duplicate a long behavioral contract instead of
  submitting one canonical Delegation Spec through an executable interface.
- Shell reports are not durable Attempt Results or Candidate Artifacts.
- A caller can still implement the lifecycle incorrectly even when individual
  fragments are tested.

Migration tests characterize the current `--lane-mode edit` route before
deleting it. They must not present the superseded exit-65 command as current
RED.

## Scope

This design changes legacy transport, OpenCode profile packaging, and Host
exposure only:

- Keep Claude Code Codex delegation on the existing MCP lifecycle.
- Build a complete immutable runtime/profile closure outside the repository.
- Add a fixed, project-bound OpenCode launcher with `auth`, `doctor`, `run`, and
  `review` operations only.
- Add a stdio allowlist gateway in front of the unchanged runtime.
- Give the OpenCode Build agent a generated prompt and a read/search plus MCP
  tool set; deny shell, edit, write, patch, task, web, skill, and external-path
  capabilities.
- Move OpenCode Codex delegation from shell agents to structured MCP calls.
- Remove release-owned legacy project-install files during upgrade without
  writing new project or Git metadata.
- Remove the Codex shell wrapper, active resolvers, and fallback behavior.
- Add profile, launcher, gateway, Host, lifecycle, upgrade, and retirement
  release gates.

## Non-goals

- No changes to `AttemptRuntime`, runtime recovery, pipeline behavior,
  verifier behavior, Candidate Artifact semantics, Host Decision, Controlled
  Integration, protocol schemas, capability policy, model attestation, or
  confinement behavior.
- No OpenCode decision or integration support.
- No cross-Host transfer of an OpenCode run into Claude Code state.
- No ordinary project-local or global Codex MCP configuration.
- No first-class OpenCode Host certification.
- No native Windows profile support in this change.
- No external OpenCode plugins or inherited provider/config environment in the
  initial profile. Users authenticate supported built-in providers separately
  through the profile launcher.
- No expansion of Producer, model, platform, or confinement certification.
- No implementation of unrelated runtime deadline, salvage, lease, recovery,
  reviewer-focus, or tracked-symlink proposals.

Known runtime gaps remain separate work and must not be described as fixed.

## Trust boundaries

### Existing runtime

`src/mcp/tools.ts`, `src/mcp/server.ts`, and `AttemptRuntime` remain the
lifecycle sources of truth. The runtime alone owns repository identity,
serialization, preconditions, Producer routing/confinement, attempt worktrees,
process supervision, candidate freeze/hash/archive, verification, cleanup,
decision records, and Controlled Integration.

The profile installer, launcher, prompt, and gateway do not reproduce those
steps or synthesize successful results.

### OpenCode process

OpenCode core is a compatibility Host, not a trusted acceptance authority. The
supported process can read/search the bound repository and call the eight
gateway tools. It cannot receive built-in shell/edit/write/patch/task/web/skill
or external-directory permissions. It cannot load project `.opencode`, root
OpenCode config, `AGENTS.md`, `CLAUDE.md`, project plugins/tools/agents/skills,
the user's global OpenCode/Claude/agent config, or inherited external skills.

The launcher sets and verifies at least:

```text
OPENCODE_DISABLE_PROJECT_CONFIG=1
OPENCODE_DISABLE_EXTERNAL_SKILLS=1
OPENCODE_DISABLE_CLAUDE_CODE=1
OPENCODE_DISABLE_DEFAULT_PLUGINS=1
OPENCODE_CONFIG_DIR=<profile-opencode-config>
HOME=<profile-home>
XDG_CONFIG_HOME=<profile-xdg-config>
XDG_DATA_HOME=<profile-xdg-data>
XDG_CACHE_HOME=<profile-xdg-cache>
XDG_STATE_HOME=<profile-xdg-state>
```

It passes `--pure`, a fixed `--agent build`, fixed canonical `--dir`, and no
`--auto`. It removes inherited `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`, plugin/config override flags,
delegation markers, provider secrets, and unrelated credential variables.

OpenCode provider credentials are created under the profile's XDG data root by
the launcher's bounded `auth` operation. They are never copied from the user's
normal OpenCode store. The selected Producer keeps its existing separately
validated credential source; for Codex the profile records a canonical
`CODEX_HOME` path without exposing its contents to OpenCode tools.

### Stdio allowlist gateway

The gateway is a trusted Host-exposure filter, not a second attempt runtime. It
spawns sibling `runtime/bootstrap.mjs` with executable-plus-argv and enforces a
fixed operation allowlist:

1. Reduce every successful `tools/list` response to the eight exact names.
2. Reject every inbound `tools/call` not in that allowlist before forwarding.
3. For repository-taking tools, require the exact profile-bound canonical
   checkout path in arguments.

Unknown future tools are denied by default. Separate parent-to-child and
child-to-parent pending-id maps distinguish requests/responses, allow the same
id once in each direction, reject duplicate outstanding ids per direction, and
identify only the matching `tools/list` response for filtering.

All other valid requests, responses, notifications, errors, ids, and progress
tokens pass through structurally unchanged. The gateway enforces bounded lines,
aggregate queued bytes, outstanding request counts, and stderr; honors stream
backpressure; keeps stdout protocol-only; forwards termination; escalates after
the existing bootstrap grace; and waits for child exit. Malformed protocol,
queue flood, write failure, child failure, or ambiguous shutdown fails closed.

### Fixed launcher

The launcher is the only supported OpenCode entry. It accepts:

- `auth`: run profile-scoped `opencode auth login` with bounded duration and
  inherited terminal/browser essentials only.
- `doctor`: no model; validate immutable bytes, environment, project identity,
  clean status, effective Build permissions/tool set, gateway connection, and
  a direct `doctor` tool call.
- `run --model <provider/model> [--variant <value>]`: read a bounded task from
  stdin and invoke `opencode run` with fixed profile flags.
- `review --run-id <id>`: call the allowlisted review tool through OpenCode's
  debug-agent tool interface without a model.

No operation accepts arbitrary OpenCode argv, cwd, config, agent, plugin,
permission, attach/server, sharing, auto-approval, or command options. One Host
lock serializes profile auth/doctor/run/review state. Every launch revalidates
the launcher, current pointer, release manifest, project/Git identity, supported
OpenCode executable/version, Node, config, generated agent prompt, permissions,
gateway, and clean checkout before a model starts.

### Claude Code Host

`/claude-architect:delegate` remains the complete interface and uses
plugin-scoped `mcp__plugin_claude-architect_runtime__*` tools. Claude may review,
present the decision to the human, record it, and integrate an accepted
hash-matched candidate. The legacy Claude Codex agent becomes a read-only
migration notice. No runtime blocker falls back to it or the shell wrapper.

## Profile layout and identity

The default root is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/claude-architect/opencode-profiles/<project-key>/
```

`project-key` is a SHA-256 over a versioned canonical tuple containing the
canonical worktree root and canonical Git common directory. The profile
manifest also records no-follow directory identities so a moved/replaced path
fails until reinstall.

The profile contains:

```text
profile.json                 bound project and profile identity
current.json                 atomically activated immutable release
launcher.mjs                 stable Node-compatible fixed launcher
releases/<version>/<hash>/   immutable runtime, gateway, config, prompt, manifests
opencode-config/             protected active JSONC plus OpenCode-generated metadata
architect-data/              MCP run archives/worktrees/locks
opencode-data/               profile auth and OpenCode session data
home/ xdg-config/ xdg-cache/ xdg-state/ tmp/
locks/ transactions/ backups/
```

All roots are external to the repository and installed release, created with
restrictive permissions, and rejected when symlinked or type/identity changed.
The project receives no new file, local exclude, Git config, index entry, or
metadata on a new install or any launch.

OpenCode may write `.gitignore`, package manifests/locks, and dependency files
inside `OPENCODE_CONFIG_DIR`, so that directory is not part of the immutable
release. The release contains the expected protected `opencode.jsonc` bytes and
hash. The active config directory may contain only that protected file and
explicitly recognized OpenCode-generated metadata. Any `tool(s)`, `plugin(s)`,
`agent(s)`, `skill(s)`, `command(s)`, instruction file, symlink, special file,
or unknown executable content blocks launch. The protected JSONC is rehashed
before every operation.

## Immutable release hashing

Generated config, prompt, and launcher bindings contain the final release path,
so release naming must avoid a circular hash:

1. Build a canonical deployment-key body over plugin/version/tool-policy,
   static asset hashes/modes, compatibility manifest, and generated templates
   containing a literal release-root token.
2. `deploymentHash` is SHA-256 of that tokenized body.
3. Derive `releases/<version>/<deploymentHash>/` and render exact final bytes.
4. Build a canonical install-manifest body containing deployment hash, final
   path, every rendered byte hash/mode, bound project identity, executable
   identities, expected active-config hash, and prompt/gateway policy.
5. `installManifestHash` is SHA-256 of that body before adding only its own
   field.

The stable launcher and `current.json` record both hashes. Every launch rehashes
the tokenized deployment body and final manifest/bytes. An existing release is
reused only on exact equality; immutable bytes are never updated in place.

## Installation and recovery

`scripts/install-opencode.sh` becomes a small Node bootstrap for the generated
profile CLI. It uses the same hardened executable-plus-argv Git policy as
`src/git/git-exec.ts`, neutralizing external diff/textconv, hooks, fsmonitor,
filters, and inherited `GIT_*` identity redirection.

### New install

A new install requires an existing canonical non-bare Git worktree with `HEAD`
and an exact clean status. It performs no project writes. It validates every
source, destination, executable, profile ancestor, stage, lock, journal,
backup, data root, and identity with no-follow canonical containment.

### Upgrade from the legacy project installer

The current project installer may have left untracked agents, skill, and
scripts that make the checkout dirty. Before rejecting dirt, the new installer
may classify only exact legacy paths whose bytes/modes match a checked
release-owned inventory generated from supported tags. Every current
project-installed asset is inventoried, not only the Codex wrapper.

Tracked, ignored-user-owned, modified, unknown, symlinked, special, or unrelated
paths are preserved and block activation. Release-owned untracked files are
backed up externally and removed transactionally. Empty plugin-owned directories
may be removed after no-follow identity checks. No broad recursive deletion is
allowed.

### Transaction

One installer holds an atomic regular-file lock whose complete PID/start-token
owner record is fsynced then hard-linked into place. A live or ambiguous owner
fails closed. A provably dead/PID-reused owner may be quarantined after inode
revalidation; the installer never signals it.

Order:

1. Complete read-only source/project/profile/executable preflight and render all
   candidate bytes externally.
2. Acquire the external profile install lock.
3. Create a bounded no-follow journal recording prior current pointer, intended
   hashes, stage identity, legacy project inventory, backups, and phase.
4. Stage and validate the complete immutable release.
5. Start staged gateway/runtime in private state and prove initialize,
   allowlisted tools, forbidden tools, bound checkout, and doctor.
6. Back up and remove only release-owned legacy project files; verify project
   status is now clean.
7. Publish immutable release and stable launcher by atomic replacement.
8. Atomically replace the protected active JSONC with the rendered release
   bytes; preserve only recognized OpenCode-generated metadata.
9. Atomically replace `current.json` last as activation.
10. Mark complete, fsync, remove owned backups/stage, and release the same lock.

Every durable manifest, journal, launcher, current pointer, and ownership
transition uses same-directory regular temp bytes, file fsync, identity
revalidation, atomic link/rename, and parent-directory fsync.

Ordinary failure restores the previous pointer and exact legacy backups. Crash
recovery validates lock/journal/inodes/hashes before completing activation or
restoring. Contradictory evidence fails closed for manual inspection. A crash
after legacy removal may temporarily leave the old route unavailable, never
partially executable.

## Data flow

### Claude Code complete flow

1. Build a canonical version-1 Delegation Spec.
2. Call Claude's `delegate` or `delegatePipeline` tool.
3. Keep the call foregrounded to a terminal result.
4. Review exact candidate/evidence.
5. Present a human decision.
6. Record accepted/rejected/revision-requested.
7. Integrate only accepted exact-hash bytes.

### OpenCode compatibility flow

1. User runs profile launcher `doctor` and then `run`, supplying a complete task
   on stdin and explicit Host model.
2. Generated Build prompt constructs the same canonical version-1 spec for the
   profile-bound project and calls gateway `delegate`/`delegatePipeline`.
3. It keeps the call foregrounded to a terminal result.
4. On a verified candidate it calls `reviewCandidate` and reports exact evidence.
5. It returns `pending-human-decision`, run id, manifest hash, findings, and the
   explicit absence of OpenCode decision/integration.
6. It stops. No shell fallback, manual patch application, or acceptance claim.

## Failure behavior

- A running runtime returns its existing structured classifications unchanged.
- Gateway non-allowlisted calls fail before child forwarding.
- Launcher/profile/config/executable/project/doctor mismatch returns a stable
  Host `unavailable` report and starts no model or Producer.
- Dirty checkout, unsupported version, invalid profile, missing runtime,
  protocol mismatch, ineligible confinement, timeout, cancellation, and
  verification failure never invoke the shell wrapper.
- Retry requires a fresh Host-authorized attempt. Producer self-reports never
  establish candidate, decision, or integration.

## Migration and test strategy

1. Characterize current green `--lane-mode edit` shell behavior and inherited
   runtime fail-closed cases.
2. Build/test generated gateway and profile launcher/process/identity modules.
3. Build immutable external profile installation, hashing, locks, journal,
   legacy ownership inventory, and crash recovery.
4. Prove launcher doctor against malicious project/global discovery sentinels
   and exact supported OpenCode `1.18.3`.
5. Move Host prompts and tombstone both Codex agents.
6. Run installed fake-Codex lifecycle/concurrency through the exact launcher
   profile/gateway/runtime, then retire shell source/packaging.
7. Update active docs/privacy/release surfaces and run full gates.

Required coverage includes:

- Current shell behavior is green before retirement; historical exit 65 is not
  misrepresented.
- New install and every launch leave project/Git bytes/status unchanged.
- Known legacy project installs upgrade; all replaced assets are inventoried;
  unknown or user-owned files are preserved conflicts.
- Malicious project `.opencode` config/tools/plugins/agents/skills and
  AGENTS/CLAUDE instructions are not loaded or executed.
- User global OpenCode/Claude/agent config, skills, plugins, credentials, and
  provider environment do not enter the profile.
- Profile `auth` creates credentials only under profile data.
- Effective Build tools contain only read/search plus the eight gateway tools;
  shell/edit/write/patch/task/web/skill/external paths are denied.
- Gateway allowlist, bound checkout, bidirectional protocol, backpressure,
  queue/request bounds, process cleanup, and future-tool denial pass.
- Two concurrent sentinel attempts cannot exchange prompts, ids, progress,
  worktrees, logs, archives, patches, or candidates.
- Main checkout remains unchanged and OpenCode cannot decide/integrate.
- Zero edit, timeout after edit, dirty checkout, stale base, invalid protocol,
  missing runtime, nested delegation, and ineligible confinement fail closed.
- Immutable hashing is non-circular and reproducible; activation and recovery
  never expose partial bytes.
- Source/test TypeScript, generated runtime assets, strict Claude validation,
  exact OpenCode Host gate, installer/upgrade, lifecycle, and retirement pass.

Real provider/model and real Codex smoke tests remain opt-in. They record exact
versions/model/confinement but do not expand certification.

## Compatibility window

The migration release retains both `codex-implementer` filenames as read-only
notices. They may be removed in the next minor only after prior-release upgrade
fixtures prove no installed resolver/package path depends on them.

## Acceptance criteria

- No supported Codex edit flow invokes the retired shell wrapper or assigns
  lifecycle implementation to agent prose.
- Claude Code retains the complete existing structured lifecycle.
- The supported OpenCode entry is an external project-bound fixed launcher;
  new install and launch do not write project/Git metadata.
- Project/global discovery and mutation/process tools are disabled and verified
  before an OpenCode model starts.
- Gateway and effective profile expose only the exact eight-tool allowlist and
  bind repository-taking calls to the installed project.
- OpenCode cannot decide/integrate or manually apply a pending candidate.
- Installer/profile/gateway failure cannot fall through to shell editing.
- Legacy upgrade removes only hash-owned untracked assets and preserves unknown
  or user-owned paths.
- Immutable release activation/recovery is identity-bound, hash-checked,
  durable, and rerunnable.
- Existing runtime, protocol, Producer, platform, and certification behavior is
  unchanged.
- Profile, launcher, gateway, Host, lifecycle, upgrade, retirement, type-check,
  generated-asset, and release gates pass.

## Residual risks

This migration trusts the supported OpenCode binary/profile flag semantics and
inherits existing runtime limitations. It is not an OS sandbox around a
compromised OpenCode executable or same-user host process. Exact executable
identity/version and effective-tool checks make drift fail closed but do not
turn OpenCode into a certified Host.

OpenCode has no Controlled Integration path. A future trusted handoff requires
a separate approved design.

## References

- `src/mcp/server.ts`
- `src/mcp/tools.ts`
- `src/runtime/attempt-runtime.ts`
- `src/producers/codex-adapter.ts`
- `src/git/git-exec.ts`
- `src/git/repo-preconditions.ts`
- `runtime/bootstrap.mjs`
- `scripts/install-opencode.sh`
- OpenCode MCP configuration:
  https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/mcp-servers.mdx
- OpenCode permissions:
  https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/permissions.mdx
- OpenCode project-discovery disable behavior:
  https://github.com/anomalyco/opencode/issues/7559
- OpenCode custom tool discovery:
  https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/registry.ts
- OpenCode external skill disable behavior:
  https://github.com/anomalyco/opencode/issues/27526
