import "server-only";

/**
 * In-process rate limits of the execution plan endpoint. They hold per server instance: every instance has its
 * own buckets, so N instances admit up to N times the rates below. A shared store (Redis, a platform rate
 * limiter) would make them hold per deployment, which the provider budget needs to match the provider's limit
 * exactly; until then a deployment should also limit the route in front of the app.
 */

/** A token bucket: up to `capacity` tokens, refilled at `perSecond`. Time in milliseconds. */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  private refill(): void {
    const at = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((at - this.updatedAt) / 1000) * this.perSecond);
    this.updatedAt = at;
  }

  /** Takes `count` tokens, or none and the whole seconds after which `count` will be available. */
  take(count: number): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number } {
    this.refill();
    if (count <= this.tokens) {
      this.tokens -= count;
      return { ok: true };
    }
    if (count > this.capacity) return { ok: false, retryAfterSeconds: Math.ceil(this.capacity / this.perSecond) };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((count - this.tokens) / this.perSecond)) };
  }

  /** Whether the bucket is full, so that forgetting it changes nothing. */
  full(): boolean {
    this.refill();
    return this.tokens >= this.capacity;
  }
}

/** One bucket per key, at most `maxKeys` of them: a full bucket is dropped first, then the oldest key. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number,
    private readonly maxKeys: number,
  ) {}

  take(key: string, count: number): ReturnType<TokenBucket["take"]> {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evict();
      bucket = new TokenBucket(this.capacity, this.perSecond, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(count);
  }

  private evict(): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.full()) {
        this.buckets.delete(key);
        return;
      }
    }
    const oldest = this.buckets.keys().next();
    if (oldest.done !== true) this.buckets.delete(oldest.value);
  }
}

/**
 * Plans per client address: 3 at once, then one every 20 seconds. A plan lives 120 seconds, so a person who
 * quotes again after each expiry never meets the limit.
 */
export const CLIENT_LIMIT = { capacity: 3, perSecond: 1 / 20, maxKeys: 10_000 } as const;

/**
 * Provider requests of the whole instance: 10 at once, refilled at one per second. That is the limit KyberSwap
 * applied to keyless clients, 10 requests per 10 seconds, so the instance never causes a 429 by itself.
 */
export const PROVIDER_LIMIT = { capacity: 10, perSecond: 1 } as const;

export interface ExecutionLimits {
  readonly clients: KeyedBuckets;
  readonly provider: TokenBucket;
}

export function createExecutionLimits(now: () => number = Date.now): ExecutionLimits {
  return {
    clients: new KeyedBuckets(CLIENT_LIMIT.capacity, CLIENT_LIMIT.perSecond, now, CLIENT_LIMIT.maxKeys),
    provider: new TokenBucket(PROVIDER_LIMIT.capacity, PROVIDER_LIMIT.perSecond, now),
  };
}

/**
 * The address a request comes from, as the hosting platform reports it: `x-real-ip`, else the first entry of
 * `x-forwarded-for`. Requests without either share one key. Like the jurisdiction gate, it trusts the platform
 * proxy and can be forged when the server is reachable without it.
 */
export function clientKey(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded ? forwarded : "unknown";
}
