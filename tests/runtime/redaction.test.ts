import { describe, it, expect } from "vitest";
import {
  boundedRedactedDiagnostic,
  clearRegisteredSecrets,
  redact,
  redactRecord,
  registerSecretValue,
} from "../../src/runtime/redaction.js";
describe("redact", () => {
  it("masks bearer tokens and known key prefixes", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(redact("key sk-ABCDEF0123456789")).not.toContain("sk-ABCDEF0123456789");
    expect(redact("AWS AKIAIOSFODNN7EXAMPLE here")).toContain("[a]");
    expect(redact("AWS AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
  it("leaves ordinary text intact", () => {
    expect(redact("just a normal sentence")).toBe("just a normal sentence");
    expect(redact("config key: application.database.connection failed")).toBe(
      "config key: application.database.connection failed",
    );
  });
  it("redacts a real JWT-shaped token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const output = redact(`token ${jwt} here`);

    expect(output).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
  });
});

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
    expect(redact("hunter2-enterprise-token appears again")).not.toContain("[s]");
  });

  it("ignores registered values shorter than six characters", () => {
    clearRegisteredSecrets();
    registerSecretValue("tiny!");

    expect(redact("tiny! remains visible")).toBe("tiny! remains visible");
    clearRegisteredSecrets();
  });

  it("is idempotent when a registered value appears in the redaction marker", () => {
    clearRegisteredSecrets();
    const registration = registerSecretValue("secret");

    const once = redact("secret");

    expect(redact(once)).toBe(once);
    expect(once).not.toContain("secret");
    registration.dispose();
  });

  it("does not treat literal marker text inside a registered secret as trusted", () => {
    clearRegisteredSecrets();
    const registration = registerSecretValue("prefix[s]suffix");

    expect(redact("before prefix[s]suffix after")).toBe("before [s] after");
    registration.dispose();
  });

  it("reaches a fixed point when pattern redaction creates a registered secret", () => {
    clearRegisteredSecrets();
    const registration = registerSecretValue("prefix [k] suffix");

    const output = redact("prefix sk-ABCDEF0123456789 suffix");

    expect(output).toBe("[s]");
    expect(redact(output)).toBe(output);
    registration.dispose();
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
      nested: ["Bearer [b]", { message: "ordinary" }],
    });
  });

  it("masks GitHub and Slack tokens", () => {
    const input = ["ghu_ABCDEF0123456789", "xoxb-" + "1234567890-abcdefghijklmnop"].join(" ");

    const output = redact(input);

    expect(output).not.toContain("ghu_ABCDEF0123456789");
    expect(output).not.toContain("xoxb-" + "1234567890-abcdefghijklmnop");
  });

  it("leaves plain file paths intact", () => {
    const path = "/Users/panda/Projects/active/claude-architect/src/index.ts";

    expect(redact(path)).toBe(path);
  });

  it("does not let a __proto__ key in input hijack the output's prototype", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "safe": "ok"}');

    const output = redactRecord(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(output.safe).toBe("ok");
  });

  it("redacts registered secret values used as property names", () => {
    clearRegisteredSecrets();
    const registration = registerSecretValue("enterprise-secret-key");

    const output = redactRecord({ "enterprise-secret-key": "ordinary" });

    expect(JSON.stringify(output)).not.toContain("enterprise-secret-key");
    expect(JSON.stringify(output)).toContain("[s]");
    registration.dispose();
  });
});

describe("boundedRedactedDiagnostic", () => {
  it("strips POSIX and Windows repository paths from an error message", () => {
    const posix = boundedRedactedDiagnostic(
      new Error("ENOENT: no such file /Users/panda/Projects/secret-repo/.git/HEAD"),
      2_000,
    );
    expect(posix).not.toContain("/Users/panda/Projects/secret-repo");
    expect(posix).toContain("[path]");

    const windows = boundedRedactedDiagnostic(
      new Error("cannot open C:\\Users\\panda\\secret-repo\\.git"),
      2_000,
    );
    expect(windows).not.toContain("secret-repo");
    expect(windows).toContain("[path]");
  });

  it("redacts registered secrets and non-Error values", () => {
    clearRegisteredSecrets();
    const registration = registerSecretValue("enterprise-secret-key");
    expect(boundedRedactedDiagnostic("failed with enterprise-secret-key", 2_000)).not.toContain(
      "enterprise-secret-key",
    );
    registration.dispose();
  });

  it("truncates to the byte budget on a UTF-8 boundary", () => {
    const output = boundedRedactedDiagnostic(new Error("x".repeat(5_000)), 100);
    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(100);
  });
});
