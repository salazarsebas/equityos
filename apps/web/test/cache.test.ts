import { describe, expect, test } from "bun:test";
import { createCache, createKeyedCache, IMMUTABLE } from "../src/server/cache";

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

  test("a stale window of zero never serves stale, not even a value exactly at its TTL", async () => {
    const state = { now: 1_000, loads: 0 };
    const policy = { ttlSeconds: 15, staleIfErrorSeconds: 0 };
    const cache = createCache(
      policy,
      async () => {
        state.loads += 1;
        if (state.loads > 1) throw new Error(`load ${state.loads} failed`);
        return "value-1";
      },
      () => state.now,
    );
    await cache.get();
    state.now = 1_015;
    await expect(cache.get()).rejects.toThrow("load 2 failed");
    const keyed = createKeyedCache<string>(policy, () => state.now);
    state.now = 2_000;
    await keyed.getMany(["a"], async () => new Map([["a", "first"]]));
    state.now = 2_015;
    const failing = async (): Promise<Map<string, string>> => {
      throw new Error("reload failed");
    };
    await expect(keyed.getMany(["a"], failing)).rejects.toThrow("reload failed");
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

describe("createKeyedCache", () => {
  function keyed(policy = POLICY, maxEntries?: number) {
    const state = { now: 1_000, fail: false, batches: [] as string[][] };
    const cache = createKeyedCache<string>(policy, () => state.now, maxEntries === undefined ? {} : { maxEntries });
    const load = async (keys: readonly string[]) => {
      state.batches.push([...keys]);
      if (state.fail) throw new Error("load failed");
      return new Map(keys.filter((key) => key !== "missing").map((key) => [key, `${key}@${state.now}`]));
    };
    const values = async (keys: readonly string[]) =>
      Object.fromEntries([...(await cache.getMany(keys, load))].map(([key, cached]) => [key, cached.value]));
    return { state, cache, load, values };
  }

  test("loads the keys that are not fresh in one batch and serves the others", async () => {
    const { state, values } = keyed();
    expect(await values(["a", "b"])).toEqual({ a: "a@1000", b: "b@1000" });
    state.now = 1_010;
    expect(await values(["b", "c", "b"])).toEqual({ b: "b@1000", c: "c@1010" });
    state.now = 1_015;
    expect(await values(["a", "b", "c"])).toEqual({ a: "a@1015", b: "b@1015", c: "c@1010" });
    expect(state.batches).toEqual([["a", "b"], ["c"], ["a", "b"]]);
  });

  test("a key the loader leaves out has no value and is asked for again", async () => {
    const { state, values } = keyed();
    expect(await values(["a", "missing"])).toEqual({ a: "a@1000" });
    expect(await values(["a", "missing"])).toEqual({ a: "a@1000" });
    expect(state.batches).toEqual([["a", "missing"], ["missing"]]);
  });

  test("concurrent callers share the load of a key, also across different batches", async () => {
    const { state, values } = keyed();
    const [first, second] = await Promise.all([values(["a", "b"]), values(["b", "c"])]);
    expect(first).toEqual({ a: "a@1000", b: "b@1000" });
    expect(second).toEqual({ b: "b@1000", c: "c@1000" });
    expect(state.batches).toEqual([["a", "b"], ["c"]]);
  });

  test("serves a stale value per key inside the window and throws for a key that has none", async () => {
    const { state, cache, load } = keyed();
    await cache.getMany(["a"], load);
    state.now = 1_100;
    state.fail = true;
    const stale = (await cache.getMany(["a"], load)).get("a");
    expect(stale).toMatchObject({ value: "a@1000", fetchedAt: 1_000, servedStale: true });
    expect(stale?.error).toBeInstanceOf(Error);
    await expect(cache.getMany(["a", "b"], load)).rejects.toThrow("load failed");
    state.now = 1_316;
    await expect(cache.getMany(["a"], load)).rejects.toThrow("load failed");
  });

  test("an immutable value is loaded once and never again", async () => {
    const { state, values } = keyed(IMMUTABLE);
    expect(await values(["a"])).toEqual({ a: "a@1000" });
    state.now = 1_000_000_000;
    expect(await values(["a"])).toEqual({ a: "a@1000" });
    expect(state.batches).toEqual([["a"]]);
  });

  test("an immutable value is not replaced by a failure and a failure is not kept", async () => {
    const { state, cache, load, values } = keyed(IMMUTABLE);
    state.fail = true;
    await expect(cache.getMany(["a"], load)).rejects.toThrow("load failed");
    state.fail = false;
    expect(await values(["a"])).toEqual({ a: "a@1000" });
  });

  test("drops the entry loaded longest ago past the maximum number of entries", async () => {
    const { state, values } = keyed(IMMUTABLE, 2);
    await values(["a"]);
    await values(["b"]);
    await values(["c"]);
    expect(await values(["b", "c"])).toEqual({ b: "b@1000", c: "c@1000" });
    expect(state.batches).toEqual([["a"], ["b"], ["c"]]);
    state.now = 2_000;
    expect(await values(["a"])).toEqual({ a: "a@2000" });
  });
});
