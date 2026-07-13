<p align="center">
  <img src="assets/banner.svg?v=4" alt="Claude Master: the strongest model decides, cheaper lanes do the typing" width="880">
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
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-9aa4b2?style=flat-square&labelColor=0b0e14">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3fb950?style=flat-square&labelColor=0b0e14">
</p>

# Claude Master

Run your Claude Code or OpenCode session on the strongest model you have, and keep it doing the one thing that model is worth paying for: deciding. It writes the spec, picks who implements, and reviews the result. The typing runs somewhere cheaper.

That is the whole idea. A `delegate` skill turns a request into a complete spec, routes it to one of four implementation lanes, and hands the diff back to the architect for review before anything counts as done. A separate `claude-advisor` is there for the calls that decide whether the next hour is wasted.

## Why it saves money

Top-tier model tokens are expensive, and most of what a coding task spends them on is not judgment. It is boilerplate, test scaffolding, mechanical edits, and reading large files to pull out one answer. None of that needs your best model.

Claude Master splits the two jobs:

- The **architect** (your session, on Fable 5 or Opus) reasons once, writes the spec, and reviews. That is where the expensive tokens go, and it is a small fraction of the total.
- The **implementation** runs on a lane you choose for the job. Codex bills against a subscription. The OpenCode pool uses whatever provider credit you already hold. Pi runs an open-weight model on your own hardware at zero marginal token cost. Pythinker runs your own agent unattended.

So you stop paying flagship rates to generate a fixture file. You pay for the decision and the review, and let a cheaper or local model produce the code. The `pi-implementer` lane in particular costs nothing per token once the local server is up.

## How it works

The session is the architect. It owns requirements, decomposition, interfaces, routing, and acceptance. It delegates implementation and broad exploration and keeps the decisions and the review for itself.

Every delegation carries the same five-part spec: the objective, the exact files, the interfaces to preserve, the constraints, and the verification command. A lane runs the spec, then reports back with the diff and the real output of the verification command. The architect reads the actual diff and re-runs the verification before accepting. A lane saying "it works" is a claim, not evidence.

## The lanes

| Lane | Invoke | Producer | Route here when |
|---|---|---|---|
| Cloud, default | `codex-implementer` | GPT-5.6 Sol via the Codex CLI | General implementation, or when a second model family is worth it for correctness |
| Provider pool | `opencode-implementer` | Any authenticated OpenCode provider (Zen/Go, MiniMax coding plan, OpenAI) | The right model sits behind an OpenCode credential the other lanes cannot reach |
| Local, $0 | `pi-implementer` | Open-weight model on local hardware via Pi | Routine work you want to keep local at zero marginal token cost |
| Autonomous | `pythinker-implementer` | Your own Pythinker agent, headless `--yolo` | A trusted spec should run to completion with no human in the loop |
| Judgment | `claude-advisor` | Claude's strongest tier, read only | Architecture, migrations, API shape, a broad refactor, or a problem that has resisted two attempts |

Codex is the default. Reach for OpenCode when the model you want only lives in its provider pool, Pi when local execution and zero token cost matter, and Pythinker when full unattended execution is the point. Each lane is a harness around a producer, so Pi, OpenCode, and Pythinker take an explicit `--model`; Codex pins its own. Every CLI lane runs a preflight and returns a structured `unavailable` report rather than quietly implementing the work itself. A lane that promises Codex and silently becomes a Claude lane is worse than a loud failure, because you chose that lane for a reason.

## Install

### Claude Code

```bash
claude plugin marketplace add Pythoughts-labs/claude-master
claude plugin install claude-master@claude-master
```

Update later with:

```bash
claude plugin marketplace update claude-master
claude plugin update claude-master@claude-master
```

The plugin loads the agent definitions in `agents/` and the `delegate` skill in `skills/`.

### OpenCode

This repository ships native OpenCode assets: `opencode.json` registers the shared `skills/` directory, and `.opencode/agents/` holds OpenCode-compatible subagents with explicit permissions.

Copy them into a project:

```bash
mkdir -p .opencode/agents .opencode/skills/delegate
cp /path/to/claude-master/.opencode/agents/*.md .opencode/agents/
cp /path/to/claude-master/skills/delegate/SKILL.md .opencode/skills/delegate/SKILL.md
```

Or globally, under `~/.config/opencode/`. Quit and restart OpenCode afterward, since it loads skills and agents at startup. Running OpenCode directly from this repository picks up `opencode.json` and `.opencode/agents/` on its own.

## Use

Ask the architect to delegate:

```text
Add rate limiting to our public API. Use the delegate skill, send the
implementation to the right lane, and review the diff before accepting it.
```

The spec it produces always names the objective, the exact files, the interfaces, the constraints, and the verification command. Independent read-only tasks or edits to separate files can run in parallel. Writing agents must not race in the same working tree, so isolate concurrent runs in separate worktrees.

## Requirements

- **Codex lane:** install and authenticate the [OpenAI Codex CLI](https://github.com/openai/codex). The lane calls `gpt-5.6-sol` at high reasoning.
- **OpenCode lane:** install the [OpenCode CLI](https://opencode.ai) and authenticate a provider with `opencode auth login`. The lane runs `opencode run --agent build --auto` and takes the model explicitly.
- **Pi lane:** install the [Pi coding agent](https://pi.dev) and start a local model server. Pass the provider and model explicitly.
- **Pythinker lane:** install the [Pythinker CLI](https://pythoughts-labs.github.io/pythinker-code/), authenticate a provider, and pass the model explicitly. This lane runs unattended in `--yolo` mode.
- **Advisor:** Claude Code users need access to the model set in `agents/claude-advisor.md` (Fable 5). OpenCode users can set a preferred advisor model in their copied agent file; without one it inherits the session model.

## When to call the advisor

Consult `claude-advisor` before an architecture decision, a data migration, a public API change, or a broad refactor. Call it after two failed attempts at the same problem, and once more before accepting a multi-step deliverable. Pass it the decision, the constraints, and the options you already considered. It reads the code, returns a verdict with the one risk that decides it, and never touches a file.

## Repository layout

- `agents/` holds the Claude Code subagents: the four lanes and the advisor.
- `skills/delegate/` is the shared routing and acceptance doctrine.
- `.opencode/agents/` and `opencode.json` carry the same lanes and skill for OpenCode.
- `.claude-plugin/` has the plugin and marketplace manifests.
- `assets/` holds the banner.

## License

MIT. See [LICENSE](LICENSE).
