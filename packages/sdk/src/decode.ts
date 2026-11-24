/**
 * Runtime decoders for API responses.
 *
 * Every decoder carries a `shape`: a plain description of the JSON it accepts. The web app compares each shape
 * with the schema the OpenAPI document gives for the same response, so the types of this package and the
 * contract of the API cannot drift apart without a test failing.
 *
 * The decoders follow the versioning rules of API v1: a property they do not know is ignored, and a value of an
 * enumeration they do not know is returned as is. A missing property, a wrong type or a malformed amount fails.
 */

/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/**
 * A string enumeration of the API. A value added in a later minor version of the API arrives as is, so code
 * that branches on it must handle a value it does not know.
 */
export type OpenEnum<Known extends string> = Known | (string & Record<never, never>);

/** The JSON a decoder accepts. Compared with the OpenAPI document by a test of the web app. */
export type Shape =
  /** Any string. */
  | { readonly kind: "string" }
  /** A string from a known set. Values outside it are accepted, as API v1 requires. */
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** One fixed value. */
  | { readonly kind: "literal"; readonly value: string | boolean }
  /** A JSON number that is a safe integer: a count, a version, decimals, basis points or a chain id. */
  | { readonly kind: "integer" }
  /** A non-negative integer in a decimal string, decoded to `bigint`: an amount, a price or a block number. */
  | { readonly kind: "uint" }
  | { readonly kind: "boolean" }
  /** A JSON object whose content is not specified. */
  | { readonly kind: "json" }
  | { readonly kind: "array"; readonly items: Shape }
  | { readonly kind: "nullable"; readonly inner: Shape }
  | {
      readonly kind: "object";
      readonly properties: Readonly<Record<string, Shape>>;
      /** Properties that may be absent. Every other property is required. */
      readonly optional: readonly string[];
    }
  /** One of several objects, selected by the string value of `discriminant`. */
  | { readonly kind: "union"; readonly discriminant: string; readonly options: Readonly<Record<string, Shape>> };

export interface Decoder<T> {
  readonly shape: Shape;
  /** Returns the decoded value, or throws `DecodeFailure` naming the path of the first mismatch. */
  readonly decode: (value: unknown, path: string) => T;
}

export type Infer<D> = D extends Decoder<infer T> ? T : never;

/** A value does not have the shape a decoder expects. `path` locates it, such as `data[2].priceE8`. */
export class DecodeFailure extends Error {
  readonly path: string;

  constructor(path: string, expected: string) {
    super(`${path || "the response"}: expected ${expected}`);
    this.name = "DecodeFailure";
    this.path = path;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

export function string(): Decoder<string> {
  return {
    shape: { kind: "string" },
    decode: (value, path) => {
      if (typeof value !== "string") throw new DecodeFailure(path, "a string");
      return value;
    },
  };
}

/**
 * A string typed as `T`, for text whose values are documented outside the OpenAPI document, such as the code
 * of a verification check. It is not checked against a set.
 */
export function stringOf<T extends string>(): Decoder<OpenEnum<T>> {
  return string();
}

/** A string of `0x` and an even or odd number of hexadecimal digits: an address, a hash or bytes. */
export function hex(): Decoder<Hex> {
  return {
    shape: { kind: "string" },
    decode: (value, path) => {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
        throw new DecodeFailure(path, "a 0x-prefixed hexadecimal string");
      }
      return value as Hex;
    },
  };
}

export function enumOf<const T extends string>(values: readonly T[]): Decoder<OpenEnum<T>> {
  return { shape: { kind: "enum", values }, decode: string().decode };
}

export function literal<const T extends string | boolean>(expected: T): Decoder<T> {
  return {
    shape: { kind: "literal", value: expected },
    decode: (value, path) => {
      if (value !== expected) throw new DecodeFailure(path, JSON.stringify(expected));
      return expected;
    },
  };
}

/**
 * A string constant of the API, such as the source of reference prices. Like an enumeration, a value added in a
 * later minor version arrives as is.
 */
export function constant<const T extends string>(expected: T): Decoder<OpenEnum<T>> {
  return { shape: { kind: "literal", value: expected }, decode: string().decode };
}

export function integer(): Decoder<number> {
  return {
    shape: { kind: "integer" },
    decode: (value, path) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new DecodeFailure(path, "an integer");
      return value;
    },
  };
}

/** A non-negative integer written in decimal digits, without sign, fraction or leading zero, as a `bigint`. */
export function uint(): Decoder<bigint> {
  return {
    shape: { kind: "uint" },
    decode: (value, path) => {
      if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new DecodeFailure(path, "a non-negative integer in a decimal string");
      }
      return BigInt(value);
    },
  };
}

export function boolean(): Decoder<boolean> {
  return {
    shape: { kind: "boolean" },
    decode: (value, path) => {
      if (typeof value !== "boolean") throw new DecodeFailure(path, "a boolean");
      return value;
    },
  };
}

/** A JSON object returned as it is, for content the API does not specify field by field. */
export function json(): Decoder<Readonly<Record<string, unknown>>> {
  return {
    shape: { kind: "json" },
    decode: (value, path) => {
      if (!isRecord(value)) throw new DecodeFailure(path, "an object");
      return value;
    },
  };
}

export function array<T>(items: Decoder<T>): Decoder<readonly T[]> {
  return {
    shape: { kind: "array", items: items.shape },
    decode: (value, path) => {
      if (!Array.isArray(value)) throw new DecodeFailure(path, "an array");
      return value.map((item: unknown, index) => items.decode(item, `${path}[${index}]`));
    },
  };
}

export function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return {
    shape: { kind: "nullable", inner: inner.shape },
    decode: (value, path) => (value === null ? null : inner.decode(value, path)),
  };
}

type Properties = Readonly<Record<string, Decoder<unknown>>>;

type Simplify<T> = { [K in keyof T]: T[K] };

export type ObjectOf<P extends Properties, O extends keyof P> = Simplify<
  { readonly [K in Exclude<keyof P, O>]: Infer<P[K]> } & { readonly [K in O]?: Infer<P[K]> }
>;

/**
 * An object with the given properties. Each property is required unless it is listed in `optional`, in which
 * case it may be absent but never `null`. Properties that are not declared are ignored and not returned.
 */
export function object<const P extends Properties, const O extends keyof P & string = never>(
  properties: P,
  optional: readonly O[] = [],
): Decoder<ObjectOf<P, O>> {
  const shapes: Record<string, Shape> = {};
  for (const [key, decoder] of Object.entries(properties)) shapes[key] = decoder.shape;
  return {
    shape: { kind: "object", properties: shapes, optional },
    decode: (value, path) => {
      if (!isRecord(value)) throw new DecodeFailure(path, "an object");
      const result: Record<string, unknown> = {};
      for (const [key, decoder] of Object.entries(properties)) {
        const at = join(path, key);
        if (!Object.hasOwn(value, key)) {
          if ((optional as readonly string[]).includes(key)) continue;
          throw new DecodeFailure(at, "a value (the property is missing)");
        }
        result[key] = decoder.decode(value[key], at);
      }
      return result as ObjectOf<P, O>;
    },
  };
}

/** One of several object decoders, chosen by the value of the string property `discriminant`. */
export function union<const D extends string, const Options extends Readonly<Record<string, Decoder<unknown>>>>(
  discriminant: D,
  options: Options,
): Decoder<Infer<Options[keyof Options]>> {
  const shapes: Record<string, Shape> = {};
  for (const [key, decoder] of Object.entries(options)) shapes[key] = decoder.shape;
  return {
    shape: { kind: "union", discriminant, options: shapes },
    decode: (value, path) => {
      const tag = isRecord(value) ? value[discriminant] : undefined;
      const option = typeof tag === "string" && Object.hasOwn(options, tag) ? options[tag] : undefined;
      if (option === undefined) {
        throw new DecodeFailure(join(path, discriminant), `one of ${Object.keys(options).join(", ")}`);
      }
      return option.decode(value, path) as Infer<Options[keyof Options]>;
    },
  };
}

/** A decoder with the shape of `base` and its own decoding, for a value that a stricter function validates. */
export function refine<T>(base: Decoder<unknown>, decode: (value: unknown, path: string) => T): Decoder<T> {
  return { shape: base.shape, decode };
}
