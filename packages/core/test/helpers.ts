import type { Address, ReferencePrice, StalenessStatus } from "../src/index.ts";

/** Deterministic 32-bit generator (mulberry32), so that randomized tests reproduce exactly. */
export function createRandom(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % bound;
  };
}

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The address whose numeric value is `value`. */
export function address(value: number | bigint): Address {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

export function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1);
}

/** A valid spec with `count` constituents and equal weighting, as a plain mutable object. */
export function baseSpec(count: number): Record<string, unknown> {
  return {
    schema: "equityos.index/1",
    calc: "equityos.calc/1",
    chainId: 8453,
    name: `Test Index ${count}`,
    slug: `test-index-${count}`,
    description: "A test index.",
    universe: { type: "static", tokens: range(count).map((i) => address(0xb200 + i)) },
    weighting: { type: "equal" },
    pricing: { source: "chainlink-aggregator-v3", feeds: range(count).map((i) => address(0xfeed00 + i)) },
    rebalance: { trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 604_800 },
  };
}

/** A reference price entry, `live` unless stated. */
export function price(token: Address, priceE8: bigint, status: StalenessStatus = "live"): ReferencePrice {
  return { token, priceE8, status };
}
