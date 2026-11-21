import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Hex } from "./spec.ts";

/** Encodes bytes as `0x` followed by two lowercase hexadecimal digits per byte. */
export function bytesToHex(bytes: Uint8Array): Hex {
  let digits = "";
  for (const byte of bytes) digits += byte.toString(16).padStart(2, "0");
  return `0x${digits}`;
}

/**
 * The identifier of a spec: keccak256 of its canonical bytes, as 64 lowercase hexadecimal digits.
 *
 * This is the Keccak-256 used by the EVM (`keccak256` in Solidity), not NIST SHA3-256. The registry
 * computes the same value over the same bytes at publication.
 */
export function specHash(specBytes: Uint8Array): Hex {
  return bytesToHex(keccak_256(specBytes));
}
