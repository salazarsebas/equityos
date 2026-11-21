/**
 * Types and limits of the methodology spec `equityos.index/1`.
 *
 * A spec is a JSON document. Every number in it is an integer below 2^53 so that its canonical form
 * (RFC 8785) is identical in every language. Weights and thresholds are in basis points (bps), where
 * 10_000 bps = 100%.
 */

/** Identifier of the document shape. Any change to the shape is a new identifier. */
export const INDEX_SCHEMA_ID = "equityos.index/1";

/** Identifier of the calculation rules, versioned separately from the document shape. */
export const CALC_ID = "equityos.calc/1";

/** Maximum size of the canonical spec, in bytes. */
export const MAX_SPEC_BYTES = 8_192;

/**
 * Maximum number of constituents of one index version. A spec with 64 constituents, fixed weights and
 * every other property at its longest still fits in `MAX_SPEC_BYTES`.
 */
export const MAX_CONSTITUENTS = 64;

/** Minimum number of constituents. A single constituent at 10_000 bps is a valid index. */
export const MIN_CONSTITUENTS = 1;

/** The sum of the weights of an index, in basis points. */
export const TOTAL_WEIGHT_BPS = 10_000;

/** Maximum length of `name`, in ASCII characters. */
export const MAX_NAME_LENGTH = 64;

/** The only price source defined by `equityos.index/1`. */
export const PRICE_SOURCE = "chainlink-aggregator-v3";

/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/** A 20-byte address as 40 lowercase hexadecimal digits. Mixed-case (EIP-55) forms are not valid in a spec. */
export type Address = Hex;

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/** True if `value` is an address in the single form a spec accepts: `0x` and 40 lowercase hex digits. */
export function isAddress(value: string): value is Address {
  return ADDRESS_PATTERN.test(value);
}

/** Every constituent has the same weight. */
export interface EqualWeighting {
  readonly type: "equal";
}

/** Each constituent has the weight listed at its position in `universe.tokens`. */
export interface FixedWeighting {
  readonly type: "fixed";
  /** Weights in basis points, same length and order as `universe.tokens`, each above 0, summing to 10_000. */
  readonly weightsBps: readonly number[];
}

/**
 * Optional bounds every constituent weight must satisfy. At least one bound is present. They are
 * validation rules: a spec whose weights break them is invalid, and no weight is ever adjusted.
 */
export interface WeightConstraints {
  /** Upper bound of a constituent weight, in basis points. */
  readonly maxWeightBps?: number;
  /** Lower bound of a constituent weight, in basis points. */
  readonly minWeightBps?: number;
}

/** The index version this spec was forked from. */
export interface ParentReference {
  readonly chainId: number;
  /** Address of the registry that holds the parent. */
  readonly registry: Address;
  /** 32-byte index id as 64 lowercase hex digits. */
  readonly indexId: Hex;
  readonly version: number;
  /** keccak256 of the parent spec bytes as 64 lowercase hex digits. */
  readonly specHash: Hex;
}

/** A validated `equityos.index/1` document. */
export interface IndexSpec {
  readonly schema: typeof INDEX_SCHEMA_ID;
  readonly calc: typeof CALC_ID;
  /** EIP-155 chain id the token and feed addresses belong to. */
  readonly chainId: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly universe: {
    readonly type: "static";
    /** Constituent token addresses, strictly ascending. */
    readonly tokens: readonly Address[];
  };
  readonly weighting: EqualWeighting | FixedWeighting;
  readonly constraints?: WeightConstraints;
  readonly pricing: {
    readonly source: typeof PRICE_SOURCE;
    /** Price feed address of each token, same length and order as `universe.tokens`. */
    readonly feeds: readonly Address[];
  };
  readonly rebalance: {
    readonly trigger: "drift";
    /** Deviation of a constituent from its target weight that makes a rebalance due, in basis points. */
    readonly driftThresholdBps: number;
    /** Minimum time between two rebalances, in seconds. */
    readonly minIntervalSeconds: number;
  };
  readonly parent?: ParentReference;
}

/** One constituent of an index version: a token and its target weight in basis points. */
export interface Constituent {
  readonly token: Address;
  /**
   * Target weight in basis points, an integer in [1, 10_000]. A safe-integer `number` at the type boundary
   * because it is a JSON value; arithmetic on weights is done in `bigint`.
   */
  readonly weightBps: number;
}
