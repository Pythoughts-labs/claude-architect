import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildEnvironment,
  registerSensitiveEnvironment,
} from "../../src/runtime/environment-policy.js";
import {
  clearRegisteredSecrets,
  redact,
} from "../../src/runtime/redaction.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    HOME: "/host/home",
    PATH: "/host/bin",
    TASK10_ALLOWED: "adapter-value",
    TASK10_UNLISTED: "must-not-leak",
  };
  clearRegisteredSecrets();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  clearRegisteredSecrets();
});

describe("buildEnvironment", () => {
  it("constructs a layered allowlisted environment with names-only provenance", () => {
    const result = buildEnvironment({
      os: "darwin",
      adapterAllowlist: ["TASK10_ALLOWED"],
      specAdditions: { TASK10_SPEC: "spec-value" },
    });

    expect(result.env.PATH).toBe("/host/bin");
    expect(result.env.TASK10_ALLOWED).toBe("adapter-value");
    expect(result.env.TASK10_SPEC).toBe("spec-value");
    expect(result.env.TASK10_UNLISTED).toBeUndefined();
    expect(result.env.CLAUDE_ARCHITECT_DELEGATED).toBe("1");

    expect(result.provenance).toEqual(expect.arrayContaining([
      { name: "PATH", source: "platform" },
      { name: "TASK10_ALLOWED", source: "adapter" },
      { name: "TASK10_SPEC", source: "spec" },
      { name: "CLAUDE_ARCHITECT_DELEGATED", source: "platform" },
    ]));
    expect(JSON.stringify(result.provenance)).not.toContain("adapter-value");
    expect(JSON.stringify(result.provenance)).not.toContain("spec-value");
  });

  it("merges platform, adapter, and spec layers in order and applies a temporary home", () => {
    process.env.HOME = "/adapter/home";

    const result = buildEnvironment({
      os: "linux",
      adapterAllowlist: ["HOME"],
      specAdditions: {
        HOME: "/spec/home",
        CLAUDE_ARCHITECT_DELEGATED: "0",
      },
      tempHome: "/temporary/home",
    });

    expect(result.env.HOME).toBe("/spec/home");
    expect(result.env.CLAUDE_ARCHITECT_DELEGATED).toBe("1");
    expect(result.provenance).toEqual(expect.arrayContaining([
      { name: "HOME", source: "spec" },
      { name: "CLAUDE_ARCHITECT_DELEGATED", source: "platform" },
    ]));
  });

  it("registers sensitive host and constructed values with the redactor", () => {
    process.env.ENTERPRISE_CREDENTIAL = "host-secret-without-known-prefix";

    buildEnvironment({
      os: "darwin",
      adapterAllowlist: [],
      specAdditions: { CUSTOM_TOKEN: "spec-secret-without-known-prefix" },
    });

    const output = redact(
      "host-secret-without-known-prefix spec-secret-without-known-prefix",
    );
    expect(output).not.toContain("host-secret-without-known-prefix");
    expect(output).not.toContain("spec-secret-without-known-prefix");
  });
});

describe("registerSensitiveEnvironment", () => {
  it("registers sensitive verification-command environment values", () => {
    registerSensitiveEnvironment({
      ORDINARY: "visible-value",
      VERIFICATION_PASSWORD: "verification-secret-value",
    });

    const output = redact("visible-value verification-secret-value");
    expect(output).toContain("visible-value");
    expect(output).not.toContain("verification-secret-value");
  });
});
