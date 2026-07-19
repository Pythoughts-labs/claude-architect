import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_HASH_FORMAT,
  computeChangedPathManifest,
  parseRawDiff,
  splitNul,
  type RawDiffEntry,
} from "../../src/git/changed-path-manifest.js";

// Golden hashes are pinned literals (computed independently) so any change to the
// canonical serialization — key order, JSON encoding, or hash algorithm — fails
// loudly instead of silently invalidating every previously frozen candidate.
const EMPTY_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const GOLDEN1_HASH = "45f9d1bb2ae28212c55729317df2abf6e5f97683c1bf25b156633df809e40ca7";
const GOLDEN2_HASH = "54c9652834a6ea3e532e225ba51dcd65e1e6071cb670658598ac69bb6d9b135d";

const OID_1 = "1111111111111111111111111111111111111111";
const OID_2 = "2222222222222222222222222222222222222222";
const OID_3 = "3333333333333333333333333333333333333333";
const OID_4 = "4444444444444444444444444444444444444444";

// Reproduce git's `-z` output framing: NUL-terminated fields (trailing NUL after the last).
function zStream(fields: string[]): string {
  return fields.length ? `${fields.join("\0")}\0` : "";
}
function nameStatusZ(entries: Array<{ status: string; path: string }>): string {
  return zStream(entries.flatMap(entry => [entry.status, entry.path]));
}
function treeZ(entries: Array<{ mode: string; oid: string; path: string }>): string {
  return zStream(entries.map(entry => `${entry.mode} blob ${entry.oid}\t${entry.path}`));
}
function rawDiffZ(
  entries: Array<{ oldMode: string; newMode: string; oldOid: string; newOid: string; status: string; path: string }>,
): string {
  return zStream(entries.flatMap(entry =>
    [`:${entry.oldMode} ${entry.newMode} ${entry.oldOid} ${entry.newOid} ${entry.status}`, entry.path]));
}
function raw(entries: Array<{ path: string; oldMode: string; newMode: string }>): RawDiffEntry[] {
  return entries;
}

describe("splitNul", () => {
  it("splits NUL-delimited fields and drops the trailing empty", () => {
    expect(splitNul("a\0b\0")).toEqual(["a", "b"]);
  });
  it("treats empty output as no fields", () => {
    expect(splitNul("")).toEqual([]);
  });
});

describe("parseRawDiff", () => {
  it("parses valid `diff-tree --raw -z` entries", () => {
    const parsed = parseRawDiff(rawDiffZ([
      { oldMode: "100644", newMode: "100644", oldOid: OID_1, newOid: OID_2, status: "M", path: "a.txt" },
    ]));
    expect(parsed).toEqual([{ path: "a.txt", oldMode: "100644", newMode: "100644" }]);
  });
  it("fails closed on malformed metadata", () => {
    expect(() => parseRawDiff(zStream(["not-metadata", "a.txt"])))
      .toThrow("git diff-tree returned invalid raw output");
  });
});

describe("computeChangedPathManifest", () => {
  it("hashes an empty diff to the pinned golden and never embeds the format version", () => {
    const manifest = computeChangedPathManifest({ rawDiff: [], nameStatusOutput: "", treeOutput: "" });
    expect(manifest.changedPaths).toEqual([]);
    expect(manifest.manifestHash).toBe(EMPTY_HASH);
    // The version tag documents the format but must never enter the hashed bytes.
    expect(EMPTY_HASH).toBe(createHash("sha256").update("[]").digest("hex"));
    expect(MANIFEST_HASH_FORMAT).toBe("cap-v1");
  });

  it("produces the golden hash for a single modified file", () => {
    const manifest = computeChangedPathManifest({
      rawDiff: raw([{ path: "a.txt", oldMode: "100644", newMode: "100644" }]),
      nameStatusOutput: nameStatusZ([{ status: "M", path: "a.txt" }]),
      treeOutput: treeZ([{ mode: "100644", oid: OID_1, path: "a.txt" }]),
    });
    expect(manifest.changedPaths).toEqual([
      { path: "a.txt", changeType: "modified", mode: "100644", contentHash: OID_1 },
    ]);
    expect(manifest.manifestHash).toBe(GOLDEN1_HASH);
  });

  it("is input-order independent: unsorted git output yields the sorted golden manifest", () => {
    // Inputs deliberately reversed relative to sorted path order; also exercises
    // a binary blob (content-addressed by oid), unusual paths (space + unicode),
    // and a mode-only change (100644 -> 100755).
    const manifest = computeChangedPathManifest({
      rawDiff: raw([
        { path: "z with space/файл.txt", oldMode: "100644", newMode: "100755" },
        { path: "dir/b.bin", oldMode: "000000", newMode: "100644" },
      ]),
      nameStatusOutput: nameStatusZ([
        { status: "M", path: "z with space/файл.txt" },
        { status: "A", path: "dir/b.bin" },
      ]),
      treeOutput: treeZ([
        { mode: "100755", oid: OID_3, path: "z with space/файл.txt" },
        { mode: "100644", oid: OID_2, path: "dir/b.bin" },
      ]),
    });
    expect(manifest.changedPaths).toEqual([
      { path: "dir/b.bin", changeType: "added", mode: "100644", contentHash: OID_2 },
      { path: "z with space/файл.txt", changeType: "modified", mode: "100755", contentHash: OID_3 },
    ]);
    expect(manifest.manifestHash).toBe(GOLDEN2_HASH);
  });

  it("records a deletion with a null content hash and the old mode", () => {
    const manifest = computeChangedPathManifest({
      rawDiff: raw([{ path: "gone.txt", oldMode: "100644", newMode: "000000" }]),
      nameStatusOutput: nameStatusZ([{ status: "D", path: "gone.txt" }]),
      treeOutput: treeZ([]),
    });
    expect(manifest.changedPaths).toEqual([
      { path: "gone.txt", changeType: "deleted", mode: "100644", contentHash: null },
    ]);
  });

  it("represents a rename as a delete plus an add under --no-renames", () => {
    const manifest = computeChangedPathManifest({
      rawDiff: raw([
        { path: "old.txt", oldMode: "100644", newMode: "000000" },
        { path: "new.txt", oldMode: "000000", newMode: "100644" },
      ]),
      nameStatusOutput: nameStatusZ([
        { status: "D", path: "old.txt" },
        { status: "A", path: "new.txt" },
      ]),
      treeOutput: treeZ([{ mode: "100644", oid: OID_4, path: "new.txt" }]),
    });
    expect(manifest.changedPaths).toEqual([
      { path: "new.txt", changeType: "added", mode: "100644", contentHash: OID_4 },
      { path: "old.txt", changeType: "deleted", mode: "100644", contentHash: null },
    ]);
  });

  it("captures a mode-only change as the new mode with the unchanged oid", () => {
    const manifest = computeChangedPathManifest({
      rawDiff: raw([{ path: "exec.sh", oldMode: "100644", newMode: "100755" }]),
      nameStatusOutput: nameStatusZ([{ status: "M", path: "exec.sh" }]),
      treeOutput: treeZ([{ mode: "100755", oid: OID_1, path: "exec.sh" }]),
    });
    expect(manifest.changedPaths).toEqual([
      { path: "exec.sh", changeType: "modified", mode: "100755", contentHash: OID_1 },
    ]);
  });

  describe("fails closed on malformed or inconsistent git output", () => {
    it("odd name-status field count", () => {
      expect(() => computeChangedPathManifest({ rawDiff: [], nameStatusOutput: zStream(["A"]), treeOutput: "" }))
        .toThrow("git diff-tree returned invalid name-status output");
    });
    it("ls-tree record without a tab separator", () => {
      expect(() => computeChangedPathManifest({
        rawDiff: [],
        nameStatusOutput: "",
        treeOutput: zStream(["100644 blob abc"]),
      })).toThrow("git ls-tree returned invalid output");
    });
    it("a non-deleted path missing from the candidate tree", () => {
      expect(() => computeChangedPathManifest({
        rawDiff: raw([{ path: "m.txt", oldMode: "100644", newMode: "100644" }]),
        nameStatusOutput: nameStatusZ([{ status: "M", path: "m.txt" }]),
        treeOutput: treeZ([]),
      })).toThrow("candidate tree is missing a changed path");
    });
    it("a deleted path absent from both diff outputs", () => {
      expect(() => computeChangedPathManifest({
        rawDiff: [],
        nameStatusOutput: nameStatusZ([{ status: "D", path: "d.txt" }]),
        treeOutput: treeZ([]),
      })).toThrow("git diff-tree outputs disagree");
    });
  });
});

describe("canonicalization has a single owner (no bypass)", () => {
  const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));
  const owner = "git/changed-path-manifest.ts";

  it("no other src module hashes a changed-path manifest independently", () => {
    const offenders = readdirSync(srcRoot, { recursive: true, encoding: "utf8" })
      .map(entry => entry.split(path.sep).join("/"))
      .filter(rel => rel.endsWith(".ts") && rel !== owner)
      .filter(rel => readFileSync(path.join(srcRoot, rel), "utf8").includes("JSON.stringify(changedPaths)"));
    expect(offenders, "manifest hashing must live only in changed-path-manifest.ts").toEqual([]);
  });

  it("freeze and verify no longer re-fork the manifest parsers or hash", () => {
    for (const rel of ["git/candidate-tree.ts", "verify/structural-verifier.ts"]) {
      const text = readFileSync(path.join(srcRoot, rel), "utf8");
      expect(text, `${rel} must route parsing through the manifest module`).not.toMatch(/function parseRawDiff/);
      expect(text).not.toMatch(/function parseNameStatus/);
      expect(text).not.toMatch(/function parseTree/);
      expect(text).not.toMatch(/function sortChangedPaths/);
      expect(text, `${rel} must not hash the manifest independently`).not.toMatch(/createHash/);
    }
  });
});
