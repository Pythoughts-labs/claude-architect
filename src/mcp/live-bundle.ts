import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_VERSION } from "../protocol/versions.js";

/**
 * Delegating against this repository runs the *published* server bundle, not the
 * checkout under edit. A fix committed here is invisible to the loop until the
 * plugin is rebuilt and reloaded, which has repeatedly made correct fixes look
 * broken. Detect and say so rather than letting the next run relearn it.
 */
export interface LiveBundleStatus {
  /** The delegation target is the claude-architect repository itself. */
  selfHosted: boolean;
  /** Version of the server currently serving this request. */
  runningVersion: string;
  /** Version declared by the target checkout, when it is self-hosted. */
  repositoryVersion: string | null;
  /** null when not self-hosted, or when either bundle could not be read. */
  bundleMatches: boolean | null;
  stale: boolean;
}

export interface LiveBundleDependencies {
  readFile?: (target: string) => Promise<Buffer>;
  /** Module the running server was loaded from; defaults to the process entrypoint. */
  runningBundlePath?: string | undefined;
  runningVersion?: string;
}

const NOT_SELF_HOSTED: LiveBundleStatus = {
  selfHosted: false,
  runningVersion: RUNTIME_VERSION,
  repositoryVersion: null,
  bundleMatches: null,
  stale: false,
};

async function readOrNull(
  read: (target: string) => Promise<Buffer>,
  target: string,
): Promise<Buffer | null> {
  try {
    return await read(target);
  } catch {
    return null;
  }
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function declaredName(manifest: Buffer): { name: unknown; version: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(manifest.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as { name: unknown; version: unknown };
  } catch {
    return null;
  }
}

export async function checkLiveBundle(
  checkoutPath: string,
  deps: LiveBundleDependencies = {},
): Promise<LiveBundleStatus> {
  const read = deps.readFile ?? (target => readFile(target));
  const runningVersion = deps.runningVersion ?? RUNTIME_VERSION;

  const manifest = await readOrNull(read, path.join(checkoutPath, ".claude-plugin", "plugin.json"));
  if (manifest === null) return { ...NOT_SELF_HOSTED, runningVersion };
  const declared = declaredName(manifest);
  if (declared === null || declared.name !== "claude-architect") {
    return { ...NOT_SELF_HOSTED, runningVersion };
  }

  const repositoryVersion = typeof declared.version === "string" ? declared.version : null;
  const repositoryBundle = await readOrNull(read, path.join(checkoutPath, "runtime", "server.mjs"));
  const runningBundlePath = deps.runningBundlePath ?? process.argv[1];
  const runningBundle = runningBundlePath === undefined
      || path.basename(runningBundlePath) !== "server.mjs"
    ? null
    : await readOrNull(read, runningBundlePath);

  const bundleMatches = repositoryBundle === null || runningBundle === null
    ? null
    : sha256(repositoryBundle) === sha256(runningBundle);

  return {
    selfHosted: true,
    runningVersion,
    repositoryVersion,
    bundleMatches,
    stale: bundleMatches === false
      || (repositoryVersion !== null && repositoryVersion !== runningVersion),
  };
}

export function liveBundleDiagnostic(status: LiveBundleStatus): string | null {
  if (!status.stale) return null;
  const versions = status.repositoryVersion === null
    || status.repositoryVersion === status.runningVersion
    ? `version ${status.runningVersion}`
    : `running ${status.runningVersion}, checkout ${status.repositoryVersion}`;
  return `stale-live-bundle: this delegation runs the published claude-architect server `
    + `(${versions}), not the checkout under edit. Changes in runtime/server.mjs take effect `
    + `only after the plugin is rebuilt and reloaded.`;
}
