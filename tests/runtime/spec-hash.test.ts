import { describe, expect, it } from "vitest";
import { canonicalSpecJson, specSha256 } from "../../src/protocol/spec-hash.js";

describe("spec identity", () => {
  it("is independent of key order", () => {
    // The architect and the runtime build the spec object separately. With
    // JSON.stringify the digest depends on insertion order, so the correspondence
    // check would fail on correct runs while proving nothing about wrong ones.
    const a = { objective: "x", specVersion: "1", verification: [{ id: "t", args: ["a", "b"] }] };
    const b = { specVersion: "1", verification: [{ args: ["a", "b"], id: "t" }], objective: "x" };
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));  // the trap
    expect(specSha256(a)).toEqual(specSha256(b));
  });

  it("preserves array order, which is semantically meaningful", () => {
    // Argument vectors and allowlist precedence are order-dependent; sorting
    // them would make two different specs hash identically.
    expect(specSha256({ args: ["--flag", "value"] }))
      .not.toEqual(specSha256({ args: ["value", "--flag"] }));
  });

  it("distinguishes a present-but-undefined key from an absent one consistently", () => {
    expect(canonicalSpecJson({ a: 1, b: undefined })).toEqual(canonicalSpecJson({ a: 1 }));
  });

  it("separates nesting from flattening", () => {
    expect(specSha256({ a: { b: 1 } })).not.toEqual(specSha256({ "a.b": 1 }));
  });
});
