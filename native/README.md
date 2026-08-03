# Native Windows helpers

Claude Architect ships native helpers instead of depending on PowerShell for
trusted Windows runtime operations.

- `win32-job-kill-{arch}.exe` owns process-token lookup and process-tree termination.
- `win32-filesystem-{arch}.exe` validates private-directory ACLs, flushes directory
  metadata, and deletes a bigint-identity-matched file or directory by handle.

Sources and reproducible build commands are documented in `build-win32.md`.
