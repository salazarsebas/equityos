/**
 * JSON Canonicalization Scheme (RFC 8785) for the value space of the methodology spec.
 *
 * Supported values: objects, arrays, strings, booleans and integers with absolute value below 2^53.
 * Fractions, larger numbers and `null` are rejected, which removes the only part of RFC 8785 that is
 * hard to port (ECMAScript number formatting): a supported integer is serialized as its decimal digits.
 *
 * The UTF-8 codec and the JSON parser are implemented here on purpose. The platform ones are lenient
 * where a hashed document must be strict: `JSON.parse` keeps the last of two duplicate keys, and a
 * default `TextDecoder` replaces invalid bytes instead of failing.
 */

/** A value this module can canonicalize. */
export type JsonValue = string | number | boolean | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CanonicalErrorCode =
  /** The bytes are not well-formed UTF-8. */
  | "invalid_utf8"
  /** The text is not a single JSON value (RFC 8259). */
  | "invalid_json"
  /** An object has two properties with the same name. */
  | "duplicate_key"
  /** A string or property name contains a surrogate code unit that is not part of a pair. */
  | "lone_surrogate"
  /** Arrays and objects are nested deeper than `MAX_DEPTH`. */
  | "too_deep"
  /** A value outside the supported space: a fraction, an unsafe integer, `null`, or a non-JSON value. */
  | "unsupported_value"
  /** The bytes are valid JSON in the supported space but not the canonical serialization. */
  | "not_canonical";

/** Maximum nesting of arrays and objects. A valid spec nests three levels. */
export const MAX_DEPTH = 32;

/** Thrown by `canonicalize` for a value outside the supported space. */
export class CanonicalizationError extends Error {
  readonly code: CanonicalErrorCode;

  constructor(code: CanonicalErrorCode, message: string) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = code;
  }
}

export type ParseCanonicalResult =
  /** `value` is in the supported space and `canonicalize(value)` equals the input bytes. */
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: CanonicalErrorCode; readonly message: string };

/** True if every surrogate code unit of `text` is part of a high-low pair. */
export function isWellFormedString(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    const next = text.charCodeAt(i + 1);
    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return false;
    i++;
  }
  return true;
}

const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

/** RFC 8785 section 3.2.2.2: escape only `"`, `\` and control characters; everything else is literal. */
function serializeString(text: string, path: string): string {
  if (!isWellFormedString(text)) {
    throw new CanonicalizationError("lone_surrogate", `${path}: string contains a lone surrogate`);
  }
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const short = SHORT_ESCAPES.get(unit);
    if (short !== undefined) out += short;
    else if (unit < 0x20) out += `\\u${unit.toString(16).padStart(4, "0")}`;
    else out += text.charAt(i);
  }
  return `${out}"`;
}

/** True for an object literal or a null-prototype object: not an array, a class instance or `null`. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** RFC 8785 section 3.2.3: property names are ordered by their UTF-16 code units. */
function compareCodeUnits(a: string, b: string): number {
  // The relational operators on strings compare UTF-16 code units, not code points and not a locale.
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function serialize(value: unknown, path: string, depth: number): string {
  if (typeof value === "string") return serializeString(value, path);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError("unsupported_value", `${path}: ${value} is not an integer below 2^53`);
    }
    // String(-0) is "0", as RFC 8785 requires.
    return String(value);
  }
  if (depth >= MAX_DEPTH) {
    throw new CanonicalizationError("too_deep", `${path}: nesting exceeds ${MAX_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const serialized: string[] = [];
    // Index access, so that a hole in a sparse array is seen as `undefined` and rejected.
    for (let i = 0; i < items.length; i++) serialized.push(serialize(items[i], `${path}/${i}`, depth + 1));
    return `[${serialized.join(",")}]`;
  }
  if (isPlainObject(value)) {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError("unsupported_value", `${path}: symbol keys are not JSON`);
    }
    const members = Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => `${serializeString(key, path)}:${serialize(value[key], `${path}/${key}`, depth + 1)}`);
    return `{${members.join(",")}}`;
  }
  const kind = value === null ? "null" : typeof value === "object" ? "a non-plain object" : typeof value;
  throw new CanonicalizationError("unsupported_value", `${path}: ${kind} is not supported`);
}

function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    // `text` is well-formed, so every iteration step is one Unicode scalar value.
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) bytes.push(codePoint);
    else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Strict UTF-8 decoder (RFC 3629): rejects truncated and overlong sequences, encoded surrogates and
 * code points above U+10FFFF. A byte order mark is not removed, so it fails later as invalid JSON.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  const chunks: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i] ?? 0;
    let continuationCount: number;
    let codePoint: number;
    let minimum: number;
    if (lead < 0x80) [continuationCount, codePoint, minimum] = [0, lead, 0];
    else if (lead >= 0xc2 && lead <= 0xdf) [continuationCount, codePoint, minimum] = [1, lead & 0x1f, 0x80];
    else if (lead >= 0xe0 && lead <= 0xef) [continuationCount, codePoint, minimum] = [2, lead & 0x0f, 0x800];
    else if (lead >= 0xf0 && lead <= 0xf4) [continuationCount, codePoint, minimum] = [3, lead & 0x07, 0x10000];
    else return undefined;
    for (let k = 1; k <= continuationCount; k++) {
      const continuation = bytes[i + k];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) return undefined;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
    chunks.push(String.fromCodePoint(codePoint));
    i += continuationCount + 1;
  }
  return chunks.join("");
}

const NUMBER_PATTERN = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const UNICODE_ESCAPE_PATTERN = /[0-9a-fA-F]{4}/y;
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** RFC 8259 parser that fails on duplicate property names and on lone surrogates. */
class JsonParser {
  private position = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): unknown {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.position < this.text.length) throw this.error("invalid_json", "unexpected content after the value");
    return value;
  }

  private error(code: CanonicalErrorCode, message: string): CanonicalizationError {
    return new CanonicalizationError(code, `${message} at offset ${this.position}`);
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length && " \t\n\r".includes(this.text.charAt(this.position))) this.position++;
  }

  private consume(literal: string): boolean {
    if (!this.text.startsWith(literal, this.position)) return false;
    this.position += literal.length;
    return true;
  }

  private match(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.position;
    const found = pattern.exec(this.text)?.[0];
    if (found !== undefined) this.position += found.length;
    return found;
  }

  private parseValue(depth: number): unknown {
    this.skipWhitespace();
    const next = this.text.charAt(this.position);
    if (next === '"') return this.parseString();
    if (next === "{" || next === "[") {
      if (depth >= MAX_DEPTH) throw this.error("too_deep", `nesting exceeds ${MAX_DEPTH} levels`);
      return next === "{" ? this.parseObject(depth) : this.parseArray(depth);
    }
    if (this.consume("true")) return true;
    if (this.consume("false")) return false;
    if (this.consume("null")) return null;
    const digits = this.match(NUMBER_PATTERN);
    if (digits === undefined) throw this.error("invalid_json", "expected a JSON value");
    return Number(digits);
  }

  private parseArray(depth: number): unknown[] {
    this.position++;
    const items: unknown[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return items;
    for (;;) {
      items.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      if (this.consume("]")) return items;
      if (!this.consume(",")) throw this.error("invalid_json", "expected ',' or ']'");
    }
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.position++;
    const members: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.consume("}")) return members;
    for (;;) {
      this.skipWhitespace();
      if (this.text.charAt(this.position) !== '"') throw this.error("invalid_json", "expected a property name");
      const key = this.parseString();
      // Names are compared after unescaping, so "a" and "a" are duplicates.
      if (Object.hasOwn(members, key)) throw this.error("duplicate_key", `duplicate property ${JSON.stringify(key)}`);
      this.skipWhitespace();
      if (!this.consume(":")) throw this.error("invalid_json", "expected ':'");
      // defineProperty instead of assignment, so that a property named "__proto__" is an own property.
      Object.defineProperty(members, key, {
        value: this.parseValue(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.skipWhitespace();
      if (this.consume("}")) return members;
      if (!this.consume(",")) throw this.error("invalid_json", "expected ',' or '}'");
    }
  }

  private parseString(): string {
    this.position++;
    let out = "";
    for (;;) {
      if (this.position >= this.text.length) throw this.error("invalid_json", "unterminated string");
      const character = this.text.charAt(this.position);
      if (character === '"') break;
      if (character.charCodeAt(0) < 0x20) throw this.error("invalid_json", "unescaped control character");
      this.position++;
      if (character !== "\\") {
        out += character;
        continue;
      }
      const escaped = this.text.charAt(this.position);
      this.position++;
      const simple = SIMPLE_ESCAPES.get(escaped);
      if (simple !== undefined) {
        out += simple;
        continue;
      }
      const hex = escaped === "u" ? this.match(UNICODE_ESCAPE_PATTERN) : undefined;
      if (hex === undefined) throw this.error("invalid_json", "invalid escape sequence");
      out += String.fromCharCode(Number.parseInt(hex, 16));
    }
    this.position++;
    if (!isWellFormedString(out)) throw this.error("lone_surrogate", "string contains a lone surrogate");
    return out;
  }
}

/**
 * Serializes `value` as canonical JSON (RFC 8785) and returns its UTF-8 bytes.
 *
 * @throws {CanonicalizationError} if `value` contains anything outside the supported space.
 */
export function canonicalize(value: unknown): Uint8Array {
  return encodeUtf8(serialize(value, "", 0));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Parses bytes that claim to be a canonical document.
 *
 * Succeeds only if the bytes are well-formed UTF-8, are one JSON value without duplicate property
 * names, contain only supported values, and are byte for byte what `canonicalize` produces for the
 * parsed value. Malformed input is an expected outcome and is returned, not thrown.
 */
export function parseCanonical(bytes: Uint8Array): ParseCanonicalResult {
  const text = decodeUtf8(bytes);
  if (text === undefined) return { ok: false, code: "invalid_utf8", message: "the bytes are not well-formed UTF-8" };
  try {
    const value = new JsonParser(text).parseDocument();
    if (!bytesEqual(canonicalize(value), bytes)) {
      return { ok: false, code: "not_canonical", message: "the bytes differ from the canonical serialization" };
    }
    return { ok: true, value };
  } catch (error) {
    if (error instanceof CanonicalizationError) return { ok: false, code: error.code, message: error.message };
    throw error;
  }
}
