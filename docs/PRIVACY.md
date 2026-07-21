# Privacy

Claude Architect is primarily a local orchestration and evidence system, but it can send repository-derived information to model providers through the Producer CLIs chosen by the user and to GitHub through the authenticated GitHub CLI during autopilot shipping. Users should treat delegation as disclosure to the configured provider. The product is a public beta; avoid unattended or security-sensitive use involving secrets.

## Data stored locally

The plugin stores run state below the Claude Code-provided `$CLAUDE_PLUGIN_DATA` directory. `src/runtime/state-dir.ts` refuses to select an implicit production fallback. Typical contents include:

- `runs/<run-id>/manifest.json`, `result.json`, an optional decision record, redacted bounded stdout/stderr logs, and pipeline review/fix/verification JSON;
- `worktrees/<run-id>/` and short-lived verification worktrees;
- lock, recovery, cleanup-journal, and quarantine/pruning state;
- Git objects and `refs/claude-architect/candidates/<run-id>` in the delegated repository, used to keep frozen candidate commits reachable.

Autopilot additionally stores `workflows/<workflow-id>/` state, an intent journal and lifetime lease; `autopilot-branches/` ownership records; workflow worktrees and refs; per-task eligibility/decision/promotion evidence; whole-branch cumulative final-review evidence; head-bound CI observations; PR identity; cleanup results; and recovery dispositions. These records can reveal task sequencing, branch names, commit identities, check names/links, and PR metadata.

The run manifest stores the canonical repository path, base commit, Producer id/version/model, effective and execution policies, environment variable names and provenance (not intended values), hashes of repository instruction content and the rendered prompt, packaged verifier identity, candidate manifest association, and its own manifest hash. The attempt result stores the changed-path manifest, patch, evidence, command metadata, redacted output references, and Producer summary. This data can reveal filenames, code changes, repository location, models used, test behavior, and task intent even when credentials are redacted.

Archives use restrictive creation modes, reject symlink/path escapes, bound individual reads, and use integrity checks. These controls protect against some local races; they are not encryption at rest. Any process with the user's filesystem authority may be able to read the data.

## Data sent to model providers

The initial Producer receives the objective, relevant context, success criteria, authorized/forbidden paths, and verification instructions. Because it can read files exposed within its sandbox, a CLI may include source code or other repository content in requests to its configured model. Pipeline reviewers receive at least the delegation spec, baseline and candidate identifiers, the candidate diff, and test evidence. Fixers additionally receive consolidated findings. The Claude architect session itself is governed by the privacy terms of the Claude Code/model configuration.

Codex normally contacts the OpenAI service configured by the Codex CLI. OpenCode, Pi, and Pythinker are model harnesses and may contact whichever cloud or local provider the user's configuration selects; possible providers are not a fixed plugin-controlled list. A local provider may keep traffic on the machine, but that depends on its endpoint and configuration. Claude Architect does not inspect TLS, pin destinations, or override provider telemetry/retention. Shipping v1 separately requires GitHub CLI 2.96 or newer, authenticated to an HTTPS GitHub `origin`; it sends branch, commit, PR, and required-check requests to GitHub.

Verification commands run locally in a clean worktree. A command whose spec allows network may transmit repository or test data to destinations chosen by that command. Network-denied commands are only as private as the effective platform enforcement reported in verification evidence.

## Environment and credentials

`src/runtime/environment-policy.ts` constructs a minimal environment from platform essentials, adapter allowlists, and explicit spec additions. Sensitive host and delegated environment values are registered with the redactor. The certified Codex invocation further configures an include-only shell environment. The design seeks to avoid forwarding credentials by default, but CLI authentication configuration under the user's home/config directories may necessarily be available to the selected CLI.

`src/runtime/redaction.ts` removes registered secret values and known credential patterns from persisted/output data. Sensitive keys in structured records are redacted, and persistence fails if a registered secret is still detected. Redaction does not recognize every secret. Short, encoded, transformed, split, unusually named, or source-embedded secrets can escape detection. Do not keep production secrets in repositories delegated to external models.

## Retention and deletion

The artifact store supports age/size pruning and crash-safe cleanup, but the plugin does not promise a universal automatic retention period. Active and fail-closed workflows retain owned worktrees, branches, evidence, journals, and recovery data when inspection or safe recovery requires them. Successful ready-state cleanup removes temporary local worktrees, locks, and workflow refs while retaining durable evidence, the remote workflow branch, and its PR. Claude Architect never automatically deletes that remote branch.

Local evidence remains until pruning or user removal; Git refs may keep objects reachable. Provider-side retention is controlled by the chosen model provider/account, and GitHub retains pushed branch and PR data under repository/account policy. Autopilot may reach a PR ready for human review but never merges, deploys, or releases it.

To remove local data, first stop Claude Code and ensure no delegation is active. Use runtime-supported cleanup before uninstalling/disabling the plugin and removing its plugin data directory. If runtime cleanup is unavailable, verify the durable workflow ownership and terminal state before deleting each individually identified candidate ref; never delete the candidate-ref namespace with a wildcard. For example, after verifying the corresponding workflow record, run the following from its repository with the exact run ID substituted:

```bash
candidate_ref="refs/claude-architect/candidates/0123456789abcdef"
git show-ref --verify "$candidate_ref"
git update-ref -d "$candidate_ref"
```

Remove provider CLI caches, sessions, and credentials using each CLI's instructions. Deleting local data does not delete provider-side prompts, logs, or model-service records; use the provider's controls for those requests.

## User choices and limitations

Use the smallest possible context and write allowlist, choose local providers for sensitive code where appropriate, deny verification network unless required, review archived evidence before sharing it, and configure provider/GitHub retention intentionally. Project settings require Claude Code workspace trust and cannot override managed `ask` or `deny`; “no mid-loop prompts” is conditional on effective permissions and successful gates. Native macOS arm64 Codex editing is certified and eligible Linux is tested, but native Windows Codex editing is not certified. Claude Architect provides redaction and confinement, not anonymity, end-to-end encryption, data classification, or a guarantee that no repository content leaves the machine.
