import { describe, expect, test } from "bun:test";
import { bytesToHex, specHash } from "../src/index.ts";
import { utf8 } from "./helpers.ts";

describe("specHash", () => {
  // Reference digests of Keccak-256 as used by the EVM, reproducible with `cast keccak`.
  test("is Keccak-256 of the bytes", () => {
    expect(specHash(new Uint8Array())).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(specHash(utf8("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    expect(specHash(utf8("{}"))).toBe("0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d");
  });

  test("is not NIST SHA3-256, which differs only in padding", () => {
    expect(specHash(new Uint8Array())).not.toBe("0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a");
  });

  test("depends on every byte", () => {
    expect(specHash(utf8('{"a":1}'))).not.toBe(specHash(utf8('{"a":2}')));
    expect(specHash(utf8('{"a":1}'))).not.toBe(specHash(utf8('{"a":1} ')));
  });
});

describe("bytesToHex", () => {
  test("writes two lowercase digits per byte after 0x", () => {
    expect(bytesToHex(Uint8Array.from([0, 1, 0x0a, 0xab, 0xff]))).toBe("0x00010aabff");
    expect(bytesToHex(new Uint8Array())).toBe("0x");
  });
});
