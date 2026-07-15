import { describe, expect, it } from "vitest";
import { withRepoLock } from "../../src/mcp/serialize.js";

describe("withRepoLock", () => {
  it("runs overlapping work for the same repository sequentially", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });

    const first = withRepoLock("repo-a", async () => {
      events.push("first:start");
      await firstMayFinish;
      events.push("first:end");
    });
    const second = withRepoLock("repo-a", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("runs work for different repositories concurrently", async () => {
    const active = new Set<string>();
    let maximumActive = 0;
    let release!: () => void;
    const mayFinish = new Promise<void>(resolve => {
      release = resolve;
    });

    const run = (key: string) => withRepoLock(key, async () => {
      active.add(key);
      maximumActive = Math.max(maximumActive, active.size);
      await mayFinish;
      active.delete(key);
    });
    const first = run("repo-a");
    const second = run("repo-b");

    await Promise.resolve();
    expect(maximumActive).toBe(2);
    release();
    await Promise.all([first, second]);
  });

  it("releases a repository after failed work", async () => {
    await expect(withRepoLock("repo-failure", async () => {
      throw new Error("failed");
    })).rejects.toThrow("failed");

    await expect(withRepoLock("repo-failure", async () => "recovered"))
      .resolves.toBe("recovered");
  });
});
