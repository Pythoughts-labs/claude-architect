# Delegation Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode a zero-prompt delegation loop — delegate → auto-review → auto-accept on green → commit on a feature branch → cleanup → push + PR — via skill text, an AGENTS.md invariant amendment, and a permissions allowlist. No runtime code changes.

**Architecture:** Policy lives in `skills/delegate/SKILL.md` (new "Autopilot loop" section); the trust-invariant amendment in `AGENTS.md`; prompt suppression in a new project `.claude/settings.json`. Spec: `docs/superpowers/specs/2026-07-20-delegation-autopilot-design.md`.

**Tech Stack:** Markdown, Claude Code settings JSON, existing validators (`scripts/validate-release.sh`, `claude plugin validate .`).

## Global Constraints

- No runtime source, schema, or protocol changes; protocol marker stays `1.3.0`.
- Never AI co-author trailers or generated-by footers in commits.
- Auto-accept only when ALL green gates hold: `decision-ready` + verification passed + no blocking reviewer findings + positive advisor verdict.
- Commits/pushes only on feature branches; merging to `main` is human-only.
- Any non-green signal → stop, present evidence verbatim, human decides.

---

### Task 1: AGENTS.md trust-invariant amendment

**Files:**
- Modify: `AGENTS.md:60` (the "Only a human can accept a candidate" bullet in "Non-negotiable trust invariants")

**Interfaces:**
- Produces: the amended invariant wording that Task 2's skill text must match exactly in substance.

- [ ] **Step 1: Replace the invariant bullet**

Replace this line:

```markdown
- Only a human can accept a candidate. Agents may recommend a decision but cannot make it for the human.
```

with:

```markdown
- Agents may record `accepted` for a candidate only when every objective green gate holds: pipeline `decision-ready`, verification passed, no blocking independent-review findings, and a positive advisor verdict. Any non-green signal requires a human decision.
- Auto-accepted work may be committed and pushed only on a feature branch and proposed via pull request. Merging to `main` is human-only; the PR is the whole-branch human review surface.
```

- [ ] **Step 2: Verify no other file contradicts the old wording**

Run: `grep -rn "Only a human can accept" --include="*.md" .`
Expected: no matches. If `skills/` or `agents/` files repeat the old absolute wording, note them for Task 2 (SKILL.md) — do not edit unlisted files; if a file outside Task 2's scope contradicts, stop and report.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: permit gated auto-accept; move human boundary to PR merge"
```

### Task 2: SKILL.md autopilot loop section

**Files:**
- Modify: `skills/delegate/SKILL.md` — (a) pipeline lifecycle step 3 (`decision-ready` branch, lines ~149-152), (b) insert new `## Autopilot loop` section immediately after the `## Pipeline lifecycle` section (after line ~159, before `## Sliced pipeline`).

**Interfaces:**
- Consumes: Task 1's amended invariant (wording must agree).
- Produces: the autopilot procedure Task 4 dogfoods.

- [ ] **Step 1: Update the decision-ready bullet**

In `## Pipeline lifecycle`, replace:

```markdown
   - `status: "decision-ready"` — review the evidence yourself, then call
     `decideCandidate` with `checkoutPath` and the run id and, if accepted,
     `integrateCandidate` with `checkoutPath`, the run id, and the candidate
     `manifestHash` as `expectedArtifactHash`.
```

with:

```markdown
   - `status: "decision-ready"` — review the evidence yourself. If every
     autopilot green gate holds (see Autopilot loop), record
     `decideCandidate` `accepted` and call `integrateCandidate` with
     `checkoutPath`, the run id, and the candidate `manifestHash` as
     `expectedArtifactHash` without pausing for human approval. Otherwise
     present the evidence and let the human decide.
```

- [ ] **Step 2: Insert the Autopilot loop section**

Insert after the `## Pipeline lifecycle` section (immediately before `## Sliced pipeline`):

```markdown
## Autopilot loop

The default end-to-end flow for a feature made of one or more delegated
tasks. It runs without pausing for human approval between steps; the human
decision moves to pull-request review.

1. **Branch** — create or reuse a `feat/<topic>` branch off `main` in the
   checkout. Never target `main` directly for autopilot commits.
2. **Delegate** — author a Delegation Spec per task and run it through
   `delegatePipeline`.
3. **Green gate** — auto-accept is permitted only when ALL hold:
   - pipeline status is `decision-ready`;
   - the verification report passed;
   - the consolidated review findings contain no blocking finding;
   - the advisor verdict is positive.
4. **Accept + integrate + commit** — on green, immediately call
   `decideCandidate` (`accepted`) then `integrateCandidate` with the exact
   candidate `manifestHash`, then commit the staged tree on the feature
   branch in the repository's commit style. Never add AI co-author trailers
   or generated-by footers.
5. **Repeat** — each remaining task becomes one reviewed commit.
6. **Cleanup sweep** — after the loop, run `doctor` and confirm no stale
   producer worktrees or leaked locks remain; surface any cleanup failure
   in the report rather than hiding it.
7. **Ship** — push the feature branch and open a pull request. The human
   merges or rejects the PR; merging to `main` is human-only.

**Hard stops.** The loop halts at the failing task, presents the evidence
verbatim, and never auto-continues past it on any of: a failed green-gate
condition, `human-decision-required`, a halted sliced pipeline,
verification failure, integration `conflicted` or `aborted`, a
base-changed guard, or lock contention. Rejection and revision paths are
unchanged: a revision means a new spec and a fresh attempt, never editing
frozen bytes.
```

- [ ] **Step 3: Fix the stale human-only sentence**

In the `## Presenting delegations as subagents` section (~line 93), replace the fragment:

```markdown
a Producer self-report is not evidence; acceptance stays human-only.
```

with:

```markdown
a Producer self-report is not evidence; acceptance follows the autopilot
green gates, and merging to `main` stays human-only.
```

Then run `grep -n "human-only\|human can accept" skills/delegate/SKILL.md` and confirm every remaining occurrence is consistent with the autopilot rules.

- [ ] **Step 4: Validate skill consistency**

Run: `claude plugin validate . && bash scripts/validate-release.sh`
Expected: both pass (release validator may flag unrelated release-surface checks only if versions drifted — they should not; this change touches no version surface).

- [ ] **Step 5: Commit**

```bash
git add skills/delegate/SKILL.md
git commit -m "feat(skill): add autopilot loop with gated auto-accept"
```

### Task 3: Project settings allowlist

**Files:**
- Create: `.claude/settings.json`

**Interfaces:**
- Produces: prompt-free tool access for the loop in Task 4.

- [ ] **Step 1: Write the settings file**

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_claude-architect_runtime__delegate",
      "mcp__plugin_claude-architect_runtime__delegatePipeline",
      "mcp__plugin_claude-architect_runtime__reviewCandidate",
      "mcp__plugin_claude-architect_runtime__decideCandidate",
      "mcp__plugin_claude-architect_runtime__integrateCandidate",
      "mcp__plugin_claude-architect_runtime__doctor",
      "mcp__plugin_claude-architect_runtime__gitStatus",
      "mcp__plugin_claude-architect_runtime__gitDiff",
      "mcp__plugin_claude-architect_runtime__gitLog",
      "mcp__plugin_claude-architect_runtime__gitChangedFiles",
      "Bash(git switch:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git push origin feat/*)",
      "Bash(gh pr create:*)"
    ]
  }
}
```

- [ ] **Step 2: Verify JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "chore: allowlist runtime MCP tools and feature-branch git for autopilot"
```

### Task 4: Dogfood verification (green path + forced red path)

**Files:**
- Modify: `scratchpad.md` (append any delegation-discovered bug as a dogfood regression-test description, per AGENTS.md)

**Interfaces:**
- Consumes: Tasks 1–3 in place; a restarted session so the settings allowlist is live.

- [ ] **Step 1: Green-path run**

On a `feat/autopilot-dogfood` branch, delegate one small real task (e.g. a doc-typo-level fix with a real verification command) through the autopilot loop end-to-end.
Expected end state, verified with `git log --oneline -2`, `git status`, `mcp doctor` output, and the PR URL: one reviewed commit on the feature branch, clean status, no stale worktrees or locks, PR opened — and zero permission prompts mid-loop.

- [ ] **Step 2: Red-path run**

Delegate a task whose spec's `verification` command is `false` (guaranteed failure).
Expected: pipeline does not reach green; the loop halts, presents the failure evidence verbatim, and makes no `decideCandidate`/`integrateCandidate`/commit calls.

- [ ] **Step 3: Record findings and close out**

Append any bug found to `scratchpad.md` as a regression-test description. Then:

```bash
git add scratchpad.md
git commit -m "docs: record autopilot dogfood findings"
```

(Skip the commit if no findings.) Merge or close the dogfood PR per its content — human decision.
