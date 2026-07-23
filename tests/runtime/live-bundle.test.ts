import { describe, expect, it } from "vitest";
import { checkLiveBundle, liveBundleDiagnostic } from "../../src/mcp/live-bundle.js";
import { RUNTIME_VERSION } from "../../src/protocol/versions.js";

const RUNNING_BUNDLE = "/plugin/cache/claude-architect/runtime/server.mjs";

function reader(files: Record<string, string>) {
  return async (target: string): Promise<Buffer> => {
    const contents = files[target.replace(/\\/gu, "/")];
    if (contents === undefined) throw new Error(`ENOENT ${target}`);
    return Buffer.from(contents, "utf8");
  };
}

function checkout(
  overrides: { name?: string; version?: string; bundle?: string } = {},
): Record<string, string> {
  return {
    "/repo/.claude-plugin/plugin.json": JSON.stringify({
      name: overrides.name ?? "claude-architect",
      version: overrides.version ?? RUNTIME_VERSION,
    }),
    "/repo/runtime/server.mjs": overrides.bundle ?? "bundle-bytes",
  };
}

describe("live bundle staleness", () => {
  it("reports nothing for a repository that is not claude-architect", async () => {
    const status = await checkLiveBundle("/repo", {
      readFile: reader(checkout({ name: "some-other-plugin" })),
      runningBundlePath: RUNNING_BUNDLE,
    });

    expect(status.selfHosted).toBe(false);
    expect(status.stale).toBe(false);
    expect(liveBundleDiagnostic(status)).toBeNull();
  });

  it("reports nothing when the checkout has no plugin manifest", async () => {
    const status = await checkLiveBundle("/repo", {
      readFile: reader({}),
      runningBundlePath: RUNNING_BUNDLE,
    });

    expect(status.selfHosted).toBe(false);
    expect(status.stale).toBe(false);
  });

  it("is quiet when the running bundle matches the checkout byte for byte", async () => {
    const files = checkout();
    files[RUNNING_BUNDLE] = files["/repo/runtime/server.mjs"]!;
    const status = await checkLiveBundle("/repo", {
      readFile: reader(files),
      runningBundlePath: RUNNING_BUNDLE,
    });

    expect(status.selfHosted).toBe(true);
    expect(status.bundleMatches).toBe(true);
    expect(status.stale).toBe(false);
    expect(liveBundleDiagnostic(status)).toBeNull();
  });

  it("detects a checkout whose bundle differs from the running server", async () => {
    const files = checkout({ bundle: "rebuilt-bytes" });
    files[RUNNING_BUNDLE] = "published-bytes";
    const status = await checkLiveBundle("/repo", {
      readFile: reader(files),
      runningBundlePath: RUNNING_BUNDLE,
    });

    expect(status.bundleMatches).toBe(false);
    expect(status.stale).toBe(true);
    expect(liveBundleDiagnostic(status)).toContain("stale-live-bundle");
  });

  it("detects a version skew even when neither bundle can be read", async () => {
    const status = await checkLiveBundle("/repo", {
      readFile: reader({
        "/repo/.claude-plugin/plugin.json": JSON.stringify({
          name: "claude-architect",
          version: "9.9.9",
        }),
      }),
      runningBundlePath: RUNNING_BUNDLE,
      runningVersion: "0.27.0",
    });

    expect(status.bundleMatches).toBeNull();
    expect(status.stale).toBe(true);
    expect(liveBundleDiagnostic(status)).toContain("running 0.27.0, checkout 9.9.9");
  });

  it("treats a malformed plugin manifest as not self-hosted rather than throwing", async () => {
    const status = await checkLiveBundle("/repo", {
      readFile: reader({ "/repo/.claude-plugin/plugin.json": "{ not json" }),
      runningBundlePath: RUNNING_BUNDLE,
    });

    expect(status.selfHosted).toBe(false);
    expect(status.stale).toBe(false);
  });

  it("ignores an entrypoint that is not the packaged server bundle", async () => {
    const files = checkout({ bundle: "rebuilt-bytes" });
    const status = await checkLiveBundle("/repo", {
      readFile: reader(files),
      runningBundlePath: "/usr/local/bin/vitest.mjs",
    });

    // Running from source is normal in development: report the version comparison
    // but never claim a byte mismatch we did not observe.
    expect(status.bundleMatches).toBeNull();
    expect(status.stale).toBe(false);
  });
});
