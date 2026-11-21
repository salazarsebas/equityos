import { describe, expect, test } from "bun:test";
import { canonicalize, MAX_CONSTITUENTS, MAX_SPEC_BYTES, type SpecErrorCode, validateSpec } from "../src/index.ts";
import { address, baseSpec, range } from "./helpers.ts";

type Spec = Record<string, unknown>;

/** Canonical size of the largest spec the schema allows, with an empty description. */
const MAXIMAL_EMPTY_BYTES = 6801;

/** The `path code` pairs reported for a document, in order. */
function errors(value: unknown): string[] {
  const result = validateSpec(value);
  return result.ok ? [] : result.errors.map(({ path, code }) => `${path} ${code}`);
}

function withTokens(count: number, overrides: Spec = {}): Spec {
  return { ...baseSpec(count), ...overrides };
}

function fixed(weightsBps: readonly unknown[], overrides: Spec = {}): Spec {
  return withTokens(weightsBps.length, { weighting: { type: "fixed", weightsBps }, ...overrides });
}

describe("validateSpec on valid documents", () => {
  test("returns the typed spec and its canonical bytes", () => {
    const input = baseSpec(3);
    const result = validateSpec(input);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect<unknown>(result.spec).toEqual(input);
    expect(result.spec).not.toBe(input);
    expect(result.specBytes).toEqual(canonicalize(input));
  });

  test("does not depend on property order", () => {
    const input = baseSpec(3);
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    const [a, b] = [validateSpec(input), validateSpec(reversed)];
    if (!a.ok || !b.ok) throw new Error("expected both to be valid");
    expect(b.specBytes).toEqual(a.specBytes);
  });

  test("accepts every optional part", () => {
    const parent = {
      chainId: 1,
      registry: address(0xaa),
      indexId: `0x${"1a".repeat(32)}`,
      version: 4_294_967_295,
      specHash: `0x${"c3".repeat(32)}`,
    };
    const full = fixed([5000, 3000, 2000], { constraints: { maxWeightBps: 5000, minWeightBps: 2000 }, parent });
    expect(errors(full)).toEqual([]);
    expect(errors(withTokens(3, { constraints: { minWeightBps: 1 } }))).toEqual([]);
  });

  test("accepts one constituent and rejects none", () => {
    expect(errors(baseSpec(1))).toEqual([]);
    expect(errors(fixed([10_000]))).toEqual([]);
    expect(errors(baseSpec(0))).toEqual(["/universe/tokens too_few_items"]);
  });
});

describe("validateSpec structure", () => {
  test("rejects a root that is not a plain object", () => {
    class Instance {
      readonly schema = "equityos.index/1";
    }
    for (const root of [
      null,
      undefined,
      1,
      "{}",
      [],
      [baseSpec(1)],
      new Instance(),
      new Map(),
      Object.create(baseSpec(1)),
    ]) {
      expect(errors(root)).toEqual([" invalid_type"]);
    }
  });

  test("reports only the schema when it is not supported", () => {
    const other = { schema: "equityos.index/2", anything: [1.5, null] };
    expect(errors(other)).toEqual(["/schema unsupported_schema"]);
    expect(errors({ ...baseSpec(2), schema: "EQUITYOS.INDEX/1" })).toEqual(["/schema unsupported_schema"]);
    expect(errors({ ...baseSpec(2), schema: 1 })).toEqual(["/schema invalid_type"]);
  });

  test("reports an unsupported calc together with other violations", () => {
    expect(errors({ ...baseSpec(2), calc: "equityos.calc/2", chainId: 0 })).toEqual([
      "/calc unsupported_calc",
      "/chainId out_of_range",
    ]);
  });

  test("rejects a missing or null value for every required property", () => {
    const required = [
      "calc",
      "chainId",
      "description",
      "name",
      "pricing",
      "rebalance",
      "schema",
      "slug",
      "universe",
      "weighting",
    ];
    for (const key of required) {
      const { [key]: _removed, ...rest } = baseSpec(2);
      expect(errors(rest)).toEqual([`/${key} missing_property`]);
      expect(errors({ ...baseSpec(2), [key]: null })).toEqual([`/${key} invalid_type`]);
    }
  });

  test("rejects null for the optional properties instead of treating it as absent", () => {
    expect(errors({ ...baseSpec(2), constraints: null })).toEqual(["/constraints invalid_type"]);
    expect(errors({ ...baseSpec(2), parent: null })).toEqual(["/parent invalid_type"]);
  });

  test("rejects unknown properties at every level", () => {
    const spec = baseSpec(2);
    const nested = ["universe", "weighting", "pricing", "rebalance"];
    expect(errors({ ...spec, extra: 1 })).toEqual(["/extra unknown_property"]);
    for (const key of nested) {
      const child = { ...Object(spec[key]), extra: 1 };
      expect(errors({ ...spec, [key]: child })).toEqual([`/${key}/extra unknown_property`]);
    }
    expect(errors({ ...spec, constraints: { maxWeightBps: 5000, extra: 1 } })).toEqual([
      "/constraints/extra unknown_property",
    ]);
    const parent = {
      chainId: 1,
      registry: address(1),
      indexId: `0x${"00".repeat(32)}`,
      version: 1,
      specHash: `0x${"00".repeat(32)}`,
    };
    expect(errors({ ...spec, parent: { ...parent, extra: 1 } })).toEqual(["/parent/extra unknown_property"]);
  });

  test("writes paths as JSON Pointers", () => {
    expect(errors({ ...baseSpec(2), "a/b~c": 1 })).toEqual(["/a~1b~0c unknown_property"]);
  });

  test("reports every violation of a document, in a stable order", () => {
    const broken = {
      ...baseSpec(2),
      chainId: 1.5,
      name: "",
      slug: "-",
      universe: { type: "static", tokens: [address(2), address(1)] },
      rebalance: { trigger: "drift", driftThresholdBps: 0, minIntervalSeconds: 0, extra: true },
    };
    expect(errors(broken)).toEqual([
      "/chainId not_safe_integer",
      "/name invalid_name",
      "/slug invalid_slug",
      "/universe/tokens/1 tokens_not_strictly_ascending",
      "/rebalance/extra unknown_property",
      "/rebalance/driftThresholdBps out_of_range",
    ]);
  });

  test("gives every error a message", () => {
    const result = validateSpec({ ...baseSpec(2), chainId: "1", extra: 1 });
    if (result.ok) throw new Error("expected errors");
    for (const error of result.errors) expect(error.message.length).toBeGreaterThan(10);
  });
});

describe("validateSpec scalars", () => {
  test("accepts only integers below 2^53", () => {
    const cases: [unknown, SpecErrorCode | undefined][] = [
      [1, undefined],
      [Number.MAX_SAFE_INTEGER, undefined],
      [2 ** 53, "not_safe_integer"],
      [1e21, "not_safe_integer"],
      [8453.5, "not_safe_integer"],
      [Number.NaN, "not_safe_integer"],
      [Number.POSITIVE_INFINITY, "not_safe_integer"],
      [0, "out_of_range"],
      [-1, "out_of_range"],
      ["8453", "invalid_type"],
      [8453n, "invalid_type"],
      [true, "invalid_type"],
      [[8453], "invalid_type"],
    ];
    for (const [chainId, code] of cases) {
      expect(errors({ ...baseSpec(2), chainId })).toEqual(code === undefined ? [] : [`/chainId ${code}`]);
    }
  });

  test("requires name to be 1 to 64 printable ASCII characters", () => {
    for (const name of ["A", " ", "~", "Example Equal Weight 10", "N".repeat(64), "a  b", '"quoted" \\ /']) {
      expect(errors({ ...baseSpec(2), name })).toEqual([]);
    }
    const del = String.fromCharCode(0x7f);
    const eAcute = String.fromCharCode(0xe9);
    for (const name of [
      "",
      "N".repeat(65),
      "a\tb",
      "a\nb",
      `a${del}`,
      `caf${eAcute}`,
      "\u0000",
      String.fromCodePoint(0x1f600),
    ]) {
      expect(errors({ ...baseSpec(2), name })).toEqual(["/name invalid_name"]);
    }
  });

  test("requires slug to match the published pattern", () => {
    for (const slug of ["a", "0", "ab", "a-b", "a--b", "example-equal-10", "a".repeat(32), `a${"-".repeat(30)}b`]) {
      expect(errors({ ...baseSpec(2), slug })).toEqual([]);
    }
    for (const slug of [
      "",
      "-",
      "-a",
      "a-",
      "A",
      "a_b",
      "a b",
      "a.b",
      "a".repeat(33),
      "a\n",
      `caf${String.fromCharCode(0xe9)}`,
    ]) {
      expect(errors({ ...baseSpec(2), slug })).toEqual(["/slug invalid_slug"]);
    }
  });

  test("requires description to be NFC", () => {
    const composed = `caf${String.fromCharCode(0xe9)}`;
    const decomposed = `cafe${String.fromCharCode(0x301)}`;
    const hangulSyllable = String.fromCharCode(0xac00);
    const hangulJamo = String.fromCharCode(0x1100, 0x1161);
    const angstromSign = String.fromCharCode(0x212b);
    expect(composed.normalize("NFD")).toBe(decomposed);
    for (const description of ["", composed, hangulSyllable, String.fromCodePoint(0x1f4c8), "line\nbreak"]) {
      expect(errors({ ...baseSpec(2), description })).toEqual([]);
    }
    for (const description of [decomposed, hangulJamo, angstromSign, `${composed} then ${decomposed}`]) {
      expect(errors({ ...baseSpec(2), description })).toEqual(["/description not_nfc"]);
    }
  });

  test("rejects a description with a lone surrogate", () => {
    const description = `broken ${String.fromCharCode(0xd83d)}`;
    expect(errors({ ...baseSpec(2), description })).toEqual(["/description lone_surrogate"]);
  });
});

describe("validateSpec addresses", () => {
  const universe = (tokens: readonly unknown[]) => ({ type: "static", tokens });

  test("accepts only 0x and 40 lowercase hexadecimal digits", () => {
    const lower = "0xb2c3d4e5f60718293a4b5c6d7e8f90123456789a";
    const forms = [
      lower.toUpperCase().replace("0X", "0x"),
      lower.replace("0x", "0X"),
      lower.replace("a4b5", "A4b5"),
      lower.slice(2),
      lower.slice(0, 41),
      `${lower}0`,
      `${lower} `,
      `${lower}\n`,
      lower.replace("b2", "g2"),
      "",
    ];
    expect(errors(withTokens(1, { universe: universe([lower]) }))).toEqual([]);
    for (const form of forms) {
      expect(errors(withTokens(1, { universe: universe([form]) }))).toEqual(["/universe/tokens/0 invalid_address"]);
      const pricing = { source: "chainlink-aggregator-v3", feeds: [form] };
      expect(errors(withTokens(1, { pricing }))).toEqual(["/pricing/feeds/0 invalid_address"]);
    }
    expect(errors(withTokens(1, { universe: universe([1]) }))).toEqual(["/universe/tokens/0 invalid_type"]);
  });

  test("requires tokens to be strictly ascending", () => {
    const [a, b, c] = [address(1), address(2), address(3)];
    expect(errors(withTokens(3, { universe: universe([a, b, c]) }))).toEqual([]);
    expect(errors(withTokens(3, { universe: universe([a, c, b]) }))).toEqual([
      "/universe/tokens/2 tokens_not_strictly_ascending",
    ]);
    expect(errors(withTokens(3, { universe: universe([b, a, c]) }))).toEqual([
      "/universe/tokens/1 tokens_not_strictly_ascending",
    ]);
    expect(errors(withTokens(3, { universe: universe([a, b, b]) }))).toEqual([
      "/universe/tokens/2 tokens_not_strictly_ascending",
    ]);
    expect(errors(withTokens(3, { universe: universe([c, b, a]) }))).toEqual([
      "/universe/tokens/1 tokens_not_strictly_ascending",
      "/universe/tokens/2 tokens_not_strictly_ascending",
    ]);
  });

  test("orders tokens numerically across digits and letters", () => {
    const tokens = [`0x9${"f".repeat(39)}`, `0xa${"0".repeat(39)}`];
    expect(errors(withTokens(2, { universe: universe(tokens) }))).toEqual([]);
    expect(errors(withTokens(2, { universe: universe([...tokens].reverse()) }))).toEqual([
      "/universe/tokens/1 tokens_not_strictly_ascending",
    ]);
  });

  test("rejects the zero address as a token", () => {
    expect(errors(withTokens(2, { universe: universe([address(0), address(1)]) }))).toEqual([
      "/universe/tokens/0 zero_address",
    ]);
  });

  test("bounds the number of tokens", () => {
    expect(errors(withTokens(64))).toEqual([]);
    expect(errors(withTokens(65))).toEqual(["/universe/tokens too_many_items"]);
    expect(errors(withTokens(2, { universe: { type: "static", tokens: "none" } }))).toEqual([
      "/universe/tokens invalid_type",
    ]);
  });

  test("requires one feed per token, in any order and with repetitions allowed", () => {
    const pricing = (feeds: readonly unknown[]) => ({ source: "chainlink-aggregator-v3", feeds });
    expect(errors(withTokens(3, { pricing: pricing([address(9), address(8), address(9)]) }))).toEqual([]);
    expect(errors(withTokens(3, { pricing: pricing([address(9), address(8)]) }))).toEqual([
      "/pricing/feeds length_mismatch",
    ]);
    expect(errors(withTokens(3, { pricing: pricing(range(4).map(address)) }))).toEqual([
      "/pricing/feeds length_mismatch",
    ]);
    expect(errors(withTokens(3, { pricing: pricing([]) }))).toEqual(["/pricing/feeds length_mismatch"]);
  });

  test("accepts only the defined universe type and price source", () => {
    const tokens = range(2).map((i) => address(i));
    expect(errors(withTokens(2, { universe: { type: "rule", tokens } }))).toEqual(["/universe/type invalid_value"]);
    expect(errors(withTokens(2, { universe: { type: "static", rule: "all" } }))).toEqual([
      "/universe/rule unknown_property",
      "/universe/tokens missing_property",
    ]);
    const pricing = { source: "pyth", feeds: tokens };
    expect(errors(withTokens(2, { pricing }))).toEqual(["/pricing/source invalid_value"]);
  });
});

describe("validateSpec weighting and constraints", () => {
  test("accepts only equal and fixed weighting", () => {
    for (const type of ["supplyValue", "marketCap", "Equal", ""]) {
      expect(errors(withTokens(2, { weighting: { type } }))).toEqual(["/weighting/type invalid_value"]);
      expect(errors(withTokens(2, { weighting: { type, weightsBps: [5000, 5000] } }))).toEqual([
        "/weighting/type invalid_value",
      ]);
    }
    expect(errors(withTokens(2, { weighting: {} }))).toEqual(["/weighting/type missing_property"]);
    expect(errors(withTokens(2, { weighting: { type: 1 } }))).toEqual(["/weighting/type invalid_type"]);
    expect(errors(withTokens(2, { weighting: "equal" }))).toEqual(["/weighting invalid_type"]);
  });

  test("rejects weights on equal weighting and requires them on fixed weighting", () => {
    expect(errors(withTokens(2, { weighting: { type: "equal", weightsBps: [5000, 5000] } }))).toEqual([
      "/weighting/weightsBps unknown_property",
    ]);
    expect(errors(withTokens(2, { weighting: { type: "fixed" } }))).toEqual(["/weighting/weightsBps missing_property"]);
  });

  test("requires fixed weights to sum to exactly 10_000", () => {
    expect(errors(fixed([5000, 3000, 2000]))).toEqual([]);
    expect(errors(fixed([5000, 3000, 1999]))).toEqual(["/weighting/weightsBps invalid_weight_sum"]);
    expect(errors(fixed([5000, 3000, 2001]))).toEqual(["/weighting/weightsBps invalid_weight_sum"]);
    expect(errors(fixed([10_000, 10_000]))).toEqual(["/weighting/weightsBps invalid_weight_sum"]);
  });

  test("requires every fixed weight to be an integer in [1, 10_000]", () => {
    expect(errors(fixed([9999, 1]))).toEqual([]);
    expect(errors(fixed([10_000, 0]))).toEqual(["/weighting/weightsBps/1 out_of_range"]);
    expect(errors(fixed([10_001, -1]))).toEqual([
      "/weighting/weightsBps/0 out_of_range",
      "/weighting/weightsBps/1 out_of_range",
    ]);
    expect(errors(fixed([4999.5, 5000.5]))).toEqual([
      "/weighting/weightsBps/0 not_safe_integer",
      "/weighting/weightsBps/1 not_safe_integer",
    ]);
    expect(errors(fixed(["5000", 5000]))).toEqual(["/weighting/weightsBps/0 invalid_type"]);
  });

  test("requires one fixed weight per token", () => {
    const tooFew = withTokens(3, { weighting: { type: "fixed", weightsBps: [5000, 5000] } });
    expect(errors(tooFew)).toEqual(["/weighting/weightsBps length_mismatch"]);
    const tooMany = withTokens(1, { weighting: { type: "fixed", weightsBps: [5000, 5000] } });
    expect(errors(tooMany)).toEqual(["/weighting/weightsBps length_mismatch"]);
  });

  test("equal weighting: requires maxWeightBps * n >= 10_000", () => {
    expect(errors(withTokens(3, { constraints: { maxWeightBps: 3334 } }))).toEqual([]);
    expect(errors(withTokens(3, { constraints: { maxWeightBps: 3333 } }))).toEqual([
      "/constraints/maxWeightBps cap_infeasible",
    ]);
    expect(errors(withTokens(4, { constraints: { maxWeightBps: 2500 } }))).toEqual([]);
    expect(errors(withTokens(4, { constraints: { maxWeightBps: 2499 } }))).toEqual([
      "/constraints/maxWeightBps cap_infeasible",
    ]);
    expect(errors(withTokens(1, { constraints: { maxWeightBps: 9999 } }))).toEqual([
      "/constraints/maxWeightBps cap_infeasible",
    ]);
  });

  test("equal weighting: requires minWeightBps * n <= 10_000", () => {
    expect(errors(withTokens(3, { constraints: { minWeightBps: 3333 } }))).toEqual([]);
    expect(errors(withTokens(3, { constraints: { minWeightBps: 3334 } }))).toEqual([
      "/constraints/minWeightBps floor_infeasible",
    ]);
    const crossed = { maxWeightBps: 4000, minWeightBps: 4001 };
    expect(errors(withTokens(3, { constraints: crossed }))).toEqual(["/constraints/minWeightBps floor_infeasible"]);
  });

  test("fixed weighting: requires every weight to be at most maxWeightBps", () => {
    expect(errors(fixed([4000, 3000, 3000], { constraints: { maxWeightBps: 4000 } }))).toEqual([]);
    expect(errors(fixed([4001, 3000, 2999], { constraints: { maxWeightBps: 4000 } }))).toEqual([
      "/weighting/weightsBps/0 weight_above_max",
    ]);
    expect(errors(fixed([1000, 4500, 4500], { constraints: { maxWeightBps: 4000 } }))).toEqual([
      "/weighting/weightsBps/1 weight_above_max",
      "/weighting/weightsBps/2 weight_above_max",
    ]);
  });

  test("fixed weighting: requires every weight to be at least minWeightBps", () => {
    expect(errors(fixed([5000, 4000, 1000], { constraints: { minWeightBps: 1000 } }))).toEqual([]);
    expect(errors(fixed([5000, 4001, 999], { constraints: { minWeightBps: 1000 } }))).toEqual([
      "/weighting/weightsBps/2 weight_below_min",
    ]);
  });

  test("fixed weighting: reports the weights, not the product rule, and names each token index", () => {
    // maxWeightBps * n >= 10_000 holds here; the weights still break both bounds.
    const constraints = { maxWeightBps: 5000, minWeightBps: 2000 };
    expect(errors(fixed([6000, 3000, 1000], { constraints }))).toEqual([
      "/weighting/weightsBps/0 weight_above_max",
      "/weighting/weightsBps/2 weight_below_min",
    ]);
    // A cap no set of three weights can satisfy is reported on the weights that break it.
    expect(errors(fixed([3334, 3333, 3333], { constraints: { maxWeightBps: 3333 } }))).toEqual([
      "/weighting/weightsBps/0 weight_above_max",
    ]);
    expect(errors(fixed([5000, 5000], { constraints: { maxWeightBps: 4000, minWeightBps: 6000 } }))).toEqual([
      "/weighting/weightsBps/0 weight_above_max",
      "/weighting/weightsBps/0 weight_below_min",
      "/weighting/weightsBps/1 weight_above_max",
      "/weighting/weightsBps/1 weight_below_min",
    ]);
  });

  test("does not check weights against constraints when either is itself invalid", () => {
    expect(errors(fixed([6000, 3999], { constraints: { maxWeightBps: 5000 } }))).toEqual([
      "/weighting/weightsBps invalid_weight_sum",
    ]);
    expect(errors(fixed([6000, 4000], { constraints: { maxWeightBps: 0 } }))).toEqual([
      "/constraints/maxWeightBps out_of_range",
    ]);
  });

  test("bounds the constraints and rejects an empty object", () => {
    expect(errors(withTokens(2, { constraints: {} }))).toEqual(["/constraints empty_object"]);
    for (const invalid of [0, 10_001]) {
      expect(errors(withTokens(2, { constraints: { maxWeightBps: invalid } }))).toEqual([
        "/constraints/maxWeightBps out_of_range",
      ]);
      expect(errors(withTokens(2, { constraints: { minWeightBps: invalid } }))).toEqual([
        "/constraints/minWeightBps out_of_range",
      ]);
    }
    expect(errors(withTokens(2, { constraints: { maxWeightBps: 5000.5 } }))).toEqual([
      "/constraints/maxWeightBps not_safe_integer",
    ]);
  });

  test("bounds the rebalance rule", () => {
    const rebalance = (overrides: Spec) => ({
      trigger: "drift",
      driftThresholdBps: 500,
      minIntervalSeconds: 0,
      ...overrides,
    });
    expect(errors(withTokens(2, { rebalance: rebalance({ driftThresholdBps: 10_000 }) }))).toEqual([]);
    expect(errors(withTokens(2, { rebalance: rebalance({ minIntervalSeconds: Number.MAX_SAFE_INTEGER }) }))).toEqual(
      [],
    );
    expect(errors(withTokens(2, { rebalance: rebalance({ driftThresholdBps: 10_001 }) }))).toEqual([
      "/rebalance/driftThresholdBps out_of_range",
    ]);
    expect(errors(withTokens(2, { rebalance: rebalance({ minIntervalSeconds: -1 }) }))).toEqual([
      "/rebalance/minIntervalSeconds out_of_range",
    ]);
    expect(errors(withTokens(2, { rebalance: rebalance({ trigger: "calendar" }) }))).toEqual([
      "/rebalance/trigger invalid_value",
    ]);
  });

  test("validates the parent reference", () => {
    const parent = {
      chainId: 8453,
      registry: address(1),
      indexId: `0x${"1a".repeat(32)}`,
      version: 1,
      specHash: `0x${"c3".repeat(32)}`,
    };
    expect(errors(withTokens(2, { parent }))).toEqual([]);
    expect(errors(withTokens(2, { parent: { ...parent, indexId: `0x${"1A".repeat(32)}` } }))).toEqual([
      "/parent/indexId invalid_bytes32",
    ]);
    expect(errors(withTokens(2, { parent: { ...parent, specHash: `0x${"c3".repeat(31)}` } }))).toEqual([
      "/parent/specHash invalid_bytes32",
    ]);
    expect(errors(withTokens(2, { parent: { ...parent, registry: "0xAB" } }))).toEqual([
      "/parent/registry invalid_address",
    ]);
    expect(errors(withTokens(2, { parent: { ...parent, version: 4_294_967_296 } }))).toEqual([
      "/parent/version out_of_range",
    ]);
    expect(errors(withTokens(2, { parent: { ...parent, chainId: 0 } }))).toEqual(["/parent/chainId out_of_range"]);
  });
});

describe("validateSpec size limit", () => {
  test("accepts a canonical form of exactly 8192 bytes and rejects 8193", () => {
    const emptySize = canonicalize({ ...baseSpec(2), description: "" }).length;
    const atLimit = { ...baseSpec(2), description: "d".repeat(MAX_SPEC_BYTES - emptySize) };
    const result = validateSpec(atLimit);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.specBytes.length).toBe(8192);
    expect(errors({ ...atLimit, description: `${atLimit.description}d` })).toEqual([" spec_too_large"]);
  });

  test("measures bytes, not characters", () => {
    const emptySize = canonicalize({ ...baseSpec(2), description: "" }).length;
    const euro = String.fromCharCode(0x20ac);
    const fits = Math.floor((MAX_SPEC_BYTES - emptySize) / 3);
    expect(errors({ ...baseSpec(2), description: euro.repeat(fits) })).toEqual([]);
    expect(errors({ ...baseSpec(2), description: euro.repeat(fits + 1) })).toEqual([" spec_too_large"]);
  });

  // The largest document the schema allows apart from the description: 64 constituents with fixed weights
  // written with the most digits 64 weights can have (four of 1000 and sixty of 100), the longest name
  // and slug, both bounds, a parent, and every integer at its longest.
  function maximalSpec(description: string): Spec {
    const weightsBps = [...range(4).map(() => 1000), ...range(60).map(() => 100)];
    return {
      ...baseSpec(MAX_CONSTITUENTS),
      chainId: Number.MAX_SAFE_INTEGER,
      name: "N".repeat(64),
      slug: "s".repeat(32),
      description,
      weighting: { type: "fixed", weightsBps },
      constraints: { maxWeightBps: 10_000, minWeightBps: 100 },
      rebalance: { trigger: "drift", driftThresholdBps: 10_000, minIntervalSeconds: Number.MAX_SAFE_INTEGER },
      parent: {
        chainId: Number.MAX_SAFE_INTEGER,
        registry: address(0xaa),
        indexId: `0x${"1a".repeat(32)}`,
        version: 4_294_967_295,
        specHash: `0x${"c3".repeat(32)}`,
      },
    };
  }

  test("a maximal 64-constituent spec fits with room for a realistic description", () => {
    const description =
      "Sixty-four tokenized stocks with fixed target weights. Four core holdings carry ten percent each and " +
      "sixty satellite holdings carry one percent each. Rebalanced when any constituent drifts five percent " +
      "from its target, at most once a week.";
    const result = validateSpec(maximalSpec(description));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.spec.universe.tokens.length).toBe(64);
    expect(result.specBytes.length).toBe(MAXIMAL_EMPTY_BYTES + description.length);
    expect(result.specBytes.length).toBeLessThan(MAX_SPEC_BYTES);
  });

  test("the headroom left for the description of a maximal spec is exactly 1391 bytes", () => {
    expect(canonicalize(maximalSpec("")).length).toBe(MAXIMAL_EMPTY_BYTES);
    const headroom = MAX_SPEC_BYTES - MAXIMAL_EMPTY_BYTES;
    expect(headroom).toBe(1391);
    expect(errors(maximalSpec("d".repeat(headroom)))).toEqual([]);
    expect(errors(maximalSpec("d".repeat(headroom + 1)))).toEqual([" spec_too_large"]);
  });
});
