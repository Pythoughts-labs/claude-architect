<p align="center">
  <img src="assets/banner.svg?v=6" alt="Claude Architect: CLI coding-agent orchestration for Claude" width="880">
</p>

<p align="center">
  <a href="#the-lanes"><img alt="codex-implementer" src="https://img.shields.io/badge/lane-codex--implementer-d97757?style=flat-square&labelColor=0b0e14"></a>
  <a href="#the-lanes"><img alt="opencode-implementer" src="https://img.shields.io/badge/lane-opencode--implementer-58a6ff?style=flat-square&labelColor=0b0e14"></a>
  <a href="#the-lanes"><img alt="pi-implementer" src="https://img.shields.io/badge/lane-pi--implementer%20%C2%B7%20%240-3fb950?style=flat-square&labelColor=0b0e14"></a>
  <a href="#the-lanes"><img alt="pythinker-implementer" src="https://img.shields.io/badge/lane-pythinker--implementer-d29922?style=flat-square&labelColor=0b0e14"></a>
  <a href="#the-lanes"><img alt="claude-advisor" src="https://img.shields.io/badge/advisor-claude--advisor-f85149?style=flat-square&labelColor=0b0e14"></a>
  <a href="#use"><img alt="delegate skill" src="https://img.shields.io/badge/skill-delegate-e6edf3?style=flat-square&labelColor=0b0e14"></a>
</p>

<p align="center">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-plugin-d97757?style=flat-square&labelColor=0b0e14">
  <img alt="OpenCode" src="https://img.shields.io/badge/OpenCode-native-58a6ff?style=flat-square&labelColor=0b0e14">
  <img alt="version" src="https://img.shields.io/badge/version-0.6.0-9aa4b2?style=flat-square&labelColor=0b0e14">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square&labelColor=0b0e14">
</p>

# Claude Architect

CLI coding-agent orchestration for Claude through Codex, OpenCode, Pi, and Pythinker Code. Install the plugin, run `/delegate`, and let Claude handle the handoff: it writes the implementation spec, sends the work to the selected CLI, then reviews the result before accepting it. Your strongest model stays focused on decisions instead of spending tokens on mechanical edits.

## Quick start

### 1. Install the plugin

```bash
claude plugin marketplace add Pythoughts-labs/claude-architect
claude plugin install claude-architect@claude-architect
```

Restart Claude Code so it loads the plugin.

### 2. Delegate a task

Open Claude Code in your project and run:

```text
/delegate Use Codex to add rate limiting to our public API, run the tests, and review the diff before accepting it.
```

Name Codex, OpenCode, Pi, or Pythinker in the request to choose a lane immediately. If you leave the lane out, Claude Architect asks which one to use.

### 3. Review the result

Claude prepares the spec and delegates the implementation. When the lane finishes, Claude reads the diff and checks the verification output before accepting the work.

## Install with an AI agent

Paste this prompt into Claude Code or another coding agent when you want it to handle setup:

```text
Install Claude Architect for Claude Code in this environment.

Before making changes:
1. Confirm that the `claude` CLI is installed and available on PATH.
2. Check the current marketplace and plugin state. Do not remove or overwrite unrelated configuration.
3. Add the marketplace with:
   claude plugin marketplace add Pythoughts-labs/claude-architect
4. Install the plugin with:
   claude plugin install claude-architect@claude-architect
5. Verify the installation with `claude plugin list --json` and confirm that `claude-architect@claude-architect` is installed and enabled.
6. Tell me to restart Claude Code so the plugin loads.
7. Check which implementation CLIs are available: `codex`, `opencode`, `pi`, and `pythinker`. Report missing tools, authentication, or local model servers. Do not install those dependencies unless I ask.

Show every command you ran and its actual result. Stop and explain the failure if any required command exits unsuccessfully.
```

Or run the installation yourself:

```bash
command -v claude
claude plugin marketplace add Pythoughts-labs/claude-architect
claude plugin install claude-architect@claude-architect
claude plugin list --json
```

Restart Claude Code, open a project, and run `/delegate`. Update commands, OpenCode installation, and lane requirements are documented below.

## Why it saves money

Top-tier model tokens are expensive, and most of what a coding task spends them on is not judgment. It is boilerplate, test scaffolding, mechanical edits, and reading large files to pull out one answer. None of that needs your best model.

Claude Architect splits the two jobs:

- The **architect** (your session, on Fable 5 or Opus) reasons once, writes the spec, and reviews. That is where the expensive tokens go, and it is a small fraction of the total.
- The **implementation** runs on a lane you choose for the job. Codex bills against a subscription. The OpenCode pool uses whatever provider credit you already hold. Pi runs an open-weight model on your own hardware at zero marginal token cost. Pythinker runs your own agent unattended.

So you stop paying flagship rates to generate a fixture file. You pay for the decision and the review, and let a cheaper or local model produce the code. The `pi-implementer` lane in particular costs nothing per token once the local server is up.

## How it works

The session is the architect. It owns requirements, decomposition, interfaces, routing, and acceptance. It delegates implementation and broad exploration and keeps the decisions and the review for itself.

Every delegation carries the same five-part spec: the objective, the exact files, the interfaces to preserve, the constraints, and the verification command. A lane runs the spec, then reports back with the diff and the real output of the verification command. The architect reads the actual diff and re-runs the verification before accepting. A lane saying "it works" is a claim, not evidence.

## The lanes

| Lane | Invoke | Producer | Route here when |
|---|---|---|---|
| Cloud | `codex-implementer` | GPT-5.6 Sol via the Codex CLI | General implementation, or when a second model family is worth it for correctness |
| Provider pool | `opencode-implementer` | Any authenticated OpenCode provider (Zen/Go, MiniMax coding plan, OpenAI) | The right model sits behind an OpenCode credential the other lanes cannot reach |
| Local, $0 | `pi-implementer` | Open-weight model on local hardware via Pi | Routine work you want to keep local at zero marginal token cost |
| Autonomous | `pythinker-implementer` | Your own Pythinker agent, headless `--yolo` | A trusted spec should run to completion with no human in the loop |
| Judgment | `claude-advisor` | Claude's strongest tier, read only | Architecture, migrations, API shape, a broad refactor, or a problem that has resisted two attempts |

There is no implicit lane default. If `/delegate` does not name Codex, OpenCode, Pi, Pythinker, or an implementer, the architect asks which CLI to use before preparing or launching the delegation. Reach for OpenCode when the model you want only lives in its provider pool, Pi when local execution and zero token cost matter, and Pythinker when full unattended execution is the point. Each lane is a harness around a producer. Codex pins its own model; Pi, OpenCode, and Pythinker accept optional model and thinking or variant overrides, and otherwise defer to the selected CLI's configured defaults. Every CLI lane runs a preflight and returns a structured `unavailable` report rather than quietly implementing the work itself. A lane that promises Codex and silently becomes a Claude lane is worse than a loud failure, because you chose that lane for a reason.

Every implementation lane uses one shared process-isolation lifecycle through its own CLI-specific adapter. Codex is uncapped by default. Pi, Pythinker, and OpenCode fail closed after 900 seconds by default; set `PI_TIMEOUT_SECONDS=0`, `PYTHINKER_TIMEOUT_SECONDS=0`, or `OPENCODE_TIMEOUT_SECONDS=0`, respectively, to disable that cap.

## Install

### Claude Code

```bash
claude plugin marketplace add Pythoughts-labs/claude-architect
claude plugin install claude-architect@claude-architect
```

Update later with:

```bash
claude plugin marketplace update claude-architect
claude plugin update claude-architect@claude-architect
```

The plugin loads the agent definitions in `agents/` and the `delegate` skill in `skills/`.

### OpenCode

This repository ships native OpenCode assets: `opencode.json` registers the shared `skills/` directory for source-checkout use, and `.opencode/agents/` holds OpenCode-compatible subagents with explicit permissions.

Install into a project, regardless of your current working directory:

```bash
bash /path/to/claude-architect/scripts/install-opencode.sh --project /path/to/project
```

Or install globally:

```bash
bash /path/to/claude-architect/scripts/install-opencode.sh --global
```

Project installation writes the four agents to `<project>/.opencode/agents`, the delegate skill to `<project>/.opencode/skills/delegate/SKILL.md`, and the shared runtime plus all four CLI adapters to `<project>/.opencode/claude-architect/scripts`. Global installation writes the same layout under `${OPENCODE_CONFIG_DIR}` when set, otherwise `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`.

The implementation agents locate their adapter from `CLAUDE_ARCHITECT_ROOT/scripts` when `CLAUDE_ARCHITECT_ROOT` is set, then walk from the current directory through every ancestor looking first for a source checkout with `.claude-plugin/plugin.json` and `scripts/`, then for a project `.opencode/claude-architect/scripts` install. They next check a custom `OPENCODE_CONFIG_DIR` and finally the default global config location. This makes nested project directories work without assuming a project-root working directory. Running OpenCode directly from this source checkout remains the development mode: it picks up `opencode.json` and `.opencode/agents/`, while the source marker lets agents use the repository's runtime scripts.

Quit and restart OpenCode after installing or updating because it loads skills and agents at startup. If a lane reports `STATUS: unavailable` because it cannot find the runtime, rerun one of the installer commands above; use `CLAUDE_ARCHITECT_ROOT=/path/to/claude-architect` only when intentionally selecting a checkout at runtime.

## Use

Ask the architect to delegate:

```text
/delegate Add rate limiting to our public API and review the diff before
accepting it.
```

Because that request does not name a lane, the architect asks you to choose Codex, OpenCode, Pi, or Pythinker before it continues. The question identifies each lane's producer and reasoning control: Codex runs GPT-5.6 Sol at `low` by default (`medium`, `high`, `xhigh`, and `max` are overrides), OpenCode exposes an optional model-specific variant, Pi exposes optional `--model` and `--thinking`, and Pythinker exposes optional `--model` and `--thinking-effort`. Without an override, Pi, OpenCode, and Pythinker use their CLI-configured defaults. Use a custom answer to name an override, or name a lane and reasoning level in the request to skip the question.

The spec it produces always names the objective, the exact files, the interfaces, the constraints, and the verification command. Independent read-only tasks or edits to separate files can run in parallel. Writing agents must not race in the same working tree, so isolate concurrent runs in separate worktrees.

## Requirements

- **Codex lane:** install and authenticate the [OpenAI Codex CLI](https://github.com/openai/codex). The lane calls `gpt-5.6-sol` at low reasoning by default.
- **OpenCode lane:** install the [OpenCode CLI](https://opencode.ai) and authenticate a provider with `opencode auth login`. The lane runs `opencode run --agent build --auto`; optional model and variant overrides otherwise defer to OpenCode configuration.
- **Pi lane:** install the [Pi coding agent](https://pi.dev) and start a local model server. Optional model and thinking overrides otherwise defer to Pi configuration.
- **Pythinker lane:** install the [Pythinker CLI](https://pythoughts-labs.github.io/pythinker-code/), authenticate a provider, and optionally pass a model or `--thinking-effort off|minimal|low|medium|high|xhigh|max` override. Absent overrides defer to Pythinker configuration. This lane runs unattended in `--yolo` mode.
- **Advisor:** Claude Code users need access to the model set in `agents/claude-advisor.md` (Fable 5). OpenCode users can set a preferred advisor model in their copied agent file; without one it inherits the session model.

## When to call the advisor

Consult `claude-advisor` before an architecture decision, a data migration, a public API change, or a broad refactor. Call it after two failed attempts at the same problem, and once more before accepting a multi-step deliverable. Pass it the decision, the constraints, and the options you already considered. It reads the code, returns a verdict with the one risk that decides it, and never touches a file.

## Repository layout

- `agents/` holds the Claude Code subagents: the four lanes and the advisor.
- `skills/delegate/` is the shared routing and acceptance doctrine.
- `.opencode/agents/`, `opencode.json`, and `scripts/install-opencode.sh` carry the OpenCode agents, skill wiring, and packaged runtime.
- `.claude-plugin/` has the plugin and marketplace manifests.
- `assets/` holds the banner.

## License

MIT. See [LICENSE](LICENSE).
