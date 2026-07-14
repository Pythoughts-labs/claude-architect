import { describe, it, expect } from "vitest";
import { supervise } from "../../src/platform/process-supervisor.js";
import { getPlatformServices } from "../../src/platform/select-platform.js";
import { fileURLToPath } from "node:url";
const ps = getPlatformServices();
const fixture = fileURLToPath(new URL("./fixtures/echo-sleep.mjs", import.meta.url));
async function run(args: string[], timeoutMs: number, onCancel?: AbortSignal) {
  const node = await ps.resolveExecutable({ name: "node" });
  return supervise(ps, { executable: node, args: [fixture, ...args], cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" }, timeoutMs, maxOutputBytes: 1_000_000 }, { onCancel });
}
describe("supervise", () => {
  it("returns exit 0 for a fast process", async () => expect((await run(["hi", "", "0"], 5000)).exitCode).toBe(0));
  it("times out a stubborn process and kills the tree", async () => {
    const exit = await run(["", "", "60000", "stubborn"], 800);
    expect(exit.timedOut).toBe(true);
  }, 15000);
  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const exit = await run(["", "", "60000"], 30000, ac.signal);
    expect(exit.cancelled).toBe(true);
  }, 15000);
  it("returns spawn-failure marker for a missing executable", async () => {
    const exit = await supervise(ps, { executable: { kind: "native", command: "/no/such/bin", prefixArgs: [], resolvedFrom: "test" },
      args: [], cwd: process.cwd(), env: {}, timeoutMs: 5000, maxOutputBytes: 1000 }, {});
    expect(exit.spawnError).toBeDefined();
  });
});
