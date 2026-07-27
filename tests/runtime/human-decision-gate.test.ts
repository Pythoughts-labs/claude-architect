import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { confirmWithHuman } from "../../src/mcp/server.js";

type ElicitResponse = { action: string; content?: Record<string, unknown> };

function fakeServer(options: {
  elicitationSupported?: boolean;
  respond?: () => Promise<ElicitResponse>;
}): { server: Pick<McpServer, "server">; elicited: () => number } {
  let calls = 0;
  const server = {
    server: {
      getClientCapabilities: () =>
        (options.elicitationSupported ?? true) ? { elicitation: {} } : {},
      elicitInput: async () => {
        calls += 1;
        return await (options.respond ?? (async () => ({
          action: "accept",
          content: { confirm: true },
        })))();
      },
    },
  } as unknown as Pick<McpServer, "server">;
  return { server, elicited: () => calls };
}

describe("human decision gate", () => {
  // "Only a human can accept a candidate" was documented but structurally
  // unenforced: decideCandidate recorded whatever its caller passed, and an
  // agent is a caller.
  it("passes when a human confirms through elicitation", async () => {
    const { server, elicited } = fakeServer({});
    await expect(confirmWithHuman(server, "run-1", "accepted")).resolves.toEqual({ ok: true });
    expect(elicited()).toBe(1);
  });

  // Degrading to "trust the caller" would silently restore the hole this closes.
  it("fails closed when the client cannot elicit", async () => {
    const { server, elicited } = fakeServer({ elicitationSupported: false });
    const outcome = await confirmWithHuman(server, "run-1", "accepted");
    expect(outcome).toMatchObject({ ok: false, error: { error: "elicitation-unavailable" } });
    expect(elicited()).toBe(0);
  });

  it.each(["decline", "cancel"])("records nothing when the human answers %s", async action => {
    const { server } = fakeServer({ respond: async () => ({ action }) });
    await expect(confirmWithHuman(server, "run-1", "accepted"))
      .resolves.toMatchObject({ ok: false, error: { error: "decision-not-confirmed" } });
  });

  // Accepting the elicitation dialog without ticking the box is not a decision.
  it("records nothing when the form comes back unconfirmed", async () => {
    const { server } = fakeServer({
      respond: async () => ({ action: "accept", content: { confirm: false } }),
    });
    await expect(confirmWithHuman(server, "run-1", "accepted"))
      .resolves.toMatchObject({ ok: false, error: { error: "decision-not-confirmed" } });
  });

  it("fails closed when elicitation itself errors", async () => {
    const { server } = fakeServer({
      respond: async () => { throw new Error("transport closed"); },
    });
    await expect(confirmWithHuman(server, "run-1", "accepted"))
      .resolves.toMatchObject({ ok: false, error: { error: "elicitation-failed" } });
  });

  // An agent that can freely discard a candidate can bury work it dislikes, so
  // rejection and revision are gated exactly like acceptance.
  it.each(["rejected", "revision-requested"] as const)(
    "gates %s behind the same confirmation",
    async decision => {
      const { server, elicited } = fakeServer({ elicitationSupported: false });
      await expect(confirmWithHuman(server, "run-1", decision))
        .resolves.toMatchObject({ ok: false, error: { error: "elicitation-unavailable" } });
      expect(elicited()).toBe(0);
    },
  );

  it("names the decision and run in the prompt the human sees", async () => {
    const elicitInput = vi.fn(async () => ({ action: "accept", content: { confirm: true } }));
    const server = {
      server: { getClientCapabilities: () => ({ elicitation: {} }), elicitInput },
    } as unknown as Pick<McpServer, "server">;

    await confirmWithHuman(server, "run-abc", "accepted");

    const message = String((elicitInput.mock.calls[0]?.[0] as { message: string }).message);
    expect(message).toContain("run-abc");
    expect(message).toContain("accepted");
  });
});
