import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = relative => fs.readFileSync(`${root}/${relative}`, "utf8");

describe("P0-A plugin wiring", () => {
  it("ships the runtime, advisor allowlist, protocol marker, and honest support claims", () => {
    const mcp = JSON.parse(read(".mcp.json"));
    assert.deepEqual(mcp, {
      mcpServers: {
        runtime: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/runtime/bootstrap.mjs"],
        },
      },
    }, "Claude plugin must register the packaged runtime bootstrap without a shell");
    assert.ok(fs.statSync(`${root}/runtime/bootstrap.mjs`).isFile(), "bootstrap must ship");
    assert.ok(fs.statSync(`${root}/runtime/server.mjs`).isFile(), "server bundle must ship");
    // A bundle rebuilt inside a Producer worktree embeds worktree-relative
    // module paths and diverges from a canonical repo-root build, which is why
    // runtime/server.mjs stays out of Producer write allowlists.
    const bundle = fs.readFileSync(`${root}/runtime/server.mjs`, "utf8");
    assert.ok(
      !/\.\.\/[^"'\n]*node_modules/u.test(bundle),
      "committed bundle must not embed worktree-relative node_modules paths",
    );
    if (process.platform !== "win32") {
      assert.ok(fs.statSync(`${root}/scripts/build-runtime.sh`).mode & 0o111, "build wrapper must be executable");
    }

    const advisor = read("agents/advisor.md");
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(advisor);
    assert.ok(frontmatterMatch, "advisor must have frontmatter");
    const frontmatter = frontmatterMatch[1];
    const keys = new Set([...frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9]*):/gmu)]
      .map(match => match[1]));
    for (const key of ["name", "description", "tools", "model"]) {
      assert.ok(keys.has(key), `advisor must declare ${key}`);
    }
    for (const forbidden of ["mcpServers", "hooks", "permissionMode"]) {
      assert.equal(keys.has(forbidden), false, `advisor must not declare ${forbidden}`);
    }
    const tools = /^tools:\s*(.+)$/mu.exec(frontmatter)?.[1]
      .split(",").map(value => value.trim()) ?? [];
    assert.deepEqual(tools, [
      "Read",
      "Grep",
      "Glob",
      "mcp__plugin_claude-architect_runtime__gitStatus",
      "mcp__plugin_claude-architect_runtime__gitDiff",
      "mcp__plugin_claude-architect_runtime__gitLog",
      "mcp__plugin_claude-architect_runtime__gitChangedFiles",
    ]);
    for (const forbidden of ["Bash", "Write", "Edit"]) {
      assert.equal(tools.includes(forbidden), false, `advisor must exclude ${forbidden}`);
    }

    const versions = read("src/protocol/versions.ts");
    const runtimeProtocol = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/u.exec(versions)?.[1];
    const skill = read("skills/delegate/SKILL.md");
    const skillProtocol = /^PROTOCOL_VERSION:\s*([^\s]+)$/mu.exec(skill)?.[1];
    assert.equal(runtimeProtocol, "1.4.0", "runtime must expose the current wire protocol");
    assert.equal(skillProtocol, runtimeProtocol, "delegate skill protocol marker must match runtime");
    assert.doesNotMatch(skill, /(^|[^:])\/delegate\b/mu, "delegate skill must use the fully qualified command");
    for (const lifecycleTool of ["delegate", "reviewCandidate", "decideCandidate", "integrateCandidate"]) {
      assert.ok(skill.includes(`\`${lifecycleTool}\``), `delegate skill must drive ${lifecycleTool}`);
      assert.match(
        skill,
        new RegExp("[Cc]all `" + lifecycleTool + "`[^\\n]*`checkoutPath`", "u"),
        `delegate skill must pass checkoutPath to ${lifecycleTool}`,
      );
    }
    assert.match(skill, /validationErrors/u, "delegate skill must describe the repair loop");
    assert.match(skill, /protocolVersion/u, "delegate skill must echo its protocol marker");
    for (const rosterName of ["codex-implementer", "opencode-implementer", "pi-implementer", "pythinker-implementer"]) {
      assert.ok(skill.includes(`\`${rosterName}\``), `delegate skill must retain ${rosterName} in its selection roster`);
    }
    const trustedLifecycleHeading = skill.indexOf("## Trusted MCP lifecycle");
    const laneHeading = skill.indexOf("## Lanes as native subagents");
    assert.ok(
      trustedLifecycleHeading >= 0
        && laneHeading > trustedLifecycleHeading
        && !/^## /mu.test(skill.slice(trustedLifecycleHeading + 1, laneHeading)),
      "lane-agent dispatch must immediately follow the trusted MCP lifecycle",
    );
    assert.ok(
      skill.includes("**Same repository**: the runtime serializes all attempts on the repository lock."),
      "skill must state same-repository serialization",
    );
    assert.ok(skill.includes("At most one accepted candidate per clean checkout; never batch-accept multiple candidates targeting the same checkout."));
    assert.ok(skill.includes("compute `specSha256` over the exact spec JSON"), "skill must document lane correlation");
    assert.match(skill, /laneEligibility\.edit=false/u);
    assert.doesNotMatch(skill, /^## Legacy migration fallback$/mu);

    for (const legacyFile of [
      "agents/codex-implementer.md",
      "agents/opencode-implementer.md",
      "agents/pi-implementer.md",
      "agents/pythinker-implementer.md",
      ".opencode/agents/claude-advisor.md",
      ".opencode/agents/codex-implementer.md",
      ".opencode/agents/pi-implementer.md",
      ".opencode/agents/pythinker-implementer.md",
      "scripts/run-isolated.sh",
      "scripts/run-codex-isolated.sh",
      "scripts/run-opencode-isolated.sh",
      "scripts/run-pi-isolated.sh",
      "scripts/run-pythinker-isolated.sh",
      "tests/lane-roster.test.mjs",
      "tests/lane-model-fallback.test.mjs",
      "tests/lane-contract.test.mjs",
      "tests/run-isolated.test.sh",
      "tests/codex-lifecycle.test.sh",
      "tests/runtime/isolated-scripts.test.ts",
    ]) {
      assert.equal(fs.existsSync(`${root}/${legacyFile}`), false, `${legacyFile} must not ship`);
    }

    const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    const readme = read("README.md");
    const changelog = read("CHANGELOG.md");
    assert.equal(plugin.version, "0.30.0");
    assert.equal(marketplace.plugins[0].version, "0.30.0");
    assert.match(readme, /badge\/version-0\.30\.0-/u);
    assert.doesNotMatch(
      readme,
      /`\/delegate`/u,
      "README must use the fully qualified public command",
    );
    assert.match(changelog, /^## \[0\.8\.0\] - 2026-07-14$/mu);
    assert.match(readme, /macOS arm64[^\n]*certified/iu);
    assert.match(readme, /Linux[^\n]*tested/iu);
    assert.match(readme, /Windows[^\n]*unsupported/iu);
    assert.match(readme, /codex-native-sandbox/u);
    assert.match(marketplace.plugins[0].description, /macOS arm64 certified/iu);
    assert.match(marketplace.plugins[0].description, /Linux tested; native Windows pending/iu);
    assert.match(readme, /Installed marketplace copies[^\n]*update[^\n]*reload/iu);
    assert.match(readme, /--disable multi_agent/u);
    assert.match(readme, /features\.multi_agent_v2=\{enabled=false,max_concurrent_threads_per_session=1\}/u);

    const releaseValidator = read("scripts/validate-release.sh");
    const buildRuntime = read("scripts/build-runtime.sh");
    assert.match(buildRuntime, /npm run build/u, "build wrapper must use the package build contract");
    assert.match(
      releaseValidator,
      /git diff --exit-code -- runtime\/server\.mjs runtime\/bootstrap\.mjs/u,
      "release validation must reject dirty runtime artifacts after rebuilding",
    );
    for (const required of [
      "runtime/bootstrap.mjs",
      "runtime/server.mjs",
      ".mcp.json",
      "PROTOCOL_VERSION",
      "scripts/build-runtime.sh",
    ]) {
      assert.ok(releaseValidator.includes(required), `release validator must check ${required}`);
    }
  });
});

test("delegation-lane agent ships the produce-only courier contract", () => {
  const lane = read("agents/delegation-lane.md");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(lane);
  assert.ok(frontmatterMatch, "delegation-lane must have frontmatter");
  const frontmatter = frontmatterMatch[1];
  const keys = frontmatter.split(/\r?\n/u).map(line => {
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s.*)?$/u.exec(line);
    assert.ok(match, `delegation-lane frontmatter must use plain top-level keys: ${line}`);
    return match[1];
  });
  assert.deepEqual(keys.sort(), [
    "name",
    "description",
    "tools",
    "model",
  ].sort(), "delegation-lane must have exactly the permitted frontmatter keys");
  const toolsLine = /^tools:\s*(.+)$/mu.exec(frontmatter)?.[1] ?? "";
  const tools = toolsLine.split(",").map(t => t.trim());
  assert.deepEqual(tools.sort(), [
    "mcp__plugin_claude-architect_runtime__delegate",
    "mcp__plugin_claude-architect_runtime__delegatePipeline",
  ].sort(), "delegation-lane must have exactly the two dispatch tools");
  for (const forbidden of [
    "reviewCandidate", "decideCandidate", "integrateCandidate",
    "Bash", "Write", "Edit", "Read", "Grep", "Glob", "doctor",
  ]) {
    assert.ok(!toolsLine.includes(forbidden), `delegation-lane tools must not include ${forbidden}`);
  }
  for (const field of ["laneId", "specSha256", "\"failure\"", "validationErrors", "manifestHash"]) {
    assert.ok(lane.includes(field), `delegation-lane contract must include ${field}`);
  }
  assert.match(lane, /[Nn]ever review/u);
  assert.match(frontmatter, /^model:\s*haiku$/mu);
});
