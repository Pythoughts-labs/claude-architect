# Operations

## Update during an active attempt

The previously installed `${CLAUDE_PLUGIN_ROOT}` remains live for a running MCP server until `/reload-plugins`. After an update and reload, startup recovery on the next server start owns and cancels any unfinished run left by the old plugin root. Runtime state is stored under `${CLAUDE_PLUGIN_DATA}`, which remains stable across plugin versions.

Checkout locks are JSON records containing `pid` and `processToken`. Recovery also accepts legacy locks containing only a bare PID. A dead owner or a live PID whose start token differs from the recorded non-null token is stale; a live matching owner, or a live legacy owner without a token, retains its lock.

For a live unfinished process with a matching token, startup recovery requests cooperative termination first and waits for a grace period. If the process remains alive, recovery forcibly terminates its process tree and records whether cancellation completed cooperatively or required forced escalation. Dead processes and recycled PIDs with mismatched tokens are never signalled.
