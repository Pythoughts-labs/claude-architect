import type { CapabilityReport } from "../../producers/producer-adapter.js";

export interface SandboxBackend {
  id: string;
  kind: "producer-native" | "os";
  platforms: ReadonlyArray<{
    os: "darwin" | "linux" | "win32";
    arch?: string;
    environmentType: "native" | "wsl";
    state: "certified" | "tested" | "unsupported";
  }>;
}

// States may only be promoted by a real green CI/integration run (Task 9);
// Linux and Windows start unsupported.
export const SANDBOX_BACKENDS: SandboxBackend[] = [{
  id: "codex-native-sandbox",
  kind: "producer-native",
  platforms: [
    { os: "darwin", arch: "arm64", environmentType: "native", state: "certified" },
    { os: "linux", environmentType: "native", state: "unsupported" },
    { os: "win32", environmentType: "native", state: "unsupported" },
  ],
}];

export function selectSandboxBackend(report: CapabilityReport):
  | { backend: SandboxBackend; state: "certified" | "tested" }
  | { backend: null; reason: string } {
  if (report.writeConfinementBackend === null) {
    return { backend: null, reason: "no-write-confinement-backend" };
  }

  const backend = SANDBOX_BACKENDS.find(
    candidate => candidate.id === report.writeConfinementBackend,
  );
  if (backend === undefined) {
    return { backend: null, reason: "unrecognized-write-confinement-backend" };
  }

  const platform = backend.platforms.find(candidate =>
    candidate.os === report.os
    && candidate.environmentType === report.environmentType
    && (candidate.arch === undefined || candidate.arch === report.arch));
  if (platform === undefined || platform.state === "unsupported") {
    return { backend: null, reason: "no-write-confinement-backend" };
  }

  return { backend, state: platform.state };
}
