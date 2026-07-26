import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const hookPath = fileURLToPath(new URL("../../.githooks/pre-push", import.meta.url));

async function hook(): Promise<string> {
  return await readFile(hookPath, "utf8");
}

describe("pre-push gate", () => {
  it("bounds test parallelism and keeps failure output", async () => {
    // The default worker count is one per core, and this suite's real-Git tests
    // contend under it: a release was blocked by a flake that four bounded
    // re-runs could not reproduce. --silent then hid which test it was, so the
    // one artifact needed to fix it never existed.
    const source = await hook();
    const suiteLine = source.split("\n").find(line => line.includes("npx vitest run"));
    expect(suiteLine).toBeDefined();
    expect(suiteLine).toContain("--maxWorkers=");
    expect(suiteLine).not.toContain("--silent");
    expect(source).toContain("Full output:");
  });

  it("asks GitHub about the ci workflow rather than the newest workflow", async () => {
    // Without --workflow, `gh run list --limit 1` returns whichever workflow ran
    // most recently — CodeQL and Dependabot both run on this repository — so the
    // gate read an unrelated conclusion and would call a branch green while ci
    // was red.
    const source = await hook();
    for (const line of source.split("\n")) {
      if (!line.includes("gh run list --branch")) continue;
      expect(line).toContain("--workflow ci");
    }
    expect(source).toMatch(/gh run list --branch "\$1" --workflow ci/u);
  });

  it("guards array expansions that abort under bash 3.2", async () => {
    // macOS ships bash 3.2, where expanding an empty array under `set -u` is an
    // unbound-variable error. A tag-only push leaves pushed_branches empty, so
    // the hook aborted there on any host without a newer bash on PATH.
    const source = await hook();
    expect(source).toContain('set -euo pipefail');
    expect(source).not.toMatch(/for br in "\$\{pushed_branches\[@\]\}"/u);
    expect(source).not.toMatch(/for tag_sha in "\$\{tag_shas\[@\]\}"/u);
    expect(source).toContain('${pushed_branches[@]+"${pushed_branches[@]}"}');
    expect(source).toContain('${tag_shas[@]+"${tag_shas[@]}"}');
  });

  it("keeps the tag gate anchored to the tagged commit and a green Windows job", async () => {
    const source = await hook();
    expect(source).toContain('git rev-parse "${tag_sha}^{commit}"');
    expect(source).toContain("gh run list --commit");
    expect(source).toMatch(/select\(\.name \| test\("windows"; "i"\)\)/u);
    // Without gh the tag gate must refuse rather than degrade to a no-op: a
    // published artifact cannot rest on an unverifiable claim.
    expect(source).toContain("gh unavailable — cannot confirm CI for the tagged commit");
  });

  it.skipIf(process.platform === "win32")("parses under macOS system bash 3.2", async () => {
    await expect(execFileAsync("/bin/bash", ["-n", hookPath])).resolves.toBeDefined();
  });
});
