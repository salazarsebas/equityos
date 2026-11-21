import "server-only";

export interface CachePolicy {
  /** Seconds a loaded value is served without reloading. */
  readonly ttlSeconds: number;
  /**
   * Seconds past the TTL during which the last value may still be served when a reload fails. Beyond it the
   * failure is thrown.
   */
  readonly staleIfErrorSeconds: number;
}

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

/**
 * In-process cache of a single value with a TTL and a stale-while-error window.
 *
 * - Within the TTL the stored value is returned.
 * - Past the TTL the loader runs. Concurrent callers share one load.
 * - If the load fails and the stored value is within TTL plus the stale window, it is returned with
 *   `servedStale: true` and its original `fetchedAt`. Otherwise the error is thrown.
 *
 * A failed load is not cached: the next call tries again.
 *
 * @param now clock in Unix seconds
 */
export function createCache<T>(policy: CachePolicy, load: () => Promise<T>, now: () => number): Cache<T> {
  let entry: { value: T; fetchedAt: number } | null = null;
  let pending: Promise<Cached<T>> | null = null;

  async function reload(): Promise<Cached<T>> {
    // Stamped before the load starts: the value is at least as old as the request that produced it.
    const startedAt = now();
    try {
      const value = await load();
      entry = { value, fetchedAt: startedAt };
      return { value, fetchedAt: startedAt, servedStale: false, error: null };
    } catch (error) {
      if (entry !== null && now() - entry.fetchedAt <= policy.ttlSeconds + policy.staleIfErrorSeconds) {
        return { value: entry.value, fetchedAt: entry.fetchedAt, servedStale: true, error };
      }
      throw error;
    }
  }

  return {
    get(): Promise<Cached<T>> {
      if (entry !== null && now() - entry.fetchedAt < policy.ttlSeconds) {
        return Promise.resolve({ value: entry.value, fetchedAt: entry.fetchedAt, servedStale: false, error: null });
      }
      pending ??= reload().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
