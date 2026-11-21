import { describe, expect, test } from "bun:test";
import { createCache } from "../../src/server/market/cache";

const POLICY = { ttlSeconds: 15, staleIfErrorSeconds: 300 };

function harness(start = 1_000) {
  const state = { now: start, loads: 0, fail: false };
  const cache = createCache(
    POLICY,
    async () => {
      state.loads += 1;
      if (state.fail) throw new Error(`load ${state.loads} failed`);
      return `value-${state.loads}`;
    },
    () => state.now,
  );
  return { state, cache };
}

describe("createCache", () => {
  test("serves the loaded value without reloading until the TTL has passed", async () => {
    const { state, cache } = harness();
    expect(await cache.get()).toEqual({ value: "value-1", fetchedAt: 1_000, servedStale: false, error: null });
    state.now = 1_014;
    expect(await cache.get()).toEqual({ value: "value-1", fetchedAt: 1_000, servedStale: false, error: null });
    expect(state.loads).toBe(1);
  });

  test("reloads exactly at the TTL", async () => {
    const { state, cache } = harness();
    await cache.get();
    state.now = 1_015;
    expect(await cache.get()).toEqual({ value: "value-2", fetchedAt: 1_015, servedStale: false, error: null });
    expect(state.loads).toBe(2);
  });

  test("stamps the value with the time the load started, not the time it finished", async () => {
    const state = { now: 1_000 };
    const cache = createCache(
      POLICY,
      async () => {
        state.now += 7;
        return "slow";
      },
      () => state.now,
    );
    expect((await cache.get()).fetchedAt).toBe(1_000);
  });

  test("serves the last value with its original timestamp when the reload fails", async () => {
    const { state, cache } = harness();
    await cache.get();
    state.fail = true;
    state.now = 1_100;
    const stale = await cache.get();
    expect(stale).toMatchObject({ value: "value-1", fetchedAt: 1_000, servedStale: true });
    expect(stale.error).toEqual(new Error("load 2 failed"));
    state.now = 1_200;
    expect(await cache.get()).toMatchObject({ value: "value-1", fetchedAt: 1_000, servedStale: true });
  });

  test("a stale value is not cached as fresh: every call retries the load", async () => {
    const { state, cache } = harness();
    await cache.get();
    state.fail = true;
    state.now = 1_100;
    await cache.get();
    await cache.get();
    expect(state.loads).toBe(3);
    state.fail = false;
    expect(await cache.get()).toEqual({ value: "value-4", fetchedAt: 1_100, servedStale: false, error: null });
  });

  test("serves stale up to TTL plus the stale window, then throws the load error", async () => {
    const { state, cache } = harness();
    await cache.get();
    state.fail = true;
    state.now = 1_000 + 15 + 300;
    expect(await cache.get()).toMatchObject({ fetchedAt: 1_000, servedStale: true });
    state.now = 1_000 + 15 + 300 + 1;
    await expect(cache.get()).rejects.toThrow("load 3 failed");
  });

  test("throws when the first load fails, and tries again on the next call", async () => {
    const { state, cache } = harness();
    state.fail = true;
    await expect(cache.get()).rejects.toThrow("load 1 failed");
    state.fail = false;
    expect(await cache.get()).toMatchObject({ value: "value-2", servedStale: false });
  });

  test("concurrent callers share one load", async () => {
    const { state, cache } = harness();
    const results = await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(state.loads).toBe(1);
    expect(results.map((result) => result.value)).toEqual(["value-1", "value-1", "value-1"]);
  });
});
