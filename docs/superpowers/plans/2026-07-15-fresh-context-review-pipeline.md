# Fresh-Context Review Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `delegatePipeline` MCP tool that runs a deterministic write→review→fix→re-review→clean-room-verify loop, every role in a fresh, isolated producer-lane process, returning an evidence bundle for Claude to decide on.

**Architecture:** New `src/pipeline/` module (types, schemas, consolidator, gates, prompts, role runner, orchestrator) layered on the existing runtime. The Implement phase reuses `runAttempt` unchanged; reviewer/verifier roles run producers read-only via a Seatbelt profile with no writable worktree path; roles hand off only versioned artifacts through `ArtifactStore`. Deterministic runtime code (never an agent) drives state transitions, consolidation, and gate evaluation.

**Tech Stack:** TypeScript ESM (Node ≥22), `@modelcontextprotocol/sdk` (zod tool schemas), `ajv` JSON-schema validation, vitest.

Spec: `docs/superpowers/specs/2026-07-15-fresh-context-review-pipeline-design.md`

## Global Constraints

- Spec invariants: fresh context per role; role separation (implementer never approves own code; reviewers/verifier read-only; fixer never final-verifies; runtime never authors code or waives findings); artifact-only handoff (reviewer packages never include implementer transcript/reasoning); fail closed (missing/invalid evidence = gate not satisfied; round caps route to human decision, never auto-accept).
- Defaults copied verbatim from spec: `reviewers: [correctness, systems]`, `max_rounds: 2`. `review` block is optional — existing `delegate` calls untouched.
- Disposition values, verbatim: `fixed | already_satisfied | rejected_with_evidence | blocked | requires_human_decision`.
- Severity values, verbatim: `blocker | major | minor | nit`. Nits never block.
- Structured outputs: validated at the runtime boundary, one schema-repair retry, then phase failure.
- Role process failure: retry once with the identical input package in a new session; second failure marks the phase blocked.
- The pipeline never merges. `decideCandidate`/`integrateCandidate` remain the only decision/integration paths.
- No new state store, no `.delegation/` tree — all artifacts go through `ArtifactStore` (`resolveStateDir()/runs/<runId>`).
- Commit messages: imperative, ≤72-char subject, **no** Claude co-author trailers or "Generated with Claude Code" footers.
- Run `npm test` (vitest) before every commit; only commit green.
- Reuse as-is: worktree isolation (`src/git/worktree-manager.ts`), producer adapters/registry/routing (`src/producers/`), Seatbelt backend (`src/platform/sandbox/`), `ArtifactStore`, `RunManifest`, `AcceptanceVerifier`, redacted logging, `RecoveryManager`, decide/integrate tools.
- **Known repo gap (from exploration):** only `macos-seatbelt` and `codex-native-sandbox` backends exist; there is no bwrap backend. v1 read-only confinement = Seatbelt profile whose writable paths exclude the worktree. On platforms with no OS backend, read-only roles fail closed (`sandbox-violation`-style refusal), matching invariant 4.
- **Working-tree caveat:** `src/platform/sandbox/seatbelt.ts` and `tests/runtime/seatbelt.test.ts` have uncommitted modifications on `main`. Before Task 4, run `git status`; if still dirty, stop and ask the human whether to commit/stash those changes first. Do not mix them into pipeline commits.

## File Structure

New files:

```
runtime/schemas/review-report.v1.json        # reviewer structured output schema
runtime/schemas/fix-report.v1.json           # fixer structured output schema
runtime/schemas/verification-report.v1.json  # clean-room verifier schema
src/pipeline/report-types.ts                 # Finding, ReviewReport, FixReport, VerificationReport, Disposition
src/pipeline/structured-output.ts            # parse + one schema-repair retry
src/pipeline/consolidator.ts                 # deterministic finding consolidation
src/pipeline/gates.ts                        # decision-ready gate evaluation
src/pipeline/role-prompts.ts                 # reviewer/fixer/verifier prompt templates + role-spec builder
src/pipeline/role-runner.ts                  # run one fresh role process (read-only or fixer)
src/pipeline/pipeline-runtime.ts             # round loop + clean-room verify + evidence bundle
tests/runtime/report-schemas.test.ts
tests/runtime/structured-output.test.ts
tests/runtime/consolidator.test.ts
tests/runtime/gates.test.ts
tests/runtime/role-prompts.test.ts
tests/runtime/role-runner.test.ts
tests/runtime/pipeline-runtime.test.ts
tests/runtime/e2e-pipeline.test.ts
```

Modified files:

```
src/protocol/schema-loader.ts        # compile the three new schemas
src/protocol/delegation-spec.ts      # optional `review` block
runtime/schemas/delegation-spec.v1.json  # optional `review` block
src/platform/sandbox/seatbelt.ts     # read-only policy helper
src/runtime/artifact-store.ts        # write/read pipeline artifacts
src/mcp/tools.ts                     # handleDelegatePipeline
src/mcp/server.ts                    # register delegatePipeline
skills/delegate/SKILL.md             # route non-trivial tasks to delegatePipeline
```

---

### Task 1: Report types and JSON schemas

**Files:**
- Create: `src/pipeline/report-types.ts`
- Create: `runtime/schemas/review-report.v1.json`, `runtime/schemas/fix-report.v1.json`, `runtime/schemas/verification-report.v1.json`
- Modify: `src/protocol/schema-loader.ts`
- Test: `tests/runtime/report-schemas.test.ts`

**Interfaces:**
- Consumes: existing `loadSchemas()` pattern in `src/protocol/schema-loader.ts` (ajv-compiled validators read from `runtime/schemas/*.v1.json`).
- Produces: types `Finding`, `RawFinding`, `ReviewReport`, `Disposition`, `FixReport`, `VerificationReport`, `FindingSeverity`, `DispositionValue` from `src/pipeline/report-types.ts`; `loadSchemas()` additionally returns compiled validators `reviewReport`, `fixReport`, `verificationReport`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/report-schemas.test.ts
import { describe, expect, it } from "vitest";
import { loadSchemas } from "../../src/protocol/schema-loader.js";

const validReview = {
  reportVersion: "1",
  verdict: "request-changes",
  findings: [
    {
      severity: "blocker",
      location: "src/auth/session.ts:42",
      claim: "Session tokens are compared with ===, allowing timing attacks",
      evidence: "Line 42 uses `token === stored`",
      reproduction: "Call verify() with near-matching tokens and measure timing",
      requiredOutcome: "Use timingSafeEqual",
      confidence: 0.9,
    },
  ],
  coverageGaps: ["Did not review Windows path handling"],
};

const validFix = {
  reportVersion: "1",
  candidateCommit: "a".repeat(40),
  dispositions: [
    { findingId: "F-001", disposition: "fixed", evidence: "Replaced with timingSafeEqual; test added", commit: "a".repeat(40) },
  ],
};

const validVerification = {
  reportVersion: "1",
  pass: true,
  commandResults: [{ id: "unit", exitCode: 0, ok: true }],
  workspaceClean: true,
  testsDeleted: 0,
  testsSkipped: 0,
  scopeViolations: [],
};

describe("pipeline report schemas", () => {
  it("accepts valid reports", () => {
    const s = loadSchemas();
    expect(s.reviewReport(validReview)).toBe(true);
    expect(s.fixReport(validFix)).toBe(true);
    expect(s.verificationReport(validVerification)).toBe(true);
  });

  it("rejects unknown severity", () => {
    const s = loadSchemas();
    const bad = structuredClone(validReview);
    bad.findings[0].severity = "catastrophic";
    expect(s.reviewReport(bad)).toBe(false);
  });

  it("rejects unknown disposition and missing evidence", () => {
    const s = loadSchemas();
    const bad = structuredClone(validFix);
    bad.dispositions[0].disposition = "wontfix";
    expect(s.fixReport(bad)).toBe(false);
    const bad2 = structuredClone(validFix);
    delete (bad2.dispositions[0] as Record<string, unknown>).evidence;
    expect(s.fixReport(bad2)).toBe(false);
  });

  it("rejects additional properties (fail closed)", () => {
    const s = loadSchemas();
    const bad = { ...validVerification, extra: true };
    expect(s.verificationReport(bad)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/report-schemas.test.ts`
Expected: FAIL — `loadSchemas()` result has no `reviewReport` property (TypeError or type error).

- [ ] **Step 3: Write the types, schemas, and loader extension**

```ts
// src/pipeline/report-types.ts
export type FindingSeverity = "blocker" | "major" | "minor" | "nit";

export type DispositionValue =
  | "fixed"
  | "already_satisfied"
  | "rejected_with_evidence"
  | "blocked"
  | "requires_human_decision";

/** A finding as emitted by a reviewer (no id yet — ids are assigned by the consolidator). */
export interface RawFinding {
  severity: FindingSeverity;
  location: string;        // "path/to/file.ts:line"
  claim: string;           // falsifiable claim
  evidence: string;
  reproduction: string;
  requiredOutcome: string;
  confidence: number;      // 0..1
}

/** A consolidated finding with a stable id and originating reviewer(s). */
export interface Finding extends RawFinding {
  id: string;              // "F-001", "F-002", ...
  reviewers: string[];     // e.g. ["correctness"] or ["correctness","systems"]
}

export interface ReviewReport {
  reportVersion: "1";
  verdict: "approve" | "request-changes";
  findings: RawFinding[];
  coverageGaps: string[];
}

export interface Disposition {
  findingId: string;
  disposition: DispositionValue;
  evidence: string;
  commit?: string;         // required for "fixed" (enforced by gates, not schema)
}

export interface FixReport {
  reportVersion: "1";
  candidateCommit: string; // 40-hex commit oid
  dispositions: Disposition[];
}

export interface VerificationReport {
  reportVersion: "1";
  pass: boolean;
  commandResults: { id: string; exitCode: number; ok: boolean }[];
  workspaceClean: boolean;
  testsDeleted: number;
  testsSkipped: number;
  scopeViolations: string[];
}
```

```json
// runtime/schemas/review-report.v1.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "required": ["reportVersion", "verdict", "findings", "coverageGaps"],
  "properties": {
    "reportVersion": { "const": "1" },
    "verdict": { "enum": ["approve", "request-changes"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "location", "claim", "evidence", "reproduction", "requiredOutcome", "confidence"],
        "properties": {
          "severity": { "enum": ["blocker", "major", "minor", "nit"] },
          "location": { "type": "string", "minLength": 1 },
          "claim": { "type": "string", "minLength": 1 },
          "evidence": { "type": "string", "minLength": 1 },
          "reproduction": { "type": "string" },
          "requiredOutcome": { "type": "string", "minLength": 1 },
          "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        }
      }
    },
    "coverageGaps": { "type": "array", "items": { "type": "string" } }
  }
}
```

```json
// runtime/schemas/fix-report.v1.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "required": ["reportVersion", "candidateCommit", "dispositions"],
  "properties": {
    "reportVersion": { "const": "1" },
    "candidateCommit": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "dispositions": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["findingId", "disposition", "evidence"],
        "properties": {
          "findingId": { "type": "string", "pattern": "^F-\\d{3,}$" },
          "disposition": { "enum": ["fixed", "already_satisfied", "rejected_with_evidence", "blocked", "requires_human_decision"] },
          "evidence": { "type": "string", "minLength": 1 },
          "commit": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
        }
      }
    }
  }
}
```

```json
// runtime/schemas/verification-report.v1.json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "required": ["reportVersion", "pass", "commandResults", "workspaceClean", "testsDeleted", "testsSkipped", "scopeViolations"],
  "properties": {
    "reportVersion": { "const": "1" },
    "pass": { "type": "boolean" },
    "commandResults": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "exitCode", "ok"],
        "properties": {
          "id": { "type": "string" },
          "exitCode": { "type": "integer" },
          "ok": { "type": "boolean" }
        }
      }
    },
    "workspaceClean": { "type": "boolean" },
    "testsDeleted": { "type": "integer", "minimum": 0 },
    "testsSkipped": { "type": "integer", "minimum": 0 },
    "scopeViolations": { "type": "array", "items": { "type": "string" } }
  }
}
```

In `src/protocol/schema-loader.ts`, extend `loadSchemas()` following the exact same read+compile pattern used for `delegation-spec.v1.json` and `attempt-result.v1.json` (same file-resolution helper, same ajv instance and options), adding three entries to the returned object:

```ts
// added alongside the two existing compiled validators, same pattern:
reviewReport: ajv.compile(readSchemaFile("review-report.v1.json")),
fixReport: ajv.compile(readSchemaFile("fix-report.v1.json")),
verificationReport: ajv.compile(readSchemaFile("verification-report.v1.json")),
```

(Use whatever the existing helper for reading a schema file is actually named in that module — keep the two existing schemas' code untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime/report-schemas.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run full suite and commit**

Run: `npm test` → all green.

```bash
git add runtime/schemas/review-report.v1.json runtime/schemas/fix-report.v1.json runtime/schemas/verification-report.v1.json src/pipeline/report-types.ts src/protocol/schema-loader.ts tests/runtime/report-schemas.test.ts
git commit -m "feat(pipeline): report types and structured-output schemas"
```

---

### Task 2: Structured-output parser with one schema-repair retry

**Files:**
- Create: `src/pipeline/structured-output.ts`
- Test: `tests/runtime/structured-output.test.ts`

**Interfaces:**
- Consumes: ajv `ValidateFunction` from Task 1's `loadSchemas()`.
- Produces: `parseStructuredReport<T>(raw, validate, repair): Promise<ParseOutcome<T>>` where `ParseOutcome<T> = { ok: true; value: T; repaired: boolean } | { ok: false; error: string }`, and `extractJson(raw: string): string | null` (pulls the last fenced ```json block or the raw string if it parses as JSON).

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/structured-output.test.ts
import { describe, expect, it, vi } from "vitest";
import { loadSchemas } from "../../src/protocol/schema-loader.js";
import { extractJson, parseStructuredReport } from "../../src/pipeline/structured-output.js";
import type { VerificationReport } from "../../src/pipeline/report-types.js";

const good: VerificationReport = {
  reportVersion: "1", pass: true, commandResults: [], workspaceClean: true,
  testsDeleted: 0, testsSkipped: 0, scopeViolations: [],
};

describe("extractJson", () => {
  it("extracts a fenced json block from chatter", () => {
    const raw = "Here is my report:\n```json\n" + JSON.stringify(good) + "\n```\nDone.";
    expect(JSON.parse(extractJson(raw)!)).toEqual(good);
  });
  it("accepts bare JSON", () => {
    expect(JSON.parse(extractJson(JSON.stringify(good))!)).toEqual(good);
  });
  it("returns null for garbage", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("parseStructuredReport", () => {
  it("parses valid output without invoking repair", async () => {
    const repair = vi.fn();
    const out = await parseStructuredReport<VerificationReport>(
      JSON.stringify(good), loadSchemas().verificationReport, repair);
    expect(out).toEqual({ ok: true, value: good, repaired: false });
    expect(repair).not.toHaveBeenCalled();
  });

  it("retries exactly once on invalid output, then succeeds", async () => {
    const repair = vi.fn(async () => JSON.stringify(good));
    const out = await parseStructuredReport<VerificationReport>(
      "{\"pass\": true}", loadSchemas().verificationReport, repair);
    expect(out.ok).toBe(true);
    expect(out.ok && out.repaired).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("fails the phase when the repair attempt is also invalid", async () => {
    const repair = vi.fn(async () => "still garbage");
    const out = await parseStructuredReport<VerificationReport>(
      "garbage", loadSchemas().verificationReport, repair);
    expect(out.ok).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/structured-output.test.ts`
Expected: FAIL — module `src/pipeline/structured-output.ts` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// src/pipeline/structured-output.ts
import type { ValidateFunction } from "ajv";

export type ParseOutcome<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; error: string };

const FENCE = /```json\s*([\s\S]*?)```/g;

export function extractJson(raw: string): string | null {
  let last: string | null = null;
  for (const match of raw.matchAll(FENCE)) last = match[1].trim();
  const candidate = last ?? raw.trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

function validateRaw<T>(raw: string, validate: ValidateFunction): { ok: true; value: T } | { ok: false; error: string } {
  const json = extractJson(raw);
  if (json === null) return { ok: false, error: "no parseable JSON in output" };
  const value = JSON.parse(json) as T;
  if (!validate(value)) {
    return { ok: false, error: JSON.stringify(validate.errors ?? []) };
  }
  return { ok: true, value };
}

/**
 * Validate producer output against a schema. On failure, invoke `repair`
 * exactly once (a fresh producer call given the validation errors); a second
 * failure is a phase failure — never a silent pass. (Fail closed.)
 */
export async function parseStructuredReport<T>(
  raw: string,
  validate: ValidateFunction,
  repair: (validationErrors: string) => Promise<string>,
): Promise<ParseOutcome<T>> {
  const first = validateRaw<T>(raw, validate);
  if (first.ok) return { ok: true, value: first.value, repaired: false };
  const repairedRaw = await repair(first.error);
  const second = validateRaw<T>(repairedRaw, validate);
  if (second.ok) return { ok: true, value: second.value, repaired: true };
  return { ok: false, error: `invalid structured output after repair: ${second.error}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/runtime/structured-output.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
npm test
git add src/pipeline/structured-output.ts tests/runtime/structured-output.test.ts
git commit -m "feat(pipeline): structured-output parsing with single repair retry"
```

---

### Task 3: Optional `review` block on DelegationSpec

**Files:**
- Modify: `src/protocol/delegation-spec.ts`
- Modify: `runtime/schemas/delegation-spec.v1.json`
- Test: extend existing spec-validator test file (`tests/runtime/spec-validator.test.ts` if present; otherwise create it)

**Interfaces:**
- Produces: `export interface ReviewConfig { reviewers: ReviewerKind[]; maxRounds: number }`, `export type ReviewerKind = "correctness" | "systems"`, `DelegationSpec.review?: ReviewConfig`, and `export function resolveReviewConfig(spec: DelegationSpec): ReviewConfig` (defaults `{ reviewers: ["correctness", "systems"], maxRounds: 2 }`).

- [ ] **Step 1: Write the failing test**

Locate the existing spec-validator tests (search: `grep -rl "validateSpec" tests/`). Add to that file (or create `tests/runtime/spec-validator-review.test.ts`); build a minimal valid spec the same way neighboring tests do, then:

```ts
import { describe, expect, it } from "vitest";
import { validateSpec } from "../../src/protocol/spec-validator.js";
import { resolveReviewConfig } from "../../src/protocol/delegation-spec.js";
// `makeValidSpec()` = copy the minimal valid spec literal used by the existing
// validateSpec tests in this file/directory (all eight required fields).

describe("delegation spec review block", () => {
  it("still accepts specs without a review block", () => {
    expect(validateSpec(makeValidSpec()).ok).toBe(true);
  });
  it("accepts a valid review block", () => {
    const spec = { ...makeValidSpec(), review: { reviewers: ["correctness"], maxRounds: 1 } };
    expect(validateSpec(spec).ok).toBe(true);
  });
  it("rejects unknown reviewer kinds and non-positive rounds", () => {
    expect(validateSpec({ ...makeValidSpec(), review: { reviewers: ["vibes"], maxRounds: 2 } }).ok).toBe(false);
    expect(validateSpec({ ...makeValidSpec(), review: { reviewers: ["systems"], maxRounds: 0 } }).ok).toBe(false);
  });
  it("resolveReviewConfig applies spec defaults", () => {
    expect(resolveReviewConfig(makeValidSpec() as never)).toEqual({
      reviewers: ["correctness", "systems"],
      maxRounds: 2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/spec-validator-review.test.ts`
Expected: FAIL — schema rejects the `review` property (or `resolveReviewConfig` not exported).

- [ ] **Step 3: Implement**

In `src/protocol/delegation-spec.ts` add:

```ts
export type ReviewerKind = "correctness" | "systems";

export interface ReviewConfig {
  reviewers: ReviewerKind[];
  maxRounds: number;
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfig = {
  reviewers: ["correctness", "systems"],
  maxRounds: 2,
};

export function resolveReviewConfig(spec: DelegationSpec): ReviewConfig {
  return spec.review ?? DEFAULT_REVIEW_CONFIG;
}
```

and add `review?: ReviewConfig;` to `interface DelegationSpec`.

In `runtime/schemas/delegation-spec.v1.json`, add to `properties` (do NOT add `review` to `required`):

```json
"review": {
  "type": "object",
  "additionalProperties": false,
  "required": ["reviewers", "maxRounds"],
  "properties": {
    "reviewers": {
      "type": "array",
      "minItems": 1,
      "items": { "enum": ["correctness", "systems"] }
    },
    "maxRounds": { "type": "integer", "minimum": 1, "maximum": 2 }
  }
}
```

If the schema sets top-level `additionalProperties: false`, this properties addition is mandatory for the block to validate at all — verify the top-level setting and keep it as-is.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/runtime/spec-validator-review.test.ts` → PASS. Then `npm test` → all green (proves existing specs unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/protocol/delegation-spec.ts runtime/schemas/delegation-spec.v1.json tests/runtime/spec-validator-review.test.ts
git commit -m "feat(protocol): optional review block on delegation spec"
```

---

### Task 4: Read-only Seatbelt policy for reviewer/verifier roles

**Pre-check:** `git status` — if `src/platform/sandbox/seatbelt.ts` / `tests/runtime/seatbelt.test.ts` carry unrelated uncommitted changes, STOP and ask the human to resolve them first (Global Constraints).

**Files:**
- Modify: `src/platform/sandbox/seatbelt.ts`
- Test: `tests/runtime/seatbelt.test.ts` (append)

**Interfaces:**
- Consumes: existing `SeatbeltPolicy` type, `buildSeatbeltProfile(policy)`, `wrapInvocationWithSeatbelt(invocation, policy)`.
- Produces: `export function buildReadOnlySeatbeltPolicy(args: { tempHome: string | null }): SeatbeltPolicy` — a policy whose writable subpaths contain ONLY the role's temp home (if any) plus whatever device paths (`/dev/null`, `/dev/tty`) the existing profile always allows; the worktree is deliberately absent.

- [ ] **Step 1: Write the failing test**

Append to `tests/runtime/seatbelt.test.ts`, following the file's existing style for constructing policies and asserting on `buildSeatbeltProfile` output:

```ts
describe("buildReadOnlySeatbeltPolicy", () => {
  it("grants no write access to the worktree", () => {
    const policy = buildReadOnlySeatbeltPolicy({ tempHome: "/tmp/role-home" });
    const profile = buildSeatbeltProfile(policy);
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/tmp/role-home")');
    expect(profile).not.toContain("worktrees"); // no worktree path is writable
  });
  it("works with no temp home at all", () => {
    const profile = buildSeatbeltProfile(buildReadOnlySeatbeltPolicy({ tempHome: null }));
    expect(profile).toContain("(deny file-write*)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/seatbelt.test.ts`
Expected: new tests FAIL — `buildReadOnlySeatbeltPolicy` is not exported. (Pre-existing tests must stay green.)

- [ ] **Step 3: Implement**

In `src/platform/sandbox/seatbelt.ts`, add (adapting field names to the actual `SeatbeltPolicy` shape in the file — do not change the existing type or existing functions):

```ts
/**
 * Policy for read-only roles (reviewers, clean-room verifier): the producer
 * may write only to its own temp home; the worktree and repo are readable
 * but never writable.
 */
export function buildReadOnlySeatbeltPolicy(args: { tempHome: string | null }): SeatbeltPolicy {
  return {
    // same base fields the edit-mode policy uses, but writable paths limited to:
    writableSubpaths: args.tempHome ? [args.tempHome] : [],
  } as SeatbeltPolicy; // fill remaining required SeatbeltPolicy fields per the existing type
}
```

Implementation note for the engineer: open the file, read the existing edit-mode policy construction (the call site in `src/runtime/attempt-runtime.ts` shows the full field set), and mirror it exactly minus the worktree writable entry. Delete the `as SeatbeltPolicy` cast once all required fields are populated — no type weakening (Global Constraints).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/runtime/seatbelt.test.ts` → PASS, all tests.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/platform/sandbox/seatbelt.ts tests/runtime/seatbelt.test.ts
git commit -m "feat(sandbox): read-only seatbelt policy for review roles"
```

---

### Task 5: Deterministic consolidator

**Files:**
- Create: `src/pipeline/consolidator.ts`
- Test: `tests/runtime/consolidator.test.ts`

**Interfaces:**
- Consumes: `RawFinding`, `Finding`, `ReviewReport` from `src/pipeline/report-types.ts` (Task 1).
- Produces:

```ts
export interface ConsolidationResult {
  findings: Finding[];            // stable ids F-001..., sorted by severity then location
  contradictions: string[];       // human-readable descriptions
}
export function consolidate(reports: { reviewer: string; report: ReviewReport }[]): ConsolidationResult;
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/consolidator.test.ts
import { describe, expect, it } from "vitest";
import { consolidate } from "../../src/pipeline/consolidator.js";
import type { RawFinding, ReviewReport } from "../../src/pipeline/report-types.js";

function finding(overrides: Partial<RawFinding>): RawFinding {
  return {
    severity: "minor", location: "src/a.ts:10", claim: "off-by-one in loop bound",
    evidence: "loop runs to <= n", reproduction: "n=0", requiredOutcome: "use < n",
    confidence: 0.8, ...overrides,
  };
}
function report(findings: RawFinding[]): ReviewReport {
  return { reportVersion: "1", verdict: findings.length ? "request-changes" : "approve", findings, coverageGaps: [] };
}

describe("consolidate", () => {
  it("dedupes identical findings across reviewers, preserving highest severity", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([finding({ severity: "major" })]) },
      { reviewer: "systems", report: report([finding({ severity: "blocker", claim: "  OFF-BY-ONE in loop bound " })]) },
    ]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].severity).toBe("blocker");
    expect(out.findings[0].reviewers.sort()).toEqual(["correctness", "systems"]);
  });

  it("assigns stable sequential ids ordered by severity then location", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([
        finding({ location: "src/z.ts:1", severity: "nit", claim: "typo" }),
        finding({ location: "src/a.ts:5", severity: "blocker", claim: "crash on null" }),
      ])},
    ]);
    expect(out.findings.map((f) => [f.id, f.severity])).toEqual([
      ["F-001", "blocker"],
      ["F-002", "nit"],
    ]);
  });

  it("is deterministic regardless of reviewer input order", () => {
    const a = { reviewer: "correctness", report: report([finding({ claim: "x" }), finding({ claim: "y", location: "src/b.ts:2" })]) };
    const b = { reviewer: "systems", report: report([finding({ claim: "z", location: "src/c.ts:3" })]) };
    expect(consolidate([a, b])).toEqual(consolidate([b, a]));
  });

  it("flags contradictions: same location, different required outcomes", () => {
    const out = consolidate([
      { reviewer: "correctness", report: report([finding({ claim: "bound wrong", requiredOutcome: "use < n" })]) },
      { reviewer: "systems", report: report([finding({ claim: "bound is fine but slow", requiredOutcome: "keep <= n, memoize instead" })]) },
    ]);
    expect(out.findings).toHaveLength(2); // different claims → not deduped
    expect(out.contradictions).toHaveLength(1);
    expect(out.contradictions[0]).toContain("src/a.ts:10");
  });

  it("never drops a blocker or major", () => {
    const blockers = [finding({ severity: "blocker", claim: "c1" }), finding({ severity: "major", claim: "c2", location: "src/b.ts:1" })];
    const out = consolidate([{ reviewer: "systems", report: report(blockers) }]);
    expect(out.findings.filter((f) => f.severity === "blocker" || f.severity === "major")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runtime/consolidator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/pipeline/consolidator.ts
import type { Finding, FindingSeverity, RawFinding, ReviewReport } from "./report-types.js";

const SEVERITY_ORDER: Record<FindingSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

export interface ConsolidationResult {
  findings: Finding[];
  contradictions: string[];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dedupe key: same location + same normalized claim = the same finding. */
function dedupeKey(f: RawFinding): string {
  return `${f.location} ${normalize(f.claim)}`;
}

export function consolidate(reports: { reviewer: string; report: ReviewReport }[]): ConsolidationResult {
  const byKey = new Map<string, { finding: RawFinding; reviewers: Set<string> }>();

  // Deterministic: process in sorted reviewer order, findings in given order.
  const sorted = [...reports].sort((a, b) => a.reviewer.localeCompare(b.reviewer));
  for (const { reviewer, report } of sorted) {
    for (const raw of report.findings) {
      const key = dedupeKey(raw);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { finding: { ...raw }, reviewers: new Set([reviewer]) });
        continue;
      }
      existing.reviewers.add(reviewer);
      // Preserve highest severity; never downgrade.
      if (SEVERITY_ORDER[raw.severity] < SEVERITY_ORDER[existing.finding.severity]) {
        existing.finding.severity = raw.severity;
      }
      existing.finding.confidence = Math.max(existing.finding.confidence, raw.confidence);
    }
  }

  const merged = [...byKey.values()].sort((a, b) =>
    SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]
    || a.finding.location.localeCompare(b.finding.location)
    || normalize(a.finding.claim).localeCompare(normalize(b.finding.claim)));

  const findings: Finding[] = merged.map((entry, index) => ({
    ...entry.finding,
    id: `F-${String(index + 1).padStart(3, "0")}`,
    reviewers: [...entry.reviewers].sort(),
  }));

  // Contradiction: distinct findings at the same location demanding different outcomes.
  const contradictions: string[] = [];
  const byLocation = new Map<string, Finding[]>();
  for (const f of findings) {
    const bucket = byLocation.get(f.location) ?? [];
    bucket.push(f);
    byLocation.set(f.location, bucket);
  }
  for (const [location, group] of byLocation) {
    const outcomes = new Set(group.map((f) => normalize(f.requiredOutcome)));
    if (group.length > 1 && outcomes.size > 1) {
      contradictions.push(
        `conflicting required outcomes at ${location}: ${group.map((f) => f.id).join(", ")}`);
    }
  }

  return { findings, contradictions };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/consolidator.test.ts` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npm test
git add src/pipeline/consolidator.ts tests/runtime/consolidator.test.ts
git commit -m "feat(pipeline): deterministic finding consolidator"
```

---

### Task 6: Gate evaluation

**Files:**
- Create: `src/pipeline/gates.ts`
- Test: `tests/runtime/gates.test.ts`

**Interfaces:**
- Consumes: `Finding`, `Disposition`, `VerificationReport` from `src/pipeline/report-types.ts`.
- Produces:

```ts
export interface GateInput {
  findings: Finding[];
  dispositions: Disposition[];              // latest round; may be empty when no findings
  verification: VerificationReport | null;  // null = clean-room verify missing → fail closed
  roundsUsed: number;
  maxRounds: number;
  artifactsValid: boolean;                  // all required artifacts present & schema-valid
  baselineDrift: boolean;
}
export interface GateResult {
  decisionReady: boolean;
  requiresHumanDecision: boolean;
  reasons: string[];                        // every unsatisfied gate, exhaustively
}
export function evaluateGates(input: GateInput): GateResult;
```

Gate semantics (from spec §Severity and gates, fail-closed reading):
- A blocker or major is **resolved** only by disposition `fixed` or `already_satisfied`. `rejected_with_evidence`, `blocked`, and `requires_human_decision` on a blocker/major → not decision-ready, `requiresHumanDecision: true` (runtime never waives findings). A `fixed` disposition without a `commit` is invalid → unresolved.
- Minor findings with any disposition are non-blocking; missing disposition on ANY finding (including minor) → not decision-ready (spec: "exactly one disposition per finding"). Nits never block even with no disposition.
- Not decision-ready when any of: unresolved blocker; unresolved major; `verification === null` or `verification.pass === false` ; `verification.testsDeleted > 0` or `testsSkipped > 0`; `!verification.workspaceClean`; `verification.scopeViolations.length > 0`; `!artifactsValid`; `baselineDrift`; `roundsUsed > maxRounds` (also sets `requiresHumanDecision`).

- [ ] **Step 1: Write the failing test (gate matrix)**

```ts
// tests/runtime/gates.test.ts
import { describe, expect, it } from "vitest";
import { evaluateGates, type GateInput } from "../../src/pipeline/gates.js";
import type { Disposition, Finding, VerificationReport } from "../../src/pipeline/report-types.js";

const OID = "a".repeat(40);

function finding(id: string, severity: Finding["severity"]): Finding {
  return { id, severity, reviewers: ["correctness"], location: "src/a.ts:1", claim: "c",
    evidence: "e", reproduction: "r", requiredOutcome: "o", confidence: 0.9 };
}
function fixed(findingId: string): Disposition {
  return { findingId, disposition: "fixed", evidence: "done", commit: OID };
}
function passVerification(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return { reportVersion: "1", pass: true, commandResults: [], workspaceClean: true,
    testsDeleted: 0, testsSkipped: 0, scopeViolations: [], ...overrides };
}
function base(overrides: Partial<GateInput> = {}): GateInput {
  return { findings: [], dispositions: [], verification: passVerification(),
    roundsUsed: 1, maxRounds: 2, artifactsValid: true, baselineDrift: false, ...overrides };
}

describe("evaluateGates", () => {
  it("clean run is decision-ready", () => {
    expect(evaluateGates(base())).toEqual({ decisionReady: true, requiresHumanDecision: false, reasons: [] });
  });

  it.each<[string, GateInput, boolean]>([
    ["undispositioned blocker", base({ findings: [finding("F-001", "blocker")] }), true],
    ["blocker rejected_with_evidence", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "rejected_with_evidence", evidence: "not a bug" }] }), true],
    ["major marked blocked", base({ findings: [finding("F-001", "major")],
      dispositions: [{ findingId: "F-001", disposition: "blocked", evidence: "needs infra" }] }), true],
    ["fixed blocker missing commit", base({ findings: [finding("F-001", "blocker")],
      dispositions: [{ findingId: "F-001", disposition: "fixed", evidence: "done" }] }), false],
    ["failed verification", base({ verification: passVerification({ pass: false }) }), false],
    ["missing verification (fail closed)", base({ verification: null }), false],
    ["deleted tests", base({ verification: passVerification({ testsDeleted: 1 }) }), false],
    ["newly skipped tests", base({ verification: passVerification({ testsSkipped: 2 }) }), false],
    ["dirty verify worktree", base({ verification: passVerification({ workspaceClean: false }) }), false],
    ["out-of-scope diff", base({ verification: passVerification({ scopeViolations: ["src/forbidden.ts"] }) }), false],
    ["invalid artifact", base({ artifactsValid: false }), false],
    ["baseline drift", base({ baselineDrift: false, ...{ baselineDrift: true } }), false],
    ["round cap exceeded", base({ roundsUsed: 3 }), true],
    ["minor without disposition", base({ findings: [finding("F-001", "minor")] }), false],
  ])("%s → not decision-ready (human=%s)", (_name, input, expectHuman) => {
    const out = evaluateGates(input);
    expect(out.decisionReady).toBe(false);
    expect(out.reasons.length).toBeGreaterThan(0);
    expect(out.requiresHumanDecision).toBe(expectHuman);
  });

  it("nits never block, even undispositioned", () => {
    const out = evaluateGates(base({ findings: [finding("F-001", "nit")] }));
    expect(out.decisionReady).toBe(true);
  });

  it("fixed blocker with commit + passing verification is decision-ready", () => {
    const out = evaluateGates(base({ findings: [finding("F-001", "blocker")], dispositions: [fixed("F-001")] }));
    expect(out.decisionReady).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run tests/runtime/gates.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/pipeline/gates.ts
import type { Disposition, Finding, VerificationReport } from "./report-types.js";

export interface GateInput {
  findings: Finding[];
  dispositions: Disposition[];
  verification: VerificationReport | null;
  roundsUsed: number;
  maxRounds: number;
  artifactsValid: boolean;
  baselineDrift: boolean;
}

export interface GateResult {
  decisionReady: boolean;
  requiresHumanDecision: boolean;
  reasons: string[];
}

const RESOLVING = new Set(["fixed", "already_satisfied"]);
const HUMAN_ROUTED = new Set(["rejected_with_evidence", "blocked", "requires_human_decision"]);

export function evaluateGates(input: GateInput): GateResult {
  const reasons: string[] = [];
  let requiresHumanDecision = false;

  const dispositionsById = new Map(input.dispositions.map((d) => [d.findingId, d]));

  for (const finding of input.findings) {
    if (finding.severity === "nit") continue; // nits never block
    const disposition = dispositionsById.get(finding.id);
    if (!disposition) {
      reasons.push(`finding ${finding.id} (${finding.severity}) has no disposition`);
      if (finding.severity === "blocker" || finding.severity === "major") requiresHumanDecision = true;
      continue;
    }
    if (finding.severity === "minor") continue; // dispositioned minors never block
    if (RESOLVING.has(disposition.disposition)) {
      if (disposition.disposition === "fixed" && !disposition.commit) {
        reasons.push(`finding ${finding.id} marked fixed without a commit`);
      }
      continue;
    }
    reasons.push(`unresolved ${finding.severity} ${finding.id}: ${disposition.disposition}`);
    if (HUMAN_ROUTED.has(disposition.disposition)) requiresHumanDecision = true;
  }

  const v = input.verification;
  if (v === null) reasons.push("verification report missing (fail closed)");
  else {
    if (!v.pass) reasons.push("clean-room verification failed");
    if (v.testsDeleted > 0) reasons.push(`${v.testsDeleted} test(s) deleted`);
    if (v.testsSkipped > 0) reasons.push(`${v.testsSkipped} test(s) newly skipped`);
    if (!v.workspaceClean) reasons.push("verify worktree dirty after checks");
    if (v.scopeViolations.length > 0) reasons.push(`out-of-scope diff: ${v.scopeViolations.join(", ")}`);
  }

  if (!input.artifactsValid) reasons.push("missing or invalid artifact");
  if (input.baselineDrift) reasons.push("candidate no longer based on approved baseline");
  if (input.roundsUsed > input.maxRounds) {
    reasons.push(`round cap exceeded (${input.roundsUsed} > ${input.maxRounds})`);
    requiresHumanDecision = true;
  }

  return { decisionReady: reasons.length === 0, requiresHumanDecision, reasons };
}
```

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/gates.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/pipeline/gates.ts tests/runtime/gates.test.ts
git commit -m "feat(pipeline): fail-closed gate evaluation"
```

---

### Task 7: Role prompt templates and role-spec builder

**Files:**
- Create: `src/pipeline/role-prompts.ts`
- Test: `tests/runtime/role-prompts.test.ts`

**Interfaces:**
- Consumes: `DelegationSpec`, `ReviewerKind` (protocol); `Finding` (report-types); JSON-schema files from Task 1 (embedded verbatim in prompts so producers know the exact output shape).
- Produces:

```ts
export type PipelineRole = "reviewer-correctness" | "reviewer-systems" | "fixer" | "verifier";
export interface RolePackage {
  spec: DelegationSpec;          // the original delegation spec
  baselineCommit: string;
  candidateCommit: string;
  candidateDiff: string;         // unified diff baseline..candidate
  testEvidence: string;          // serialized CommandOutcome summary from the implement phase
  findings?: Finding[];          // fixer only
}
export function renderRolePrompt(role: PipelineRole, pkg: RolePackage): string;
export function buildRoleSpec(role: PipelineRole, base: DelegationSpec, pkg: RolePackage): DelegationSpec;
```

`buildRoleSpec` produces a DelegationSpec the existing adapters can render via their normal `buildInvocation` five-part rendering: `objective` = one-line role charge; `context` = full `renderRolePrompt` output (spec, diff, evidence, schema, rubric); read-only roles get `writeAllowlist: []` and `forbiddenScope: ["**/*"]`; the fixer inherits the base spec's `writeAllowlist`/`forbiddenScope` unchanged; `producerPreferences`, `timeoutMs`, `verification` inherited from base; `review` stripped (roles never recurse).

- [ ] **Step 1: Write the failing test**

```ts
// tests/runtime/role-prompts.test.ts
import { describe, expect, it } from "vitest";
import { buildRoleSpec, renderRolePrompt, type RolePackage } from "../../src/pipeline/role-prompts.js";
import type { DelegationSpec } from "../../src/protocol/delegation-spec.js";

const spec: DelegationSpec = {
  specVersion: "1", objective: "Add rate limiting", context: "SECRET-IMPLEMENTER-REASONING must never appear",
  writeAllowlist: ["src/api/**"], forbiddenScope: ["src/auth/**"], successCriteria: ["429 after 10 req/s"],
  verification: [{ id: "unit", executable: "npm", args: ["test"], cwd: ".", timeoutMs: 60_000,
    network: "deny", expectedExitCodes: [0] }],
  executionMode: "edit", timeoutMs: 600_000, producerPreferences: ["codex"], expectedOutput: "candidate-patch",
};
const pkg: RolePackage = {
  spec, baselineCommit: "b".repeat(40), candidateCommit: "c".repeat(40),
  candidateDiff: "--- a/src/api/limit.ts\n+++ b/src/api/limit.ts\n+export const LIMIT = 10;",
  testEvidence: "unit: exit 0",
};

describe("renderRolePrompt", () => {
  it("reviewer prompt includes spec, diff, evidence, and the output schema", () => {
    const prompt = renderRolePrompt("reviewer-correctness", pkg);
    expect(prompt).toContain("Add rate limiting");
    expect(prompt).toContain("export const LIMIT = 10;");
    expect(prompt).toContain("unit: exit 0");
    expect(prompt).toContain('"reportVersion"');            // embedded schema
    expect(prompt).toContain("blocker");                    // severity rubric
    expect(prompt.toLowerCase()).toContain("read-only");    // confinement statement
  });
  it("fixer prompt includes findings and disposition vocabulary", () => {
    const prompt = renderRolePrompt("fixer", { ...pkg, findings: [{
      id: "F-001", reviewers: ["correctness"], severity: "blocker", location: "src/api/limit.ts:1",
      claim: "limit not enforced", evidence: "e", reproduction: "r", requiredOutcome: "enforce", confidence: 0.9 }] });
    expect(prompt).toContain("F-001");
    expect(prompt).toContain("rejected_with_evidence");
    expect(prompt).toContain("exactly one disposition per finding");
  });
  it("reviewer prompts never leak between roles: no findings in reviewer packages", () => {
    const prompt = renderRolePrompt("reviewer-systems", pkg);
    expect(prompt).not.toContain("F-001");
  });
});

describe("buildRoleSpec", () => {
  it("read-only roles get an empty write allowlist and universal forbidden scope", () => {
    const roleSpec = buildRoleSpec("reviewer-systems", spec, pkg);
    expect(roleSpec.writeAllowlist).toEqual([]);
    expect(roleSpec.forbiddenScope).toEqual(["**/*"]);
    expect(roleSpec.review).toBeUndefined();
  });
  it("fixer inherits the base scope", () => {
    const roleSpec = buildRoleSpec("fixer", spec, pkg);
    expect(roleSpec.writeAllowlist).toEqual(["src/api/**"]);
    expect(roleSpec.forbiddenScope).toEqual(["src/auth/**"]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/role-prompts.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/pipeline/role-prompts.ts
import { readFileSync } from "node:fs";
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import type { Finding } from "./report-types.js";
// Resolve runtime/schemas/ the same way src/protocol/schema-loader.ts does —
// reuse its path helper if exported; otherwise mirror its resolution exactly.

export type PipelineRole = "reviewer-correctness" | "reviewer-systems" | "fixer" | "verifier";

export interface RolePackage {
  spec: DelegationSpec;
  baselineCommit: string;
  candidateCommit: string;
  candidateDiff: string;
  testEvidence: string;
  findings?: Finding[];
}

const REVIEW_SCHEMA = readSchemaText("review-report.v1.json");
const FIX_SCHEMA = readSchemaText("fix-report.v1.json");
const VERIFY_SCHEMA = readSchemaText("verification-report.v1.json");

const CORRECTNESS_RUBRIC = `Review dimensions (adversarial — assume the candidate is wrong until proven):
- Acceptance criteria: is each success criterion demonstrably met?
- Missing or incorrect behavior; edge cases (empty, null, boundary, concurrent).
- Error handling at the right layer; no swallowed failures.
- Regression risk to existing behavior.
- Test adequacy: do the tests actually pin the claimed behavior?`;

const SYSTEMS_RUBRIC = `Review dimensions (adversarial — assume the candidate is wrong until proven):
- Security: injection, secrets, unsafe input handling.
- Authorization and trust boundaries.
- Concurrency: races, deadlocks, unsafe shared state.
- Resource lifecycle: leaks, unbounded growth, missing cleanup.
- Compatibility and performance regressions; architectural boundary violations.`;

const SEVERITY_RUBRIC = `Severity: blocker = must not ship; major = wrong/risky, needs fix or explicit human waiver;
minor = should fix, does not block; nit = style only, never blocks.
Every finding needs: exact location (path:line), a falsifiable claim, evidence,
a reproduction, the required outcome, and your confidence (0..1).`;

function commonSections(pkg: RolePackage): string {
  return [
    "## Delegation spec",
    `Objective: ${pkg.spec.objective}`,
    `Success criteria:\n${pkg.spec.successCriteria.map((c) => `- ${c}`).join("\n")}`,
    `Authorized write allowlist:\n${pkg.spec.writeAllowlist.map((p) => `- ${p}`).join("\n") || "- (none)"}`,
    `Forbidden scope:\n${pkg.spec.forbiddenScope.map((p) => `- ${p}`).join("\n") || "- (none)"}`,
    `## Baseline commit\n${pkg.baselineCommit}`,
    `## Candidate commit\n${pkg.candidateCommit}`,
    "## Candidate diff (baseline..candidate)",
    "```diff", pkg.candidateDiff, "```",
    `## Test evidence from the implementation run\n${pkg.testEvidence}`,
  ].join("\n\n");
}

function reviewerPrompt(rubric: string, pkg: RolePackage): string {
  return [
    "You are an untrusted, READ-ONLY code reviewer in a fresh session. You cannot edit files;",
    "the sandbox denies writes. Do not attempt to fix anything. Do not delegate to other agents.",
    "Judge ONLY the candidate diff against the delegation spec below.",
    commonSections(pkg),
    rubric,
    SEVERITY_RUBRIC,
    "## Output",
    "Reply with ONLY a fenced ```json block matching this schema exactly (no prose after it):",
    "```json", REVIEW_SCHEMA, "```",
  ].join("\n\n");
}

export function renderRolePrompt(role: PipelineRole, pkg: RolePackage): string {
  switch (role) {
    case "reviewer-correctness":
      return reviewerPrompt(CORRECTNESS_RUBRIC, pkg);
    case "reviewer-systems":
      return reviewerPrompt(SYSTEMS_RUBRIC, pkg);
    case "fixer":
      return [
        "You are an untrusted fixer in a fresh session working in the candidate worktree.",
        "You may edit ONLY within the authorized write allowlist. Do not perform final verification —",
        "a separate clean-room verifier will. Do not delegate to other agents or expand scope.",
        commonSections(pkg),
        "## Consolidated findings",
        JSON.stringify(pkg.findings ?? [], null, 2),
        "Return exactly one disposition per finding: fixed | already_satisfied |",
        "rejected_with_evidence | blocked | requires_human_decision.",
        "A `fixed` disposition MUST reference the commit that fixes it and include verification evidence.",
        "Never delete, weaken, or skip existing tests to satisfy a finding.",
        "## Output",
        "After committing your fixes, reply with ONLY a fenced ```json block matching this schema:",
        "```json", FIX_SCHEMA, "```",
      ].join("\n\n");
    case "verifier":
      return [
        "You are a READ-ONLY clean-room verifier in a fresh worktree at the final candidate commit.",
        "You cannot edit files. Re-run the authorized verification commands listed in the spec and report faithfully.",
        "Check for: deleted/weakened/skipped tests relative to baseline, dirty tree after tests,",
        "diff outside the authorized allowlist, and baseline drift. Report facts only.",
        commonSections(pkg),
        "## Output",
        "Reply with ONLY a fenced ```json block matching this schema:",
        "```json", VERIFY_SCHEMA, "```",
      ].join("\n\n");
  }
}

export function buildRoleSpec(role: PipelineRole, base: DelegationSpec, pkg: RolePackage): DelegationSpec {
  const readOnly = role !== "fixer";
  const { review: _stripped, ...rest } = base;
  return {
    ...rest,
    objective: `[pipeline role: ${role}] ${base.objective}`,
    context: renderRolePrompt(role, pkg),
    writeAllowlist: readOnly ? [] : base.writeAllowlist,
    forbiddenScope: readOnly ? ["**/*"] : base.forbiddenScope,
  };
}
```

`readSchemaText(name)` reads the schema file as a string using the same directory resolution as `schema-loader.ts` — if that module doesn't export its path helper, export it there in this task (a one-line `export`) rather than duplicating the resolution logic.

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/role-prompts.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/pipeline/role-prompts.ts tests/runtime/role-prompts.test.ts src/protocol/schema-loader.ts
git commit -m "feat(pipeline): role prompt templates and role-spec builder"
```

---

### Task 8: Role runner — one fresh producer process per role

**Files:**
- Create: `src/pipeline/role-runner.ts`
- Test: `tests/runtime/role-runner.test.ts`

**Interfaces:**
- Consumes: `probeAll` (`src/producers/capability-probe.ts`), `route` (`src/producers/routing-policy.ts`), `ProducerRegistry`, adapter `buildInvocation`/`normalizeEvents`, `wrapInvocationWithSeatbelt` + `buildReadOnlySeatbeltPolicy` (Task 4), the process supervisor used by `attempt-runtime.ts` (`src/platform/process-supervisor.ts`), `buildRoleSpec` (Task 7), `FailureClassification`.
- Produces:

```ts
export interface RoleRunArgs {
  role: PipelineRole;
  baseSpec: DelegationSpec;
  pkg: RolePackage;
  worktreePath: string;           // reviewers/fixer: candidate worktree; verifier: fresh clean-room worktree
  ps: PlatformServices;
  registry: ProducerRegistry;
  runId: string;
  env?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
}
export interface RoleRunResult {
  ok: boolean;
  rawOutput: string;              // producerSummary/stdout for structured-output parsing
  failure: FailureClassification | null;
  producerId: string | null;
}
export async function runRole(args: RoleRunArgs): Promise<RoleRunResult>;
```

Behavior: build role spec → `probeAll(registry, ...)` → `route(spec.producerPreferences, reports)` → adapter `buildInvocation(roleSpec, ctx)` with a fresh temp home (fresh session — never resume) → if role is read-only, require an OS sandbox backend and wrap with `buildReadOnlySeatbeltPolicy`; **if no OS backend is available for a read-only role, return `{ ok: false, failure: "sandbox-violation" }` without spawning** (fail closed) → supervise → `normalizeEvents` → map failures through `classifyFailure`. Internally retry ONCE on process failure with the identical input in a new session (Global Constraints); a second failure returns `ok: false`.

- [ ] **Step 1: Write the failing test**

Use the repo's established `FakeAdapter` pattern (copy the `FakeAdapterOptions` shape from `tests/runtime/attempt-runtime.test.ts` — it already supports `exitCode`, `spawnFailure`, `writeConfinementBackend`, canned stdout). Key cases:

```ts
// tests/runtime/role-runner.test.ts — structure; FakeAdapter copied from attempt-runtime.test.ts
import { describe, expect, it } from "vitest";
import { runRole } from "../../src/pipeline/role-runner.js";
import { ProducerRegistry } from "../../src/producers/producer-registry.js";
// ... FakeAdapter + makeSpec/makePkg helpers as in attempt-runtime.test.ts ...

describe("runRole", () => {
  it("returns producer output for a healthy read-only reviewer run (seatbelt available)", async () => {
    // FakeAdapter emits a valid review-report JSON on stdout; capability report advertises an OS backend
    const result = await runRole(argsWith({ adapter: healthyAdapter, role: "reviewer-correctness" }));
    expect(result.ok).toBe(true);
    expect(result.rawOutput).toContain('"reportVersion"');
  });

  it("fails closed when a read-only role has no OS sandbox backend", async () => {
    // capability report with writeConfinementBackend: null and no macos-seatbelt availability
    const result = await runRole(argsWith({ adapter: noSandboxAdapter, role: "reviewer-systems" }));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("sandbox-violation");
  });

  it("retries exactly once on process failure, then reports failure", async () => {
    // adapter whose invocation exits non-zero both times; count spawns via the fake
    const result = await runRole(argsWith({ adapter: alwaysFailingAdapter, role: "fixer" }));
    expect(result.ok).toBe(false);
    expect(alwaysFailingAdapter.spawnCount).toBe(2);
  });

  it("recovers when the retry succeeds", async () => {
    const result = await runRole(argsWith({ adapter: failsOnceAdapter, role: "reviewer-correctness" }));
    expect(result.ok).toBe(true);
    expect(failsOnceAdapter.spawnCount).toBe(2);
  });
});
```

(Write the helpers concretely by copying the fake-adapter scaffolding from `tests/runtime/attempt-runtime.test.ts` — same `ProbeContext`/`CapabilityReport` construction, temp worktree via `mkdtemp`, `NODE_ENV=test` env handling in `beforeEach`/`afterEach`.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/role-runner.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/pipeline/role-runner.ts`**

```ts
// src/pipeline/role-runner.ts
import type { DelegationSpec } from "../protocol/delegation-spec.js";
import { classifyFailure, type FailureClassification } from "../protocol/attempt-result.js";
import type { ProducerRegistry } from "../producers/producer-registry.js";
import { probeAll } from "../producers/capability-probe.js";
import { route } from "../producers/routing-policy.js";
import { buildReadOnlySeatbeltPolicy, wrapInvocationWithSeatbelt } from "../platform/sandbox/seatbelt.js";
import { selectSandboxBackend } from "../platform/sandbox/backends.js";
import { buildRoleSpec, type PipelineRole, type RolePackage } from "./role-prompts.js";
// import PlatformServices type and the same `supervise` entrypoint attempt-runtime.ts uses
// (read attempt-runtime.ts and import identically — do not re-implement supervision).

export interface RoleRunArgs { /* as in Interfaces block above */ }
export interface RoleRunResult { /* as in Interfaces block above */ }

const READ_ONLY_ROLES = new Set<PipelineRole>(["reviewer-correctness", "reviewer-systems", "verifier"]);

export async function runRole(args: RoleRunArgs): Promise<RoleRunResult> {
  const roleSpec = buildRoleSpec(args.role, args.baseSpec, args.pkg);
  const reports = await probeAll(args.registry /*, same args attempt-runtime passes */);
  const routing = route(roleSpec.producerPreferences, reports);
  if (routing.producerId === null) {
    return { ok: false, rawOutput: "", producerId: null,
      failure: routing.reason === "authentication-required" ? "authentication-required" : "unavailable" };
  }
  const adapter = args.registry.get(routing.producerId)!;
  const report = reports.find((r) => /* report for routing.producerId */ true)!;

  const readOnly = READ_ONLY_ROLES.has(args.role);
  if (readOnly) {
    const selection = selectSandboxBackend(report);
    if (!("backend" in selection) || selection.backend === null || selection.backend.kind !== "os") {
      // Fail closed: never run an unconfined read-only role.
      return { ok: false, rawOutput: "", producerId: routing.producerId, failure: "sandbox-violation" };
    }
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const tempHome = await makeFreshTempHome(args.ps, `${args.runId}-${args.role}-${attempt}`);
    const ctx = { worktreePath: args.worktreePath, runId: args.runId, tempHome,
      capabilityReport: report, executable: report.executable ?? adapter.producerId };
    let invocation = adapter.buildInvocation(roleSpec, ctx);
    if (readOnly) {
      invocation = wrapInvocationWithSeatbelt(invocation, buildReadOnlySeatbeltPolicy({ tempHome }));
    }
    const exit = await supervise(invocation, { ps: args.ps, timeoutMs: roleSpec.timeoutMs,
      abortSignal: args.abortSignal, env: args.env });
    const normalized = adapter.normalizeEvents({ stdout: exit.stdout, stderr: exit.stderr, exit });
    if (normalized.ok) {
      return { ok: true, rawOutput: normalized.producerSummary ?? exit.stdout,
        producerId: routing.producerId, failure: null };
    }
    if (attempt === 2) {
      return { ok: false, rawOutput: exit.stdout, producerId: routing.producerId,
        failure: classifyFailure({ "producer-failure": true }) };
    }
    // Retry once with the identical input package in a new session (fresh tempHome).
  }
  throw new Error("unreachable");
}
```

Implementation notes (mandatory): import `supervise`, temp-home creation, and env construction (`buildEnvironment`) from the exact modules `attempt-runtime.ts` uses — open that file and mirror its call sites verbatim rather than the sketches above; keep `classifyFailure` signals faithful (timeout → `timeout`, spawn error → `spawn-failure`). No re-implementation of supervision, environment policy, or redaction.

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/role-runner.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
npm test
git add src/pipeline/role-runner.ts tests/runtime/role-runner.test.ts
git commit -m "feat(pipeline): fresh-session role runner with fail-closed confinement"
```

---

### Task 9: Pipeline orchestrator (round loop + clean-room verify + evidence bundle)

**Files:**
- Create: `src/pipeline/pipeline-runtime.ts`
- Modify: `src/runtime/artifact-store.ts` (pipeline artifact persistence)
- Test: `tests/runtime/pipeline-runtime.test.ts`

**Interfaces:**
- Consumes: `runAttempt`/`AttemptRuntimeDependencies` (implement phase, unchanged), `runRole` (Task 8), `parseStructuredReport` (Task 2), `consolidate` (Task 5), `evaluateGates` (Task 6), `resolveReviewConfig` (Task 3), `WorktreeManager`, `structuralVerify`/`projectVerify` (`src/verify/`), `loadSchemas`, `ArtifactStore`.
- Produces:

```ts
export interface PipelineRound {
  round: number;
  reviews: { reviewer: string; report: ReviewReport }[];
  consolidated: ConsolidationResult;
  fix: FixReport | null;               // null when no blocking findings → no fix phase
}
export interface PipelineResult {
  runId: string;
  status: "decision-ready" | "human-decision-required" | "failed";
  attempt: AttemptResult;              // implement-phase result
  rounds: PipelineRound[];
  verification: VerificationReport | null;
  gate: GateResult;
  finalCandidateCommit: string;
}
export async function runPipeline(
  checkoutPath: string,
  spec: DelegationSpec,
  deps: PipelineDependencies,          // AttemptRuntimeDependencies + { registry; roleRunner?; onPhase? }
): Promise<PipelineResult>;
```

ArtifactStore additions (same hardened write path as `writeResult` — atomic, redaction-guarded, schema-validated):

```ts
async writePipelineArtifact(name: string, value: unknown): Promise<void>  // pipeline/<name>.json
async readPipelineArtifact<T>(runId: string, name: string): Promise<T | null>
```

Artifact names: `round-<n>-review-<reviewer>.json`, `round-<n>-consolidated.json`, `round-<n>-fix.json`, `verification.json`, `pipeline-result.json`.

Control flow (deterministic, in code — no agent decides transitions):

1. **Implement:** `await deps.runAttempt ?? runAttempt(checkoutPath, spec, deps)`. On non-`verified-candidate` status → return `status: "failed"` with the attempt result.
2. **Round loop** (`round = 1..maxRounds` from `resolveReviewConfig(spec)`):
   a. Build `RolePackage` from the candidate: diff via `git diff baseline..candidate` in the worktree, test evidence from the attempt's `commandOutcomes`.
   b. Run both reviewers **in parallel** (`Promise.all`) via `runRole`; parse each with `parseStructuredReport` (repair = one fresh `runRole` call passing the validation errors appended to the prompt). Parse failure after repair → phase failed → `status: "failed"`.
   c. `consolidate(...)`; persist artifacts. If no findings with severity ≥ minor and both verdicts `approve` → break to verify with `fix: null`.
   d. **Fix:** `runRole("fixer", ...)` in the same candidate worktree; parse `FixReport`; persist. Update candidate commit from `fixReport.candidateCommit` (verify the commit exists in the worktree via `git cat-file -e`; missing → `status: "failed"`).
   e. Loop continues → next round re-reviews the fixed commit with brand-new sessions.
   f. If the loop exits by exhausting `maxRounds` with unresolved blocking findings → skip further fixing; proceed to verify then gates (which will set `requiresHumanDecision`).
3. **Clean-room verify:** create a FRESH worktree at the final candidate commit via `WorktreeManager`; run `structuralVerify` + `projectVerify` there (read-only checks; the deterministic runtime — not a producer — computes `workspaceClean` via `git status --porcelain`, `scopeViolations` via allowlist match on `git diff --name-only baseline..candidate`, `testsDeleted`/`testsSkipped` via `detectWeakenedTests(diffText)`); baseline drift = `git merge-base --is-ancestor baseline candidate` failing. Build `VerificationReport` deterministically. (v1 decision: the verifier is deterministic runtime code reusing the existing verifiers, not a fourth producer role — the spec's clean-room requirements are all mechanically checkable, and this removes a structured-output failure mode. The `verifier` role prompt from Task 7 stays available for a future agent-assisted verify.)
4. **Gates:** `evaluateGates(...)` → map to `status`: reasons empty → `decision-ready`; `requiresHumanDecision` → `human-decision-required`; else `failed` stays failed only for phase failures — gate failures with no human routing also return `human-decision-required` (fail closed, never auto-accept).
5. Persist `pipeline-result.json`; return the bundle. **Never** call decide/integrate.

`detectWeakenedTests` (include verbatim in `pipeline-runtime.ts`):

```ts
export function detectWeakenedTests(diff: string): { testsDeleted: number; testsSkipped: number } {
  let testsDeleted = 0;
  let testsSkipped = 0;
  for (const line of diff.split("\n")) {
    if (/^deleted file mode/.test(line)) {
      // attribute to tests when the preceding diff header names a test file
      if (currentFileIsTest) testsDeleted++;
    }
    if (/^diff --git a\/(\S+)/.test(line)) {
      currentFileIsTest = /(^|\/)tests?\/|\.test\.|\.spec\./.test(line);
    }
    if (currentFileIsTest && /^\+.*\b(it|test|describe)\.(skip|todo)\(/.test(line)) testsSkipped++;
    if (currentFileIsTest && /^\+.*\bxit\(|^\+.*\bxdescribe\(/.test(line)) testsSkipped++;
  }
  return { testsDeleted, testsSkipped };
}
// (declare `let currentFileIsTest = false;` before the loop)
```

- [ ] **Step 1: Write the failing tests** — `tests/runtime/pipeline-runtime.test.ts` with a stubbed `roleRunner` injected through `PipelineDependencies` (so no real producers spawn) and a fake `runAttempt` returning a canned `verified-candidate` `AttemptResult`, on a temp git repo (copy `initRepo()` from `tests/runtime/e2e-vertical-slice.test.ts`). Cases:

```ts
// concrete test skeleton — fill helpers from e2e-vertical-slice.test.ts patterns
describe("runPipeline", () => {
  it("clean review round → decision-ready, no fix phase", async () => {
    // both stub reviewers return verdict "approve" with zero findings
    const result = await runPipeline(repo, spec, depsWith({ reviews: [approve, approve] }));
    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].fix).toBeNull();
  });

  it("blocker → fix → clean re-review → decision-ready in two rounds", async () => {
    // round 1: one blocker; fixer commits and reports fixed; round 2: both approve
    const result = await runPipeline(repo, spec, depsWith({
      reviews: [[blockerReview, approve], [approve, approve]], fixes: [fixedReport] }));
    expect(result.status).toBe("decision-ready");
    expect(result.rounds).toHaveLength(2);
  });

  it("round cap exceeded → human-decision-required, never auto-accept", async () => {
    // every round returns the same blocker; fixer keeps reporting blocked
    const result = await runPipeline(repo, spec, depsWith({
      reviews: [[blockerReview, approve], [blockerReview, approve]], fixes: [blockedReport, blockedReport] }));
    expect(result.status).toBe("human-decision-required");
    expect(result.gate.requiresHumanDecision).toBe(true);
  });

  it("invalid reviewer output twice (initial + repair) → failed", async () => {
    const result = await runPipeline(repo, spec, depsWith({ reviews: [["not json", "not json either"]] }));
    expect(result.status).toBe("failed");
  });

  it("weakened tests in candidate diff → not decision-ready", async () => {
    // candidate commit adds `it.skip(` to a test file; reviewers approve
    const result = await runPipeline(repo, specWithSkippedTest, depsWith({ reviews: [approve, approve] }));
    expect(result.status).toBe("human-decision-required");
    expect(result.verification?.testsSkipped).toBeGreaterThan(0);
  });

  it("persists round and verification artifacts to the ArtifactStore", async () => {
    await runPipeline(repo, spec, depsWith({ reviews: [approve, approve] }));
    // assert pipeline/round-1-review-correctness.json etc. exist under the run dir
  });
});

describe("detectWeakenedTests", () => {
  it("counts deleted test files and added .skip calls", () => {
    const diff = [
      "diff --git a/tests/foo.test.ts b/tests/foo.test.ts",
      "deleted file mode 100644",
      "diff --git a/tests/bar.test.ts b/tests/bar.test.ts",
      "+it.skip(\"was passing\", () => {});",
    ].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 1, testsSkipped: 1 });
  });
  it("ignores skips in non-test files", () => {
    const diff = ["diff --git a/src/foo.ts b/src/foo.ts", "+it.skip(", ""].join("\n");
    expect(detectWeakenedTests(diff)).toEqual({ testsDeleted: 0, testsSkipped: 0 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/pipeline-runtime.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/pipeline/pipeline-runtime.ts` per the control flow above, plus the two `ArtifactStore` methods (mirror `writeDecision`'s hardened write path; artifacts under `pipeline/` inside the run directory). Keep every state transition in plain code; producers only produce reports.

- [ ] **Step 4: Run tests** — `npx vitest run tests/runtime/pipeline-runtime.test.ts` → PASS; then `npm test` (ArtifactStore changes must not break existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/pipeline-runtime.ts src/runtime/artifact-store.ts tests/runtime/pipeline-runtime.test.ts
git commit -m "feat(pipeline): deterministic round loop, clean-room verify, evidence bundle"
```

---

### Task 10: `delegatePipeline` MCP tool wiring

**Files:**
- Modify: `src/mcp/tools.ts` (add `handleDelegatePipeline`)
- Modify: `src/mcp/server.ts` (register the tool)
- Test: `tests/runtime/tools.test.ts` (append)

**Interfaces:**
- Consumes: `runPipeline` (Task 9), `validateSpec`, `withRepoLock`, `checkVersionCompat` — mirror `handleDelegate`'s body exactly (same lock, same spec-string `JSON.parse` tolerance, same protocol-version check), substituting `runPipeline` for `executeAttempt`.
- Produces:

```ts
export async function handleDelegatePipeline(
  checkoutPath: string,
  input: unknown,
  deps: ToolDependencies = {},
): Promise<PipelineResult | ToolErrorResult>;
```

`ToolDependencies` gains `runPipeline?: typeof executePipeline;` for test injection (matching the existing `runAttempt?` seam).

- [ ] **Step 1: Write the failing test** — append to `tests/runtime/tools.test.ts`, following its existing `handleDelegate` test style:

```ts
describe("handleDelegatePipeline", () => {
  it("validates the spec and returns the pipeline result", async () => {
    const fakeResult = { runId: "r1", status: "decision-ready" } as PipelineResult;
    const runPipeline = vi.fn(async () => fakeResult);
    const out = await handleDelegatePipeline(repo, validSpec, { ...baseDeps, runPipeline });
    expect(out).toBe(fakeResult);
    expect(runPipeline).toHaveBeenCalledOnce();
  });
  it("rejects an invalid spec without invoking the pipeline", async () => {
    const runPipeline = vi.fn();
    const out = await handleDelegatePipeline(repo, { nope: true }, { ...baseDeps, runPipeline });
    expect(out).toHaveProperty("error");
    expect(runPipeline).not.toHaveBeenCalled();
  });
  it("accepts the spec as a JSON string (schemaless-client tolerance)", async () => {
    const runPipeline = vi.fn(async () => ({ status: "decision-ready" }) as PipelineResult);
    const out = await handleDelegatePipeline(repo, JSON.stringify(validSpec), { ...baseDeps, runPipeline });
    expect(out).not.toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/runtime/tools.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement.** In `tools.ts`, copy `handleDelegate`'s body (spec parse/validate, version compat, `withRepoLock`) and call `runPipeline`. In `server.ts` register:

```ts
server.registerTool(
  "delegatePipeline",
  {
    title: "Delegate with fresh-context review pipeline",
    description:
      "Run the full write→review→fix→verify loop; every role in a fresh isolated producer session. Returns an evidence bundle; never merges — follow with decideCandidate/integrateCandidate.",
    inputSchema: { checkoutPath: z.string(), spec: z.unknown(), protocolVersion: z.string().optional() },
    outputSchema: pipelineOutput, // zod shape mirroring PipelineResult
  },
  async ({ checkoutPath, spec, protocolVersion }) =>
    toolOutput(await handleDelegatePipeline(checkoutPath, { spec, protocolVersion }, dependencies)),
);
```

(Match the exact argument plumbing `delegate` uses for `protocolVersion` — read its registration and mirror it.)

- [ ] **Step 4: Run tests** — `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/server.ts tests/runtime/tools.test.ts
git commit -m "feat(mcp): delegatePipeline tool"
```

---

### Task 11: End-to-end pipeline test in a temporary Git repository

**Files:**
- Create: `tests/runtime/e2e-pipeline.test.ts`

**Interfaces:**
- Consumes: `handleDelegatePipeline`, `handleDecideCandidate`, `handleIntegrateCandidate`; the `initRepo()`/env-isolation scaffolding from `tests/runtime/e2e-vertical-slice.test.ts`; a scripted `FakeAdapter` that plays all roles.

- [ ] **Step 1: Write the test.** Copy `initRepo()`, `beforeEach` (`CLAUDE_PLUGIN_DATA` → fresh temp dir, `NODE_ENV=test`), and `afterEach` cleanup from `tests/runtime/e2e-vertical-slice.test.ts`. Build one scripted `FakeAdapter` whose `buildInvocation` inspects the rendered role prompt (`[pipeline role: ...]` marker in the objective) and replays a queue: implement (edits `a.txt`, exits 0) → reviewer-correctness (one `major` finding JSON) → reviewer-systems (approve JSON) → fixer (commits the fix, emits `FixReport` JSON) → round-2 reviewers (both approve). Passing fake verifier as in the vertical-slice test. Drive the full lifecycle:

```ts
it("full lifecycle: delegatePipeline → decide → integrate", async () => {
  const result = await handleDelegatePipeline(repo, spec, deps);
  expect(result).toMatchObject({ status: "decision-ready" });
  expect((result as PipelineResult).rounds).toHaveLength(2);

  const decided = await handleDecideCandidate((result as PipelineResult).runId, "accepted", deps);
  expect(decided).toEqual({ recorded: true });

  const manifest = await store.readManifest((result as PipelineResult).runId);
  const integrated = await handleIntegrateCandidate(
    (result as PipelineResult).runId, manifest!.candidateManifestHash, deps);
  expect(integrated).toMatchObject({ integration: "applied" });
});

it("pipeline with an unfixable blocker ends at human decision and integrate refuses", async () => {
  const result = await handleDelegatePipeline(repo, spec, depsWithStubbornBlocker);
  expect(result).toMatchObject({ status: "human-decision-required" });
});
```

- [ ] **Step 2: Run** — `npx vitest run tests/runtime/e2e-pipeline.test.ts`. Debug until PASS (this test validates integration, not new units — failures here are wiring bugs in Tasks 8–10; fix them in those modules).

- [ ] **Step 3: Full suite** — `npm test` → all green.

- [ ] **Step 4: Commit**

```bash
git add tests/runtime/e2e-pipeline.test.ts
git commit -m "test(pipeline): end-to-end lifecycle in temporary git repository"
```

---

### Task 12: Update `skills/delegate` skill

**Files:**
- Modify: `skills/delegate/SKILL.md`

**Interfaces:**
- Consumes: the existing SKILL.md structure (frontmatter, `claude-architect-protocol` block with `PROTOCOL_VERSION: 1.0.0`, lifecycle instructions).

- [ ] **Step 1: Edit SKILL.md.** Keep `PROTOCOL_VERSION` untouched (the spec change is backward-compatible; only bump if `checkVersionCompat` policy in `src/protocol/versions.ts` demands it for additive spec fields — check that file first). Add, after the existing lifecycle description, a routing rule and pipeline lifecycle section:

```markdown
## Choosing delegate vs delegatePipeline

Use `delegatePipeline` by default for non-trivial tasks — anything with
meaningful correctness or systems risk (multiple files, state, concurrency,
security surface, or behavior existing code depends on). Use plain `delegate`
only for trivial tasks (typo-level fixes, single obvious one-liners, doc-only
edits).

## Pipeline lifecycle

1. Build the Delegation Spec exactly as for `delegate`. Optionally add:

   ```yaml
   review:
     reviewers: [correctness, systems]   # default
     max_rounds: 2                        # default
   ```

2. Call `mcp__plugin_claude-architect_runtime__delegatePipeline` with
   `checkoutPath`, `spec`, `protocolVersion: "1.0.0"`.
3. Read the returned evidence bundle: attempt result, per-round review
   reports and consolidated findings, fix dispositions, verification report,
   and gate reasons.
   - `status: "decision-ready"` — review the evidence yourself, then call
     `decideCandidate` and, if accepted, `integrateCandidate` (candidate
     `manifestHash` as `expectedArtifactHash`).
   - `status: "human-decision-required"` — present the gate reasons,
     unresolved findings, and dispositions to the human verbatim. Never
     accept on their behalf.
   - `status: "failed"` — report the failure classification; retry or
     re-scope per the normal delegate failure guidance.
4. The pipeline never merges and never waives findings; you and the human
   remain the only decision-makers.
```

- [ ] **Step 2: Verify** — `npm test` (protocol-version compat tests, if any, still green); proofread the skill renders correctly (`gh markdown-preview skills/delegate/SKILL.md` optional).

- [ ] **Step 3: Commit**

```bash
git add skills/delegate/SKILL.md
git commit -m "docs(skills): route non-trivial delegations through delegatePipeline"
```

---

## Self-Review Notes

- **Spec coverage:** invariants 1–4 → Tasks 7/8 (fresh sessions, read-only confinement, artifact-only packages — reviewer packages contain only spec/baseline/diff/evidence, never transcripts), Task 9 (artifact persistence, fail-closed statuses), Task 6 (gates). Pipeline steps 1–7 → Task 9 control flow. Severity/gates section → Tasks 1 & 6. Structured outputs + repair → Tasks 1 & 2. `review` block → Task 3. Failure handling (retry-once, reuse classification) → Task 8. New-code list → Tasks 1–10; skills update → Task 12. Testing section (fake producers, gate matrix, consolidator units, temp-repo e2e) → Tasks 5/6/8/9/11. Out-of-scope items are nowhere implemented.
- **Deliberate v1 decision (flag to reviewer):** clean-room verification is deterministic runtime code reusing `structuralVerify`/`projectVerify` rather than a fourth producer role (rationale in Task 9). The spec's verifier checks are all mechanically checkable; the verifier prompt template still ships (Task 7) for future use. If the human wants an agent verifier in v1, extend Task 9 step 3 to call `runRole("verifier", ...)` and cross-check its report against the deterministic one.
- **Type consistency:** `Finding.id` format `F-\d{3,}` consistent across schema (Task 1), consolidator (Task 5), gates tests (Task 6), fixer prompt (Task 7). `RoleRunResult.rawOutput` feeds `parseStructuredReport` (Tasks 2→9). `resolveReviewConfig` defaults match the spec verbatim.
