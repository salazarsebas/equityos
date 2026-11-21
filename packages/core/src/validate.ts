import { canonicalize, isPlainObject, isWellFormedString } from "./jcs.ts";
import {
  type Address,
  CALC_ID,
  type Hex,
  INDEX_SCHEMA_ID,
  type IndexSpec,
  isAddress,
  MAX_CONSTITUENTS,
  MAX_NAME_LENGTH,
  MAX_SPEC_BYTES,
  MIN_CONSTITUENTS,
  type ParentReference,
  PRICE_SOURCE,
  TOTAL_WEIGHT_BPS,
  type WeightConstraints,
} from "./spec.ts";

export type SpecErrorCode =
  /** The value has the wrong JSON type. `null` is never accepted. */
  | "invalid_type"
  /** A number that is not an integer with absolute value below 2^53. */
  | "not_safe_integer"
  | "out_of_range"
  | "missing_property"
  | "unknown_property"
  /** A property that accepts one fixed value, or a fixed set of values, holds something else. */
  | "invalid_value"
  /** `schema` is not `equityos.index/1`. Nothing else is checked. */
  | "unsupported_schema"
  /** `calc` is not `equityos.calc/1`. */
  | "unsupported_calc"
  | "invalid_name"
  | "invalid_slug"
  /** Not `0x` followed by 40 lowercase hexadecimal digits. */
  | "invalid_address"
  /** Not `0x` followed by 64 lowercase hexadecimal digits. */
  | "invalid_bytes32"
  | "zero_address"
  /** `description` is not in Unicode Normalization Form C. */
  | "not_nfc"
  | "lone_surrogate"
  | "empty_object"
  | "too_few_items"
  | "too_many_items"
  /** A token is not greater than the token before it: unsorted or duplicated. */
  | "tokens_not_strictly_ascending"
  /** An array that must have one entry per token has a different length. */
  | "length_mismatch"
  /** Fixed weights do not sum to 10_000 bps. */
  | "invalid_weight_sum"
  /** Equal weighting: `maxWeightBps` times the number of tokens is below 10_000 bps. */
  | "cap_infeasible"
  /** Equal weighting: `minWeightBps` times the number of tokens is above 10_000 bps. */
  | "floor_infeasible"
  /** A fixed weight is above `maxWeightBps`. */
  | "weight_above_max"
  /** A fixed weight is below `minWeightBps`. */
  | "weight_below_min"
  /** The canonical form is larger than 8_192 bytes. */
  | "spec_too_large";

export interface SpecError {
  /** JSON Pointer (RFC 6901) to the offending value. The empty string is the document itself. */
  readonly path: string;
  readonly code: SpecErrorCode;
  readonly message: string;
}

export type SpecValidationResult =
  /** `specBytes` is the canonical serialization of `spec`. */
  | { readonly ok: true; readonly spec: IndexSpec; readonly specBytes: Uint8Array }
  | { readonly ok: false; readonly errors: readonly SpecError[] };

const NAME_PATTERN = new RegExp(`^[\\x20-\\x7e]{1,${MAX_NAME_LENGTH}}$`);
const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const MAX_UINT32 = 4_294_967_295;

/** Marks a property that is absent, so that readers stay silent: the absence is reported once, by `object`. */
const MISSING = Symbol("missing");

type Fields = Record<string, unknown>;

function isBytes32(value: string): value is Hex {
  return BYTES32_PATTERN.test(value);
}

function fail(errors: SpecError[], path: string, code: SpecErrorCode, message: string): undefined {
  errors.push({ path, code, message });
  return undefined;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function child(path: string, key: string): string {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function field(fields: Fields, key: string): unknown {
  return Object.hasOwn(fields, key) ? fields[key] : MISSING;
}

/** Checks that `value` is an object with every required property and no property outside the two lists. */
function object(
  errors: SpecError[],
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Fields | undefined {
  if (value === MISSING) return undefined;
  if (!isPlainObject(value)) {
    return fail(errors, path, "invalid_type", `expected an object, received ${kindOf(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(errors, child(path, key), "unknown_property", "this property is not defined by the schema");
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(errors, child(path, key), "missing_property", "required property is missing");
  }
  return value;
}

function string(errors: SpecError[], value: unknown, path: string): string | undefined {
  if (value === MISSING) return undefined;
  if (typeof value === "string") return value;
  return fail(errors, path, "invalid_type", `expected a string, received ${kindOf(value)}`);
}

function integer(errors: SpecError[], value: unknown, path: string, min: number, max: number): number | undefined {
  if (value === MISSING) return undefined;
  if (typeof value !== "number") {
    return fail(errors, path, "invalid_type", `expected an integer, received ${kindOf(value)}`);
  }
  if (!Number.isSafeInteger(value)) {
    return fail(errors, path, "not_safe_integer", `${value} is not an integer below 2^53`);
  }
  if (value < min || value > max) {
    return fail(errors, path, "out_of_range", `${value} is outside [${min}, ${max}]`);
  }
  return value;
}

function constant<T extends string>(
  errors: SpecError[],
  value: unknown,
  path: string,
  expected: T,
  code: SpecErrorCode = "invalid_value",
): T | undefined {
  const text = string(errors, value, path);
  if (text === undefined) return undefined;
  if (text === expected) return expected;
  return fail(errors, path, code, `expected "${expected}", received ${JSON.stringify(text)}`);
}

function matching(
  errors: SpecError[],
  value: unknown,
  path: string,
  pattern: RegExp,
  code: SpecErrorCode,
): string | undefined {
  const text = string(errors, value, path);
  if (text === undefined || pattern.test(text)) return text;
  return fail(errors, path, code, `must match ${pattern.source}`);
}

function address(errors: SpecError[], value: unknown, path: string): Address | undefined {
  const text = string(errors, value, path);
  if (text === undefined) return undefined;
  if (isAddress(text)) return text;
  return fail(errors, path, "invalid_address", "expected 0x followed by 40 lowercase hexadecimal digits");
}

function bytes32(errors: SpecError[], value: unknown, path: string): Hex | undefined {
  const text = string(errors, value, path);
  if (text === undefined) return undefined;
  if (isBytes32(text)) return text;
  return fail(errors, path, "invalid_bytes32", "expected 0x followed by 64 lowercase hexadecimal digits");
}

/** Reads an array and applies `item` to each element. Returns the items only if every one is valid. */
function list<T>(
  errors: SpecError[],
  value: unknown,
  path: string,
  item: (errors: SpecError[], value: unknown, path: string) => T | undefined,
): readonly T[] | undefined {
  if (value === MISSING) return undefined;
  if (!Array.isArray(value)) return fail(errors, path, "invalid_type", `expected an array, received ${kindOf(value)}`);
  const values: readonly unknown[] = value;
  const items: T[] = [];
  for (let i = 0; i < values.length; i++) {
    const read = item(errors, values[i], `${path}/${i}`);
    if (read !== undefined) items.push(read);
  }
  return items.length === values.length ? items : undefined;
}

function description(errors: SpecError[], value: unknown): string | undefined {
  const text = string(errors, value, "/description");
  if (text === undefined) return undefined;
  if (!isWellFormedString(text)) return fail(errors, "/description", "lone_surrogate", "contains a lone surrogate");
  if (text.normalize("NFC") !== text) {
    return fail(errors, "/description", "not_nfc", "must be in Unicode Normalization Form C");
  }
  return text;
}

function universe(errors: SpecError[], value: unknown): IndexSpec["universe"] | undefined {
  const before = errors.length;
  const fields = object(errors, value, "/universe", ["tokens", "type"]);
  if (fields === undefined) return undefined;
  const type = constant(errors, field(fields, "type"), "/universe/type", "static");
  const tokens = list(errors, field(fields, "tokens"), "/universe/tokens", address);
  if (tokens === undefined || type === undefined) return undefined;
  if (tokens.length < MIN_CONSTITUENTS) {
    fail(errors, "/universe/tokens", "too_few_items", `at least ${MIN_CONSTITUENTS} token is required`);
  }
  if (tokens.length > MAX_CONSTITUENTS) {
    fail(errors, "/universe/tokens", "too_many_items", `at most ${MAX_CONSTITUENTS} tokens are allowed`);
  }
  tokens.forEach((token, i) => {
    const previous = tokens[i - 1];
    if (token === ZERO_ADDRESS) {
      fail(errors, `/universe/tokens/${i}`, "zero_address", "the zero address is not a token");
    } else if (previous !== undefined && token <= previous) {
      // Lowercase hexadecimal strings of equal length order the same way as the addresses they encode.
      fail(errors, `/universe/tokens/${i}`, "tokens_not_strictly_ascending", "must be greater than the previous token");
    }
  });
  return errors.length === before ? { type, tokens } : undefined;
}

function weighting(
  errors: SpecError[],
  value: unknown,
  tokenCount: number | undefined,
): IndexSpec["weighting"] | undefined {
  const before = errors.length;
  if (value === MISSING) return undefined;
  if (!isPlainObject(value)) {
    return fail(errors, "/weighting", "invalid_type", `expected an object, received ${kindOf(value)}`);
  }
  const type = string(errors, field(value, "type"), "/weighting/type");
  if (type === "equal") {
    object(errors, value, "/weighting", ["type"]);
    return errors.length === before ? { type } : undefined;
  }
  if (type !== "fixed") {
    if (!Object.hasOwn(value, "type")) {
      fail(errors, "/weighting/type", "missing_property", "required property is missing");
    } else if (type !== undefined) {
      fail(errors, "/weighting/type", "invalid_value", `expected "equal" or "fixed", received ${JSON.stringify(type)}`);
    }
    return undefined;
  }
  object(errors, value, "/weighting", ["type", "weightsBps"]);
  const weightsBps = list(errors, field(value, "weightsBps"), "/weighting/weightsBps", (itemErrors, item, path) =>
    integer(itemErrors, item, path, 1, TOTAL_WEIGHT_BPS),
  );
  if (weightsBps === undefined) return undefined;
  const sumBps = weightsBps.reduce((sum, weightBps) => sum + weightBps, 0);
  if (tokenCount !== undefined && weightsBps.length !== tokenCount) {
    fail(errors, "/weighting/weightsBps", "length_mismatch", `expected ${tokenCount} weights, one per token`);
  } else if (sumBps !== TOTAL_WEIGHT_BPS) {
    fail(
      errors,
      "/weighting/weightsBps",
      "invalid_weight_sum",
      `weights sum to ${sumBps}, expected ${TOTAL_WEIGHT_BPS}`,
    );
  }
  return errors.length === before ? { type, weightsBps } : undefined;
}

function constraints(errors: SpecError[], value: unknown): WeightConstraints | undefined {
  const before = errors.length;
  const fields = object(errors, value, "/constraints", [], ["maxWeightBps", "minWeightBps"]);
  if (fields === undefined) return undefined;
  if (Object.keys(fields).length === 0) fail(errors, "/constraints", "empty_object", "omit the property instead");
  const maxWeightBps = integer(errors, field(fields, "maxWeightBps"), "/constraints/maxWeightBps", 1, TOTAL_WEIGHT_BPS);
  const minWeightBps = integer(errors, field(fields, "minWeightBps"), "/constraints/minWeightBps", 1, TOTAL_WEIGHT_BPS);
  if (errors.length !== before) return undefined;
  return {
    ...(maxWeightBps === undefined ? {} : { maxWeightBps }),
    ...(minWeightBps === undefined ? {} : { minWeightBps }),
  };
}

/**
 * Checks the weights against the constraints. Constraints never change a weight: a spec whose weights
 * do not satisfy them is invalid.
 *
 * Fixed weights are checked one by one. Equal weights are `floor(10_000 / n)` or one more, so they are
 * within the bounds exactly when `maxWeightBps * n >= 10_000` and `minWeightBps * n <= 10_000`.
 */
function bounds(errors: SpecError[], weights: IndexSpec["weighting"], limits: WeightConstraints, count: number): void {
  const { maxWeightBps, minWeightBps } = limits;
  if (weights.type === "fixed") {
    weights.weightsBps.forEach((weightBps, i) => {
      const path = `/weighting/weightsBps/${i}`;
      if (maxWeightBps !== undefined && weightBps > maxWeightBps) {
        fail(errors, path, "weight_above_max", `${weightBps} bps is above maxWeightBps ${maxWeightBps}`);
      }
      if (minWeightBps !== undefined && weightBps < minWeightBps) {
        fail(errors, path, "weight_below_min", `${weightBps} bps is below minWeightBps ${minWeightBps}`);
      }
    });
    return;
  }
  if (maxWeightBps !== undefined && maxWeightBps * count < TOTAL_WEIGHT_BPS) {
    const message = `${count} equal weights exceed maxWeightBps ${maxWeightBps}`;
    fail(errors, "/constraints/maxWeightBps", "cap_infeasible", message);
  }
  if (minWeightBps !== undefined && minWeightBps * count > TOTAL_WEIGHT_BPS) {
    const message = `${count} equal weights are below minWeightBps ${minWeightBps}`;
    fail(errors, "/constraints/minWeightBps", "floor_infeasible", message);
  }
}

function pricing(
  errors: SpecError[],
  value: unknown,
  tokenCount: number | undefined,
): IndexSpec["pricing"] | undefined {
  const before = errors.length;
  const fields = object(errors, value, "/pricing", ["feeds", "source"]);
  if (fields === undefined) return undefined;
  const source = constant(errors, field(fields, "source"), "/pricing/source", PRICE_SOURCE);
  const feeds = list(errors, field(fields, "feeds"), "/pricing/feeds", address);
  if (feeds !== undefined && tokenCount !== undefined && feeds.length !== tokenCount) {
    fail(errors, "/pricing/feeds", "length_mismatch", `expected ${tokenCount} feeds, one per token`);
  }
  return errors.length === before && source !== undefined && feeds !== undefined ? { source, feeds } : undefined;
}

function rebalance(errors: SpecError[], value: unknown): IndexSpec["rebalance"] | undefined {
  const before = errors.length;
  const fields = object(errors, value, "/rebalance", ["driftThresholdBps", "minIntervalSeconds", "trigger"]);
  if (fields === undefined) return undefined;
  const trigger = constant(errors, field(fields, "trigger"), "/rebalance/trigger", "drift");
  const driftThresholdBps = integer(
    errors,
    field(fields, "driftThresholdBps"),
    "/rebalance/driftThresholdBps",
    1,
    TOTAL_WEIGHT_BPS,
  );
  const minIntervalSeconds = integer(
    errors,
    field(fields, "minIntervalSeconds"),
    "/rebalance/minIntervalSeconds",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (errors.length !== before || trigger === undefined) return undefined;
  if (driftThresholdBps === undefined || minIntervalSeconds === undefined) return undefined;
  return { trigger, driftThresholdBps, minIntervalSeconds };
}

function parent(errors: SpecError[], value: unknown): ParentReference | undefined {
  const before = errors.length;
  const fields = object(errors, value, "/parent", ["chainId", "indexId", "registry", "specHash", "version"]);
  if (fields === undefined) return undefined;
  const chainId = integer(errors, field(fields, "chainId"), "/parent/chainId", 1, Number.MAX_SAFE_INTEGER);
  const registry = address(errors, field(fields, "registry"), "/parent/registry");
  const indexId = bytes32(errors, field(fields, "indexId"), "/parent/indexId");
  const version = integer(errors, field(fields, "version"), "/parent/version", 1, MAX_UINT32);
  const specHash = bytes32(errors, field(fields, "specHash"), "/parent/specHash");
  if (errors.length !== before || chainId === undefined || registry === undefined) return undefined;
  if (indexId === undefined || version === undefined || specHash === undefined) return undefined;
  return { chainId, registry, indexId, version, specHash };
}

const REQUIRED = [
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
const OPTIONAL = ["constraints", "parent"];

/**
 * Validates a parsed JSON value against `equityos.index/1`.
 *
 * Enforces everything the published JSON Schema does, plus the rules a JSON Schema cannot express:
 * token order, array lengths tied to the token count, the weight sum, weights within `constraints`, Unicode
 * normalization and the size of the canonical form. Every violation found is reported; a document
 * with an unsupported `schema` reports only that, because none of its other content can be interpreted.
 */
export function validateSpec(value: unknown): SpecValidationResult {
  const errors: SpecError[] = [];
  const root = object(errors, value, "", REQUIRED, OPTIONAL);
  if (root === undefined) return { ok: false, errors };
  const schemaErrors: SpecError[] = [];
  const schema = constant(schemaErrors, field(root, "schema"), "/schema", INDEX_SCHEMA_ID, "unsupported_schema");
  if (schemaErrors.length > 0) return { ok: false, errors: schemaErrors };

  const calc = constant(errors, field(root, "calc"), "/calc", CALC_ID, "unsupported_calc");
  const chainId = integer(errors, field(root, "chainId"), "/chainId", 1, Number.MAX_SAFE_INTEGER);
  const name = matching(errors, field(root, "name"), "/name", NAME_PATTERN, "invalid_name");
  const slug = matching(errors, field(root, "slug"), "/slug", SLUG_PATTERN, "invalid_slug");
  const descriptionText = description(errors, field(root, "description"));
  const universeValue = universe(errors, field(root, "universe"));
  const tokenCount = universeValue?.tokens.length;
  const weightingValue = weighting(errors, field(root, "weighting"), tokenCount);
  const constraintsValue = constraints(errors, field(root, "constraints"));
  if (weightingValue !== undefined && constraintsValue !== undefined && tokenCount !== undefined) {
    bounds(errors, weightingValue, constraintsValue, tokenCount);
  }
  const pricingValue = pricing(errors, field(root, "pricing"), tokenCount);
  const rebalanceValue = rebalance(errors, field(root, "rebalance"));
  const parentValue = parent(errors, field(root, "parent"));

  // Every reader returns undefined only for a property that is absent or that it reported an error for,
  // and the absence of a required property is itself an error, so the checks below only narrow types.
  if (errors.length > 0 || schema === undefined || calc === undefined || chainId === undefined) {
    return { ok: false, errors };
  }
  if (name === undefined || slug === undefined || descriptionText === undefined || universeValue === undefined) {
    return { ok: false, errors };
  }
  if (weightingValue === undefined || pricingValue === undefined || rebalanceValue === undefined) {
    return { ok: false, errors };
  }
  const spec: IndexSpec = {
    schema,
    calc,
    chainId,
    name,
    slug,
    description: descriptionText,
    universe: universeValue,
    weighting: weightingValue,
    ...(constraintsValue === undefined ? {} : { constraints: constraintsValue }),
    pricing: pricingValue,
    rebalance: rebalanceValue,
    ...(parentValue === undefined ? {} : { parent: parentValue }),
  };
  const specBytes = canonicalize(spec);
  if (specBytes.length > MAX_SPEC_BYTES) {
    const message = `canonical form is ${specBytes.length} bytes, the maximum is ${MAX_SPEC_BYTES}`;
    return { ok: false, errors: [{ path: "", code: "spec_too_large", message }] };
  }
  return { ok: true, spec, specBytes };
}
