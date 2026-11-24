import { concat, type Hex, stringToHex, toHex } from "viem";

/**
 * ERC-8021 transaction attribution, schema 0 (canonical registry). The suffix appended to calldata is
 *
 *   codes ∥ codesLength (1 byte) ∥ schemaId (1 byte, 0x00) ∥ marker (16 bytes, 0x8021 repeated)
 *
 * where `codes` are ASCII codes joined by commas, read backwards from the end of the calldata. This is the
 * encoding of `Attribution.toDataSuffix({ codes })` in the `ox` package (`ox/erc8021`), which the unit test
 * reproduces byte for byte with its documented example.
 */
export const ERC8021_MARKER: Hex = "0x80218021802180218021802180218021";
const SCHEMA_CANONICAL_REGISTRY = 0;

/** Longest code accepted, in characters. The length byte bounds all codes together at 255. */
export const MAX_BUILDER_CODE_LENGTH = 64;

/**
 * A code is printable ASCII without a comma (the separator) or a space: letters, digits and punctuation such as
 * `bc_xyz456`. Anything else would not decode as the same code.
 */
const CODE_PATTERN = /^[\x21-\x2b\x2d-\x7e]+$/;

/** The configured Builder Code. Read by its full name so that Next.js inlines it in the browser bundle. */
export const BUILDER_CODE_ENV: string | undefined = process.env.NEXT_PUBLIC_BUILDER_CODE;

/** `NEXT_PUBLIC_BUILDER_CODE` is set to a value that is not a valid code. */
export class InvalidBuilderCodeError extends Error {
  constructor() {
    super("NEXT_PUBLIC_BUILDER_CODE is not printable ASCII of 1 to 64 characters without a comma or a space");
    this.name = "InvalidBuilderCodeError";
  }
}

/**
 * The ERC-8021 suffix of the configured Builder Code, or `null` when none is configured: then nothing is
 * appended to any call.
 *
 * @throws {InvalidBuilderCodeError} if a code is configured and is not valid: a typo must not silently
 *   attribute transactions to another code, nor be dropped
 */
export function builderCodeSuffix(code: string | undefined = BUILDER_CODE_ENV): Hex | null {
  const trimmed = code?.trim() ?? "";
  if (trimmed === "") return null;
  if (trimmed.length > MAX_BUILDER_CODE_LENGTH || !CODE_PATTERN.test(trimmed)) throw new InvalidBuilderCodeError();
  const codes = stringToHex(trimmed);
  return concat([
    codes,
    toHex(trimmed.length, { size: 1 }),
    toHex(SCHEMA_CANONICAL_REGISTRY, { size: 1 }),
    ERC8021_MARKER,
  ]);
}

/** `data` with `suffix` appended, or `data` unchanged when there is no suffix. */
export function withSuffix(data: Hex, suffix: Hex | null): Hex {
  return suffix === null ? data : concat([data, suffix]);
}
