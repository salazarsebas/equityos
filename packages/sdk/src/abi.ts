/**
 * Encoding of the five `IndexRegistry` reads `verifyIndexVersion` makes, and strict decoding of their results.
 *
 * The package carries this instead of depending on an Ethereum library: the layouts are fixed by the ABI of
 * `@equityos/contracts-abi`, and `test/abi.test.ts` checks every selector and every layout against that ABI with
 * viem. Decoding rejects anything the registry cannot have returned: an offset or a length out of bounds, an
 * address with high bits set, an integer wider than its type or a boolean other than 0 or 1.
 */

import type { Hex } from "./decode.ts";

/** Function selectors: the first four bytes of keccak256 of the signature. */
export const SELECTORS = {
  exists: "0x38a699a4",
  getIndex: "0x8527831b",
  getVersion: "0x6edceec2",
  specOf: "0x4cebcdb1",
  constituentsOf: "0x91e8563f",
} as const;

/** `Composition` of `IIndexRegistry`, by its numeric value. */
export const COMPOSITIONS = ["rule_based", "dynamic_weights", "static"] as const;

export type Composition = (typeof COMPOSITIONS)[number];

export interface IndexInfo {
  readonly creator: Hex;
  readonly latestVersion: number;
  readonly createdAt: bigint;
  readonly deprecatedAt: bigint;
}

export interface VersionInfo {
  readonly specHash: Hex;
  readonly publishedAt: bigint;
  readonly publishedBlock: bigint;
  readonly composition: Composition;
  readonly specSize: number;
  readonly constituentCount: number;
}

export interface StoredConstituent {
  readonly token: Hex;
  readonly weightBps: number;
}

/** The data is not a valid encoding of the expected return type. */
export class AbiDecodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiDecodingError";
  }
}

const WORD = 64;
const MAX_UINT32 = 2n ** 32n - 1n;

function encodeBytes32(value: Hex): string {
  return value.slice(2).toLowerCase();
}

function encodeUint(value: number): string {
  return value.toString(16).padStart(WORD, "0");
}

export function encodeExists(indexId: Hex): Hex {
  return `${SELECTORS.exists}${encodeBytes32(indexId)}`;
}

export function encodeGetIndex(indexId: Hex): Hex {
  return `${SELECTORS.getIndex}${encodeBytes32(indexId)}`;
}

export function encodeVersionCall(
  selector: (typeof SELECTORS)["getVersion" | "specOf" | "constituentsOf"],
  indexId: Hex,
  version: number,
): Hex {
  return `${selector}${encodeBytes32(indexId)}${encodeUint(version)}`;
}

/** The return data as hexadecimal digits without the prefix, checked to be whole 32-byte words. */
function words(data: Hex): string {
  const digits = data.slice(2);
  if (!/^[0-9a-fA-F]*$/.test(digits) || digits.length % WORD !== 0) {
    throw new AbiDecodingError("the return data is not a sequence of 32-byte words");
  }
  return digits.toLowerCase();
}

function word(digits: string, index: number): string {
  const start = index * WORD;
  if (start + WORD > digits.length) throw new AbiDecodingError("the return data is shorter than its type");
  return digits.slice(start, start + WORD);
}

function uint(digits: string, index: number, bits: number): bigint {
  const value = BigInt(`0x${word(digits, index)}`);
  if (value >= 2n ** BigInt(bits)) throw new AbiDecodingError(`a value does not fit uint${bits}`);
  return value;
}

/** A small unsigned integer that fits a JavaScript number exactly. */
function smallUint(digits: string, index: number, bits: 8 | 16 | 32): number {
  return Number(uint(digits, index, bits));
}

function address(digits: string, index: number): Hex {
  const value = word(digits, index);
  if (!value.startsWith("0".repeat(24))) throw new AbiDecodingError("an address has its high 12 bytes set");
  return `0x${value.slice(24)}`;
}

/** An offset or a length, bounded by the data, as a number of bytes. */
function position(digits: string, index: number): number {
  const value = uint(digits, index, 256);
  if (value > BigInt(digits.length / 2)) throw new AbiDecodingError("an offset or a length is out of bounds");
  return Number(value);
}

/** The word index a dynamic value starts at, from the offset in the first word. */
function dynamicStart(digits: string): number {
  const offset = position(digits, 0);
  if (offset % 32 !== 0) throw new AbiDecodingError("an offset is not a multiple of 32 bytes");
  return offset / 32;
}

export function decodeBool(data: Hex): boolean {
  const digits = words(data);
  const value = uint(digits, 0, 256);
  if (value > 1n) throw new AbiDecodingError("a boolean is neither 0 nor 1");
  return value === 1n;
}

export function decodeIndexInfo(data: Hex): IndexInfo {
  const digits = words(data);
  return {
    creator: address(digits, 0),
    latestVersion: smallUint(digits, 1, 32),
    createdAt: uint(digits, 2, 64),
    deprecatedAt: uint(digits, 3, 64),
  };
}

export function decodeVersionInfo(data: Hex): VersionInfo {
  const digits = words(data);
  const composition = COMPOSITIONS[smallUint(digits, 3, 8)];
  if (composition === undefined) throw new AbiDecodingError("the composition is not a value of the enum");
  return {
    specHash: `0x${word(digits, 0)}`,
    publishedAt: uint(digits, 1, 64),
    publishedBlock: uint(digits, 2, 64),
    composition,
    specSize: smallUint(digits, 4, 32),
    constituentCount: smallUint(digits, 5, 16),
  };
}

export function decodeBytes(data: Hex): Uint8Array {
  const digits = words(data);
  const start = dynamicStart(digits);
  const length = position(digits, start);
  const begin = (start + 1) * WORD;
  if (begin + length * 2 > digits.length) throw new AbiDecodingError("the bytes are longer than the return data");
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Number.parseInt(digits.slice(begin + i * 2, begin + i * 2 + 2), 16);
  return bytes;
}

export function decodeConstituents(data: Hex): StoredConstituent[] {
  const digits = words(data);
  const start = dynamicStart(digits);
  const count = position(digits, start);
  const constituents: StoredConstituent[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = start + 1 + i * 2;
    constituents.push({ token: address(digits, at), weightBps: smallUint(digits, at + 1, 16) });
  }
  return constituents;
}

/** Whether `version` is a version number the registry can hold: 1 to 2^32 - 1. */
export function isVersionNumber(version: number): boolean {
  return Number.isSafeInteger(version) && version >= 1 && BigInt(version) <= MAX_UINT32;
}
