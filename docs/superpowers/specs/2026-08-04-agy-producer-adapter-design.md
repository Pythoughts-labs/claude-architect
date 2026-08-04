# Antigravity CLI (`agy`) Producer adapter — design

Date: 2026-08-04
Status: approved, pending implementation plan

## Goal

Add Google Antigravity CLI (`agy`) as a fifth delegation-lane Producer,
alongside Codex, OpenCode, Pi, and Pythinker. `agy-implementer` becomes a
selectable lane in `skills/delegate/SKILL.md`, routed and confined by the
existing `ProducerAdapter` contract — no protocol version bump, no changes to
`src/pipeline/`, `src/verify/`, or `src/integrate/`.

## Evidence base

Unlike the existing adapters, `agy` had no prior in-repo precedent and no
trustworthy secondary documentation — several SEO sites returned confidently
wrong CLI flags (an invented `ANTIGRAVITY_API_KEY` env var that a live
GitHub issue shows is still an *open feature request*, not shipped). Every
claim below is grounded in one of:

1. `agy --help` (installed binary, v1.1.10, real output).
2. `strings` on the installed binary (real env-var identifiers).
3. Real on-disk state under `~/.gemini/antigravity-cli/`.
4. `google-antigravity/antigravity-cli` GitHub issues (via `gh api`, not search snippets).
5. Four live `agy -p ... --output-format json` invocations run in an isolated
   scratch directory during this session, output captured verbatim below.

## Key findings that shape the design

### 1. Workspace scoping is NOT cwd-based — this is the load-bearing finding

Every other adapter in this repo relies on `attempt-runtime.ts` setting the
child process `cwd` to `worktree.path`; none pass an explicit directory flag
except Codex (`--cd`) and OpenCode (`--dir`), which are effectively redundant
with `cwd`.

`agy` is different. A live probe with no directory flag and `cwd` set to a
scratch dir asked `agy` to run `pwd` inside its own tool-execution shell:

```
$ agy -p "Run pwd and reply with exactly its output." --output-format json ...
{"status":"SUCCESS","response":"/Users/panda/.gemini/antigravity-cli/scratch\n", ...}
```

**`agy` ignored the process `cwd` entirely** and operated in its own internal
scratch workspace under its config directory. Had this shipped on the strength
of `--help` text alone (which lists no `--cd`/`--dir`), the delegation lane
would silently run in the wrong directory and no verification would catch it
— it would report success having "fixed" nothing in the actual worktree.

Adding `--add-dir <worktreePath> --new-project` fixes this — a second probe
confirmed `agy` then correctly lists worktree files and reports the worktree
path as its workspace root. **Both flags are mandatory in `buildInvocation`.**
`--new-project` additionally guarantees fresh context per attempt (no resumed
conversation), which is a stated trust invariant in `AGENTS.md`.

### 2. Prompt goes on argv, not stdin — the one adapter that differs here

Every other adapter pipes the rendered prompt via `stdin`. GitHub issue
[#76](https://github.com/google-antigravity/antigravity-cli/issues/76)
(closed, fixed in 1.1.1): `agy -p` used to hang or silently drop output in
non-TTY/subprocess contexts because it read stdin *in addition to* the `-p`
argument. The fix was "no longer reading stdin when a prompt is provided via
a flag." Issue [#318](https://github.com/google-antigravity/antigravity-cli/issues/318)
(non-TTY hang) is still open with no comments as of this session — residual
risk, not eliminated. Given both bugs are specifically about stdin/non-TTY
interaction, `AgyAdapter.buildInvocation` passes the rendered prompt as an
`args` element (`-p`, prompt text), leaving `stdin` unset — the one thing this
adapter does structurally differently from its siblings, for a documented
reason.

The existing `supervise()` `timeoutMs` remains the hard backstop against any
residual hang (same mechanism that already protects every other adapter);
no new timeout code is needed.

### 3. Structured JSON output, confirmed live

`--output-format json` gives a single-envelope response, exactly as
documented and exactly as observed:

```json
{"conversation_id":"...","status":"SUCCESS","response":"...",
 "duration_seconds":1.33,"num_turns":1,
 "usage":{"input_tokens":18548,"output_tokens":40,"thinking_tokens":32,
          "cache_read_tokens":0,"total_tokens":18588}}
```

`structuredOutput: true`. `normalizeEvents` parses this single object (not a
JSONL event stream like Codex) — `ok = status === "SUCCESS"`, `producerSummary
= response`. Documented `status` values: `SUCCESS, ERROR, CANCELED,
INTERRUPTED, INVALID, WAITING, RUNNING` — only `SUCCESS` is `ok`. On a JSON
parse failure or missing `status`/`response`, fall back the same way Codex
does: `{ events: [], producerSummary: null, ok: false }`.

### 4. Unattended edit application confirmed live

`--dangerously-skip-permissions` alone (no `--mode accept-edits`) auto-applies
a real file edit unattended — verified with a live file-creation probe. This
mirrors Codex's `approval_policy=never` and OpenCode's `--auto`: our own
outer write-confinement (Seatbelt) is the actual security boundary, so the
Producer's own confirmation prompts are irrelevant noise to suppress, not a
safety feature to preserve. `--mode accept-edits` is dropped from the design
— proven unnecessary, and this repo's engineering guardrails reject
speculative flags.

### 5. Auth is keyring-based, not a file — `authState` is honest best-effort

`agy` authenticates via the system keyring (Keychain on macOS) after one
interactive `agy` login, confirmed by the README and by the presence of an
`"Antigravity IDE Safe Storage"` Keychain service. There is no
`~/.pi/agent/auth.json`-equivalent token file to `existsSync()` the way
Pi/OpenCode do. `strings` on the binary does show a real `GEMINI_API_KEY`
reference (unlike the fabricated `ANTIGRAVITY_API_KEY`), so `GEMINI_API_KEY`
is included as an optional pass-through in `requiredEnv`, but it is not the
primary path and its exact CI-auth semantics are unconfirmed — this is called
out as a residual unknown, not asserted as tested.

Given there is no reliable file to probe, `authState` is set from the
presence of `~/.gemini/antigravity-cli/settings.json` (install/login marker)
as a best-effort heuristic, same spirit as Pi/OpenCode's file check, with the
same caveat: presence indicates "has been set up," not "token is currently
valid." This field does not gate routing (`routing-policy.ts` only branches
on `reason === "authentication-required"`, which no adapter in this repo
currently emits from a real probe path).

`configurationProfile().isolationState` is **`inherited-config-only`**, same
as Pi — not `controlled-config-with-copied-credentials` like OpenCode, because
OS-keyring credentials cannot be redirected via a per-attempt `HOME`/XDG
override the way a JSON auth file can. This is a factual constraint, not a
choice.

### 6. Platform support: darwin/arm64 only, for now — forced by existing infra

`agy` itself installs on macOS, Linux, and Windows. But this repo's
`SANDBOX_BACKENDS` (`src/platform/sandbox/backends.ts`) currently has exactly
one OS-level write-confinement backend, `macos-seatbelt`, certified only on
darwin/arm64. There is no Linux or Windows write-confinement backend at all
today — Pi and OpenCode are already limited to darwin/arm64 for the same
reason. `AgyAdapter` follows the identical pattern: `probe()` hard-rejects
`win32` (`unsupported-platform`, matching Pi/OpenCode's existing early return)
and falls through to `selectOsWriteConfinementBackend(ctx)` for
darwin/linux, which naturally yields `laneEligibility.edit: false` on Linux
until a Linux backend exists. No new sandbox backend work is in scope here.

### 7. Known operational costs (documented, not fixed — out of scope)

- **Startup latency is highly variable.** One live probe's wall-clock time was
  63 seconds despite the JSON envelope reporting `duration_seconds: 1.33` —
  ~62s of unaccounted startup/IPC overhead (a background sidecar process,
  auth negotiation, or the still-open #318 hang class manifesting partially).
  Subsequent calls were 2–4 seconds end-to-end. This is a real, observed
  characteristic to size `timeoutMs` generously for, not a bug this design
  introduces or can fix.
- **`--new-project` leaves persistent state.** Four probe calls left ~2.7MB
  under `~/.gemini/antigravity-cli/conversations/`, never cleaned up by `agy`
  itself. Over many delegation attempts this grows unbounded on the host
  machine. Noted for awareness; no cleanup mechanism is proposed here — it is
  outside this repo's ownership (agy's own state directory, not something we
  create or manage) and matches how Pi/OpenCode/Codex already leave their own
  auth/session directories unmanaged.
- A cosmetic, unrelated observation from the live probes: `agy`'s installer
  adds a shell-integration hook that reports resetting the interactive shell's
  `cwd` after each invocation. This is shell-integration noise from the
  installer, not something `agy` does inside the spawned subprocess itself,
  and has no bearing on the adapter design.

## Component design

### `src/producers/agy-adapter.ts` (new)

Shape mirrors `pi-adapter.ts` structurally (simplest existing adapter), with
three deltas: `--add-dir`/`--new-project` workspace scoping, argv-based
prompt delivery instead of stdin, and JSON-envelope `normalizeEvents` instead
of `normalizePlainText`.

```ts
producerId = "agy"
structuredOutput = true
executionModes = ["edit"]

AGY_REQUIRED_ENV = ["GEMINI_API_KEY"] as const   // optional pass-through; keyring is primary auth

probe(ctx):
  - win32 → unavailableReport("unsupported-platform")   // same as Pi/OpenCode
  - resolve executable "agy" via ctx.ps.resolveExecutable + normalizeNodeShim
  - `agy --version` (10s timeout, 64KB cap) → parseVersion (same regex as siblings)
  - writeConfinementBackend = selectOsWriteConfinementBackend(ctx)
  - authState: existsSync(~/.gemini/antigravity-cli/settings.json) ? "authenticated" : "unauthenticated"
  - laneEligibility.edit = writeConfinementBackend !== null

buildInvocation(spec, ctx):
  args = [
    "-p", renderProducerPrompt(spec, ctx.readOnly === true),   // argv, not stdin — see finding #2
    "--add-dir", ctx.worktreePath,                              // mandatory — see finding #1
    "--new-project",                                            // mandatory — fresh context per attempt
    "--output-format", "json",
    "--dangerously-skip-permissions",
    "--print-timeout", <formatted from `spec.timeoutMs`, e.g. "45m">,
  ]
  + "--model" / "--effort" from spec.producerOverrides, same pattern as every sibling adapter
  stdin: undefined
  requiredEnv: [...AGY_REQUIRED_ENV]
  network: "allowed"   // model session must reach the provider API, same rationale as every sibling

normalizeEvents(raw):
  - exit.truncated.stdout / non-zero exit → same failure shape as normalizePlainText
  - JSON.parse(raw.stdout.trim()); on parse failure or missing status/response → { events: [], producerSummary: null, ok: false }
  - ok = parsed.status === "SUCCESS"
  - producerSummary = parsed.response ?? null
  - events = [{ kind: ok ? "final" : "error", text: producerSummary ?? undefined, raw: parsed }]

configurationProfile():
  isolationState: "inherited-config-only"
  credentialSources: ["macOS Keychain (\"Antigravity IDE Safe Storage\")", "GEMINI_API_KEY (optional, unconfirmed CI semantics)"]
  behavioralConfigSources: ["~/.gemini/antigravity-cli/settings.json", "explicit invocation argv"]
  repositoryInstructionSources: ["worktree AGENTS.md"]
  environmentDependencies: [...AGY_REQUIRED_ENV]
  temporaryHomeStrategy: "real HOME inherited by declared policy (keyring auth is not HOME-redirectable); reduced reproducibility recorded in the Run Manifest"
```

`--print-timeout` defaults to 5m internally; if left at that default on an
attempt whose external `spec.timeoutMs` (the `supervise()` backstop every
adapter already relies on) is longer, `agy` would internally give up and
report a timeout status before our own kill timer ever fires — a spurious
failure on an otherwise-healthy long attempt. Setting it explicitly from
`spec.timeoutMs` avoids that; `supervise()`'s external timeout remains the
actual enforcement mechanism, unchanged from every other adapter.

### `src/platform/sandbox/seatbelt.ts`

Add `agyWritablePaths()`, same shape as `piWritablePaths`/`openCodeWritablePaths`:
grants write access to `~/.gemini/antigravity-cli/` (its full state dir:
conversations, cache, log, crashes, brain, scratch — all observed to receive
writes during the live probes) when `policy.tempHome === null` and the
invocation is an `agy` invocation (reuse the `isPythinkerInvocation`-style
executable-identity check — the referenced fix commit `7fd222d` established
"detect by executable identity, not a flag" as the correct pattern in this
exact file). Wired into `wrapInvocationWithSeatbelt`'s `additionalWritable`
list alongside the other three.

### `src/producers/producer-registry.ts`

Add `AgyAdapter` import and `new AgyAdapter()` to the registry array.

### Docs / tests (mechanical, following existing per-producer touch points)

- `skills/delegate/SKILL.md`: add `agy-implementer` alongside the other four
  `*-implementer` lane names and reasoning-control phrasing, preserving every
  exact string `tests/delegate-routing.test.mjs` currently pins (per
  `tasks/lessons.md`).
- `docs/ARCHITECTURE.md`, `docs/SECURITY_MODEL.md`, `docs/PRIVACY.md`,
  `README.md`, `SECURITY.md`: add `agy` to the existing per-producer
  enumeration tables/lists, same shape as the OpenCode/Pi entries.
- `CHANGELOG.md`: `## [Unreleased]` entry (per the "don't bundle a version
  bump into a feature commit" lesson).
- Tests: `tests/runtime/agy-adapter.test.ts` (new, mirrors
  `pi-adapter.test.ts`/`opencode-adapter.test.ts` structure: probe success/
  failure/win32/missing-executable, buildInvocation argv+env+stdin-absence,
  normalizeEvents success/failure/malformed-JSON, configurationProfile).
  Extend `tests/runtime/capability-probe.test.ts`,
  `tests/runtime/seatbelt.test.ts` (new `agyWritablePaths` cases), and
  `tests/runtime/tools.test.ts` (producer roster) the same way the OpenCode
  adapter did.
- A real-`agy` smoke test is **out of scope for CI** (opt-in, like the
  existing Codex smoke pattern) but strongly recommended before this lane is
  trusted for real delegation — this session's live probes are evidence
  gathered for design purposes, not a substitute for the repo's own opt-in
  smoke-test contract.

## Explicitly out of scope

- Any new sandbox/write-confinement backend (Linux, Windows). `agy` inherits
  exactly the same darwin/arm64-only ceiling Pi and OpenCode already have.
- Cleanup of `agy`'s own persistent conversation/project state.
- Resolving the unconfirmed `GEMINI_API_KEY` CI-auth path — included as an
  optional allowed env var, not load-bearing.
- Any protocol/schema version change — this is purely an additive Producer,
  identical in shape to how OpenCode and Pi were added.
