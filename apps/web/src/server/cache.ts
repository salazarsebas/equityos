import "server-only";

export interface CachePolicy {
  /** Seconds a loaded value is served without reloading. `Infinity` for a value that never changes. */
  readonly ttlSeconds: number;
  /**
   * Seconds past the TTL during which the last value may still be served when a reload fails. Beyond it the
   * failure is thrown. Zero means never: a failed reload is always thrown, even for a value exactly at its TTL.
   */
  readonly staleIfErrorSeconds: number;
}

/** Policy of a value that cannot change once it exists: it is loaded once and never reloaded. */
export const IMMUTABLE: CachePolicy = { ttlSeconds: Number.POSITIVE_INFINITY, staleIfErrorSeconds: 0 };

export interface Cached<T> {
  readonly value: T;
  /** Time the value was loaded, Unix seconds. Serving it again, fresh or stale, never changes this. */
  readonly fetchedAt: number;
  /** True when the value is past its TTL and is served because the reload failed. */
  readonly servedStale: boolean;
  /** The reload failure behind a stale value, so that it is never swallowed. `null` otherwise. */
  readonly error: unknown;
}

export interface Cache<T> {
  /** @throws the load error when there is no value young enough to serve in its place. */
  get(): Promise<Cached<T>>;
}

/** Loads the values of the given keys in one operation. A key it leaves out has no value and is not cached. */
export type LoadMany<T> = (keys: readonly string[]) => Promise<ReadonlyMap<string, T>>;

export interface KeyedCache<T> {
  /**
   * The values of `keys`, loading in one call to `load` those that are neither fresh nor already being loaded.
   * A key the loader leaves out is absent from the result.
   *
   * @throws the load error when a key has no value young enough to serve in its place.
   */
  getMany(keys: readonly string[], load: LoadMany<T>): Promise<Map<string, Cached<T>>>;
}

export interface KeyedCacheOptions {
  /** Entries kept. Past it the entry loaded longest ago is dropped and is loaded again when next asked for. */
  readonly maxEntries?: number;
}

/**
 * In-process cache of one value per key, with a TTL and a stale-while-error window.
 *
 * - Within the TTL the stored value is returned.
 * - Past the TTL the loader runs, once for all the keys of a call that need it. Concurrent callers of a key
 *   share its load.
 * - If the load fails, the stale window is above zero and the stored value is within TTL plus the stale window,
 *   it is returned with `servedStale: true` and its original `fetchedAt`. Otherwise the error is thrown. A
 *   policy with a stale window of zero never serves a value stale.
 *
 * A failed load and a key the loader leaves out are not cached: the next call tries again.
 *
 * @param now clock in Unix seconds
 */
export function createKeyedCache<T>(
  policy: CachePolicy,
  now: () => number,
  options: KeyedCacheOptions = {},
): KeyedCache<T> {
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const entries = new Map<string, { readonly value: T; readonly fetchedAt: number }>();
  const pending = new Map<string, Promise<Cached<T> | undefined>>();

  function store(key: string, value: T, fetchedAt: number): void {
    // Deleting first moves the key to the end, so the first key of the map is always the oldest load.
    entries.delete(key);
    entries.set(key, { value, fetchedAt });
    for (const oldest of entries.keys()) {
      if (entries.size <= maxEntries) break;
      entries.delete(oldest);
    }
  }

  function reload(keys: readonly string[], load: LoadMany<T>): void {
    // Stamped before the load starts: a value is at least as old as the request that produced it.
    const startedAt = now();
    const loading = load(keys);
    for (const key of keys) {
      const settled = loading
        .then((loaded): Cached<T> | undefined => {
          if (!loaded.has(key)) return undefined;
          const value = loaded.get(key) as T;
          store(key, value, startedAt);
          return { value, fetchedAt: startedAt, servedStale: false, error: null };
        })
        .catch((error: unknown): Cached<T> => {
          const entry = entries.get(key);
          const stale = entry !== undefined && policy.staleIfErrorSeconds > 0;
          if (stale && now() - entry.fetchedAt <= policy.ttlSeconds + policy.staleIfErrorSeconds) {
            return { value: entry.value, fetchedAt: entry.fetchedAt, servedStale: true, error };
          }
          throw error;
        })
        .finally(() => {
          pending.delete(key);
        });
      pending.set(key, settled);
    }
  }

  return {
    async getMany(keys: readonly string[], load: LoadMany<T>): Promise<Map<string, Cached<T>>> {
      const unique = [...new Set(keys)];
      const isFresh = (key: string): boolean => {
        const entry = entries.get(key);
        return entry !== undefined && now() - entry.fetchedAt < policy.ttlSeconds;
      };
      const missing = unique.filter((key) => !isFresh(key) && !pending.has(key));
      if (missing.length > 0) reload(missing, load);
      const results = new Map<string, Cached<T>>();
      await Promise.all(
        unique.map(async (key) => {
          const entry = entries.get(key);
          const cached =
            entry !== undefined && isFresh(key)
              ? { value: entry.value, fetchedAt: entry.fetchedAt, servedStale: false, error: null }
              : await pending.get(key);
          if (cached !== undefined) results.set(key, cached);
        }),
      );
      return results;
    },
  };
}

/**
 * In-process cache of a single value: `createKeyedCache` with one key and a fixed loader.
 *
 * @param now clock in Unix seconds
 */
export function createCache<T>(policy: CachePolicy, load: () => Promise<T>, now: () => number): Cache<T> {
  const KEY = "value";
  const cache = createKeyedCache<T>(policy, now);
  const loadOne: LoadMany<T> = async () => new Map([[KEY, await load()]]);
  return {
    async get(): Promise<Cached<T>> {
      const cached = (await cache.getMany([KEY], loadOne)).get(KEY);
      if (cached === undefined) throw new Error("the loader returned no value");
      return cached;
    },
  };
}
