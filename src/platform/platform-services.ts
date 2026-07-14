export interface ExecutableRequest {
  name: string;                     // e.g. "codex", "git", "node"
  explicitPath?: string;
  searchPath?: string;              // overrides process PATH when set
}
export interface ResolvedExecutable {
  kind: "native" | "node-entrypoint" | "cmd-wrapper";
  command: string;                  // argv[0] actually spawned
  prefixArgs: string[];             // e.g. ["<entry.js>"] for node-entrypoint
  resolvedFrom: string;             // provenance for the Run Manifest
}
export interface SpawnRequest {
  executable: ResolvedExecutable;
  args: string[];
  cwd: string;
  env: Record<string, string>;      // fully constructed; host env NOT inherited wholesale
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes: number;
}
export interface SupervisedProcess {
  pid: number;
  done: Promise<SupervisedExit>;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
}
export interface SupervisedExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;                   // bounded; truncation recorded in truncated
  stderr: string;
  truncated: { stdout: boolean; stderr: boolean };
  spawnError?: unknown;             // set when the child emitted 'error' before start (→ spawn-failure)
}
export interface CheckoutLock { key: string; release(): Promise<void>; }
export interface CanonicalPath { input: string; canonical: string; gitCommonDir: string | null; }

export interface PlatformServices {
  os: "darwin" | "linux" | "win32";
  resolveExecutable(request: ExecutableRequest): Promise<ResolvedExecutable>;
  spawnSupervised(request: SpawnRequest): Promise<SupervisedProcess>;
  requestCooperativeCancellation(process: SupervisedProcess): Promise<void>;
  terminateProcessTree(process: SupervisedProcess): Promise<void>;
  terminateProcessTreeByPid(pid: number): Promise<void>;   // crash recovery: kill a tree by recorded pid (no live SupervisedProcess). POSIX: kill(-pid); ESRCH treated as success.
  acquireCheckoutLock(checkout: string): Promise<CheckoutLock>;
  createSecureTempDirectory(): Promise<string>;
  canonicalizePath(path: string): Promise<CanonicalPath>;
}
