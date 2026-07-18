import { describe, expect, it, vi } from "vitest";
import { loadSchemas } from "../../src/protocol/schema-loader.js";
import { extractJson, parseStructuredReport } from "../../src/pipeline/structured-output.js";
import type { VerificationReport } from "../../src/pipeline/report-types.js";

const good: VerificationReport = {
  reportVersion: "1", pass: true, commandResults: [], workspaceClean: true,
  testsDeleted: 0, testsSkipped: 0, scopeViolations: [],
};

describe("extractJson", () => {
  it("extracts a fenced json block from chatter", () => {
    const raw = "Here is my report:\n```json\n" + JSON.stringify(good) + "\n```\nDone.";
    expect(JSON.parse(extractJson(raw)!)).toEqual(good);
  });

  it("ignores fence markers embedded in JSON string values", () => {
    const report = { evidence: "renders it between \"```json\" and \"```\"" };
    const raw = "```json\n" + JSON.stringify(report) + "\n```";
    expect(JSON.parse(extractJson(raw)!)).toEqual(report);
  });

  it("prefers the last parseable fenced block", () => {
    const first = { evidence: "quotes \"```json\" and \"```\" markers" };
    const last = { evidence: "later report" };
    const raw = [
      "```json",
      JSON.stringify(first),
      "```",
      "intervening chatter",
      "```json",
      JSON.stringify(last),
      "```",
    ].join("\n");
    expect(JSON.parse(extractJson(raw)!)).toEqual(last);
  });

  it("extracts a fenced json block with CRLF line endings", () => {
    const raw = "```json\r\n" + JSON.stringify(good) + "\r\n```";
    expect(JSON.parse(extractJson(raw)!)).toEqual(good);
  });

  it("accepts bare JSON", () => {
    expect(JSON.parse(extractJson(JSON.stringify(good))!)).toEqual(good);
  });
  it("returns null for garbage", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("parseStructuredReport", () => {
  it("parses valid output without invoking repair", async () => {
    const repair = vi.fn();
    const out = await parseStructuredReport<VerificationReport>(
      JSON.stringify(good), loadSchemas().verificationReport, repair);
    expect(out).toEqual({ ok: true, value: good, repaired: false });
    expect(repair).not.toHaveBeenCalled();
  });

  it("retries exactly once on invalid output, then succeeds", async () => {
    const repair = vi.fn(async () => JSON.stringify(good));
    const out = await parseStructuredReport<VerificationReport>(
      "{\"pass\": true}", loadSchemas().verificationReport, repair);
    expect(out.ok).toBe(true);
    expect(out.ok && out.repaired).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it("fails the phase when the repair attempt is also invalid", async () => {
    const repair = vi.fn(async () => "still garbage");
    const out = await parseStructuredReport<VerificationReport>(
      "garbage", loadSchemas().verificationReport, repair);
    expect(out.ok).toBe(false);
    expect(repair).toHaveBeenCalledTimes(1);
  });
});
