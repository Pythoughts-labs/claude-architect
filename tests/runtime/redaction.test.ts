import { describe, it, expect } from "vitest";
import { redact } from "../../src/runtime/redaction.js";
describe("redact", () => {
  it("masks bearer tokens and known key prefixes", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("key sk-ABCDEF0123456789")).not.toContain("sk-ABCDEF0123456789");
    expect(redact("AWS AKIAIOSFODNN7EXAMPLE here")).toContain("«redacted:");
  });
  it("leaves ordinary text intact", () =>
    expect(redact("just a normal sentence")).toBe("just a normal sentence"));
});

import {
  clearRegisteredSecrets,
  redactRecord,
  registerSecretValue,
} from "../../src/runtime/redaction.js";

describe("redact", () => {
  it("masks sensitive assignments while preserving the key", () => {
    const output = redact("API_KEY=abcdef123456");

    expect(output).toContain("API_KEY=");
    expect(output).not.toContain("abcdef123456");
  });

  it("masks registered values and stops after the registry is cleared", () => {
    clearRegisteredSecrets();
    registerSecretValue("hunter2-enterprise-token");

    expect(redact("the token is hunter2-enterprise-token and more")).not.toContain(
      "hunter2-enterprise-token",
    );

    clearRegisteredSecrets();
    expect(redact("hunter2-enterprise-token appears again")).not.toContain("«redacted:");
  });

  it("ignores registered values shorter than six characters", () => {
    clearRegisteredSecrets();
    registerSecretValue("tiny!");

    expect(redact("tiny! remains visible")).toBe("tiny! remains visible");
    clearRegisteredSecrets();
  });

  it("redacts string leaves in nested records without changing other values", () => {
    const input = {
      attempt: 2,
      complete: false,
      detail: null,
      nested: ["Bearer nested-secret-value", { message: "ordinary" }],
    };

    const output = redactRecord(input);

    expect(output).toEqual({
      attempt: 2,
      complete: false,
      detail: null,
      nested: ["Bearer «redacted:bearer»", { message: "ordinary" }],
    });
  });

  it("masks GitHub, Slack, and JWT-looking tokens", () => {
    const input = [
      "ghu_ABCDEF0123456789",
      "xoxb-" + "1234567890-abcdefghijklmnop",
      "abcdefgh.ijklmnop.qrstuvwx",
    ].join(" ");

    const output = redact(input);

    expect(output).not.toContain("ghu_ABCDEF0123456789");
    expect(output).not.toContain("xoxb-" + "1234567890-abcdefghijklmnop");
    expect(output).not.toContain("abcdefgh.ijklmnop.qrstuvwx");
  });

  it("leaves plain file paths intact", () => {
    const path = "/Users/panda/Projects/active/claude-architect/src/index.ts";

    expect(redact(path)).toBe(path);
  });
});
