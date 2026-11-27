/**
 * Properties of canonicalization and of the spec hash over seeded random specs: the hash depends on the content
 * of a spec and on nothing else (property order, whitespace, escapes, a round trip through the canonical bytes),
 * and on every part of that content.
 */
import { describe, expect, test } from "bun:test";
import referenceCanonicalize from "canonicalize";
import { canonicalize, parseCanonical, specHash, validateSpec } from "../src/index.ts";
import { address, createRandom, utf8 } from "./helpers.ts";

type Random = (bound: number) => number;

const RUNS = 400;
const WORDS = ["Index", "Tech", "Équipe", "Größe", "日本", "€", "Ω", "ﬁ", "naïve", "50/50", '"quoted"', "a\\b"];

function pick<T>(random: Random, items: readonly T[]): T {
  const item = items[random(items.length)];
  if (item === undefined) throw new Error("empty list");
  return item;
}

/** `count` distinct addresses in ascending order. */
function ascendingAddresses(random: Random, count: number, base: number): string[] {
  const values = new Set<number>();
  while (values.size < count) values.add(base + random(1_000_000));
  return [...values].sort((a, b) => a - b).map((value) => address(value));
}

/** Positive weights that sum to exactly 10_000 bps. */
function fixedWeights(random: Random, count: number): number[] {
  const weights = Array.from({ length: count }, () => 1);
  for (let left = 10_000 - count; left > 0; ) {
    const step = Math.min(left, 1 + random(500));
    const index = random(count);
    weights[index] = (weights[index] ?? 0) + step;
    left -= step;
  }
  return weights;
}

/** A random spec that `validateSpec` accepts, built in a fixed property order. */
function randomSpec(random: Random): Record<string, unknown> {
  const count = 1 + random(64);
  const tokens = ascendingAddresses(random, count, 0xb20000);
  const fixed = random(2) === 0;
  const weights = fixed ? fixedWeights(random, count) : [];
  const spec: Record<string, unknown> = {
    schema: "equityos.index/1",
    calc: "equityos.calc/1",
    chainId: random(2) === 0 ? 8453 : 84532,
    name: `Random ${random(100_000)}`,
    slug: `random-${random(100_000)}`,
    description: Array.from({ length: 1 + random(6) }, () => pick(random, WORDS)).join(" "),
    universe: { type: "static", tokens },
    weighting: fixed ? { type: "fixed", weightsBps: weights } : { type: "equal" },
    pricing: { source: "chainlink-aggregator-v3", feeds: ascendingAddresses(random, count, 0xfeed0000) },
    rebalance: {
      trigger: "drift",
      driftThresholdBps: 1 + random(10_000),
      minIntervalSeconds: random(4) === 0 ? 0 : random(10_000_000),
    },
  };
  if (random(3) === 0) {
    const largest = fixed ? Math.max(...weights) : Math.ceil(10_000 / count);
    spec.constraints = { maxWeightBps: Math.min(10_000, largest + random(100)) };
  }
  return spec;
}

/** A deep copy of `value` with the properties of every object inserted in a random order. */
function shuffled(random: Random, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffled(random, item));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = random(i + 1);
    const a = entries[i];
    const b = entries[j];
    if (a === undefined || b === undefined) throw new Error("index out of range");
    entries[i] = b;
    entries[j] = a;
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, shuffled(random, item)]));
}

/** JSON text of `value` with whitespace around every token and every ASCII letter of every string escaped. */
function verboseJson(value: unknown): string {
  const spaced = JSON.stringify(value, null, "\t");
  return spaced.replace(/"((?:[^"\\]|\\.)*)"/g, (_match, body: string) => {
    const escaped = body.replace(/[A-Za-z]/g, (letter) => `\\u${letter.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return ` "${escaped}" `;
  });
}

function accepted(value: unknown): { bytes: Uint8Array; hash: string } {
  const validation = validateSpec(value);
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  return { bytes: validation.specBytes, hash: specHash(validation.specBytes) };
}

/** `value` with the properties of every object inserted in ascending UTF-16 order, the order RFC 8785 sorts by. */
function sortedDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedDeep);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedDeep(item)]));
}

describe("spec hash stability over random specs", () => {
  test("the generator covers both weightings, constraints, 1 to 64 tokens and non-ASCII descriptions", () => {
    const random = createRandom(0x5eed);
    const specs = Array.from({ length: RUNS }, () => randomSpec(random));
    const counts = specs.map((spec) => (spec.universe as { tokens: string[] }).tokens.length);
    expect(Math.min(...counts)).toBe(1);
    expect(Math.max(...counts)).toBe(64);
    const types = new Set(specs.map((spec) => (spec.weighting as { type: string }).type));
    expect(types).toEqual(new Set(["equal", "fixed"]));
    expect(specs.some((spec) => "constraints" in spec)).toBe(true);
    expect(specs.some((spec) => /[^\x20-\x7e]/.test(String(spec.description)))).toBe(true);
    for (const spec of specs) expect(validateSpec(spec).ok).toBe(true);
  });

  test("property order does not change the bytes or the hash", () => {
    const random = createRandom(0x0de5);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(random);
      const original = accepted(spec);
      for (let round = 0; round < 3; round++) {
        const reordered = accepted(shuffled(random, spec));
        expect(reordered.bytes).toEqual(original.bytes);
        expect(reordered.hash).toBe(original.hash);
      }
    }
  });

  test("whitespace and escapes in the JSON text do not change the hash", () => {
    const random = createRandom(0x7e57);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(random);
      const text = verboseJson(shuffled(random, spec));
      expect(text).not.toBe(JSON.stringify(spec));
      expect(accepted(JSON.parse(text)).hash).toBe(accepted(spec).hash);
    }
  });

  test("the bytes are the canonical form, agree with the canonicalize package and survive a round trip", () => {
    const random = createRandom(0xb17e);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(random);
      const { bytes, hash } = accepted(spec);
      const reference = referenceCanonicalize(spec);
      if (reference === undefined) throw new Error("the reference produced no output");
      expect(bytes).toEqual(utf8(reference));
      expect(canonicalize(spec)).toEqual(bytes);
      const parsed = parseCanonical(bytes);
      if (!parsed.ok) throw new Error(parsed.message);
      const again = accepted(parsed.value);
      expect(again.bytes).toEqual(bytes);
      expect(again.hash).toBe(hash);
    }
  });

  test("the hash is 32 bytes of lowercase hexadecimal, and equal hashes come only from equal bytes", () => {
    const random = createRandom(0x4a54);
    const seen = new Map<string, string>();
    for (let i = 0; i < RUNS; i++) {
      const { bytes, hash } = accepted(randomSpec(random));
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
      const text = new TextDecoder().decode(bytes);
      const earlier = seen.get(hash);
      if (earlier !== undefined) expect(earlier).toBe(text);
      seen.set(hash, text);
    }
    expect(seen.size).toBe(RUNS);
  });

  test("a change to any part of the content changes the hash", () => {
    const random = createRandom(0xc4a6);
    const nextAddress = (value: string | undefined) => address(Number.parseInt(value?.slice(2) ?? "0", 16) + 1);
    const edits: ((spec: Record<string, unknown>) => void)[] = [
      (spec) => {
        spec.chainId = spec.chainId === 8453 ? 84532 : 8453;
      },
      (spec) => {
        spec.name = `${String(spec.name)}x`;
      },
      (spec) => {
        spec.description = `${String(spec.description)}.`;
      },
      (spec) => {
        const rebalance = spec.rebalance as { driftThresholdBps: number };
        rebalance.driftThresholdBps = rebalance.driftThresholdBps === 1 ? 2 : rebalance.driftThresholdBps - 1;
      },
      (spec) => {
        const feeds = (spec.pricing as { feeds: string[] }).feeds;
        feeds[feeds.length - 1] = nextAddress(feeds.at(-1));
      },
      (spec) => {
        const tokens = (spec.universe as { tokens: string[] }).tokens;
        tokens[tokens.length - 1] = nextAddress(tokens.at(-1));
      },
    ];
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(random);
      const before = accepted(spec).hash;
      const edited = structuredClone(spec);
      pick(random, edits)(edited);
      expect(accepted(edited).hash).not.toBe(before);
    }
  });
});

describe("canonicalization properties over random specs", () => {
  test("canonical bytes have no insignificant whitespace and every object's names in sorted order", () => {
    const random = createRandom(0x50f7);
    for (let i = 0; i < RUNS; i++) {
      const text = new TextDecoder().decode(accepted(shuffled(random, randomSpec(random))).bytes);
      expect(text).toBe(JSON.stringify(sortedDeep(JSON.parse(text))));
    }
  });

  test("a non-canonical spelling of a spec is rejected by parseCanonical, its canonical bytes are accepted", () => {
    const random = createRandom(0x9e7c);
    for (let i = 0; i < RUNS; i++) {
      const spec = randomSpec(random);
      expect(parseCanonical(utf8(verboseJson(spec))).ok).toBe(false);
      expect(parseCanonical(accepted(spec).bytes).ok).toBe(true);
    }
  });
});
