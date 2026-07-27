# Delegation statusline

This optional POSIX statusline shows the current trusted, redacted delegation phase. It is not configured automatically. Windows statuslines are not supported by this asset.

Make the script executable, then add a command statusline to your Claude Code user settings. Set `CLAUDE_PLUGIN_DATA` to the plugin data directory used by the Claude Architect runtime:

```json
{
  "statusLine": {
    "type": "command",
    "command": "CLAUDE_PLUGIN_DATA=\"/absolute/path/to/plugin-data\" \"${CLAUDE_PLUGIN_ROOT}/assets/statusline/delegation-status.sh\""
  }
}
```

The script prints nothing when no pipeline is active or when state is stale or ambiguous. A run is rendered only when its active marker and status were both updated within 15 minutes, the recorded process responds to a `kill -0`-equivalent check, and its process-start token still matches; this prevents a reused PID from appearing active. Sliced runs show both the phase and `slice i/n`.
