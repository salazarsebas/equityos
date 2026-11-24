import { describe, expect, test } from "bun:test";
import { indexRegistryAbi } from "@equityos/contracts-abi";
import { encodeFunctionData, encodeFunctionResult, type Hex, toFunctionSelector } from "viem";
import {
  AbiDecodingError,
  COMPOSITIONS,
  decodeBool,
  decodeBytes,
  decodeConstituents,
  decodeIndexInfo,
  decodeVersionInfo,
  encodeExists,
  encodeGetIndex,
  encodeVersionCall,
  isVersionNumber,
  SELECTORS,
} from "../src/abi.ts";

const abi = indexRegistryAbi;
const INDEX_ID: Hex = "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610";
const TOKEN_A: Hex = "0xb2000000000000000000001e800a7f5189430cd0";
const TOKEN_B: Hex = "0xb2000000000000000000004884b426556b92883d";

describe("selectors and call data agree with the ABI of @equityos/contracts-abi", () => {
  test("each selector is the one of the ABI function", () => {
    for (const [name, selector] of Object.entries(SELECTORS)) {
      const item = abi.find((entry) => entry.type === "function" && entry.name === name);
      if (item === undefined || item.type !== "function") throw new Error(`${name} is not in the ABI`);
      expect(toFunctionSelector(item)).toBe(selector);
    }
  });

  test("the call data is what viem encodes", () => {
    expect(encodeExists(INDEX_ID)).toBe(encodeFunctionData({ abi, functionName: "exists", args: [INDEX_ID] }));
    expect(encodeGetIndex(INDEX_ID)).toBe(encodeFunctionData({ abi, functionName: "getIndex", args: [INDEX_ID] }));
    for (const version of [1, 2, 4_294_967_295]) {
      for (const functionName of ["getVersion", "specOf", "constituentsOf"] as const) {
        expect(encodeVersionCall(SELECTORS[functionName], INDEX_ID, version)).toBe(
          encodeFunctionData({ abi, functionName, args: [INDEX_ID, version] }),
        );
      }
    }
  });
});

describe("results encoded by viem decode to the same values", () => {
  test("exists", () => {
    expect(decodeBool(encodeFunctionResult({ abi, functionName: "exists", result: true }))).toBe(true);
    expect(decodeBool(encodeFunctionResult({ abi, functionName: "exists", result: false }))).toBe(false);
  });

  test("getIndex", () => {
    const result = {
      creator: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      latestVersion: 4_294_967_295,
      createdAt: 2n ** 64n - 1n,
      deprecatedAt: 0n,
    } as const;
    expect(decodeIndexInfo(encodeFunctionResult({ abi, functionName: "getIndex", result }))).toEqual({
      ...result,
      creator: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    });
  });

  test("getVersion, for each composition", () => {
    for (const [value, composition] of COMPOSITIONS.entries()) {
      const result = {
        specHash: "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
        publishedAt: 1_794_837_605n,
        publishedBlock: 9n,
        composition: value,
        specSize: 969,
        constituentCount: 64,
      } as const;
      expect(decodeVersionInfo(encodeFunctionResult({ abi, functionName: "getVersion", result }))).toEqual({
        ...result,
        composition,
      });
    }
  });

  test("specOf, for lengths around a word boundary", () => {
    for (const length of [0, 1, 31, 32, 33, 969, 8192]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7) % 256);
      const hex = `0x${Buffer.from(bytes).toString("hex")}` as Hex;
      expect(decodeBytes(encodeFunctionResult({ abi, functionName: "specOf", result: hex }))).toEqual(bytes);
    }
  });

  test("constituentsOf", () => {
    const result = [
      { token: TOKEN_A, weightBps: 2500 },
      { token: TOKEN_B, weightBps: 65_535 },
    ];
    expect(decodeConstituents(encodeFunctionResult({ abi, functionName: "constituentsOf", result }))).toEqual(result);
    expect(decodeConstituents(encodeFunctionResult({ abi, functionName: "constituentsOf", result: [] }))).toEqual([]);
  });
});

describe("decoding refuses what the registry cannot have returned", () => {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");

  test("data that is not whole words, or shorter than its type", () => {
    expect(() => decodeBool("0x01")).toThrow(AbiDecodingError);
    expect(() => decodeBool("0x")).toThrow(AbiDecodingError);
    expect(() => decodeIndexInfo(`0x${word(1n)}`)).toThrow(AbiDecodingError);
    expect(() => decodeBool(`0x${"zz".repeat(32)}`)).toThrow(AbiDecodingError);
  });

  test("a boolean other than 0 or 1, an address with high bits and integers wider than their type", () => {
    expect(() => decodeBool(`0x${word(2n)}`)).toThrow("neither 0 nor 1");
    const info = [word(1n << 160n), word(1n), word(1n), word(0n)];
    expect(() => decodeIndexInfo(`0x${info.join("")}`)).toThrow("high 12 bytes");
    const version = [word(1n), word(1n), word(1n), word(3n), word(1n), word(1n)];
    expect(() => decodeVersionInfo(`0x${version.join("")}`)).toThrow("enum");
    version[5] = word(65_536n);
    version[3] = word(2n);
    expect(() => decodeVersionInfo(`0x${version.join("")}`)).toThrow("uint16");
  });

  test("an offset or a length out of bounds", () => {
    expect(() => decodeBytes(`0x${word(64n)}${word(0n)}`)).toThrow(AbiDecodingError);
    expect(() => decodeBytes(`0x${word(32n)}${word(33n)}${word(0n)}`)).toThrow(AbiDecodingError);
    expect(() => decodeBytes(`0x${word(1n)}${word(0n)}`)).toThrow("multiple of 32");
    expect(() => decodeConstituents(`0x${word(32n)}${word(2n)}${word(1n)}${word(1n)}`)).toThrow(AbiDecodingError);
    expect(() => decodeConstituents(`0x${word(2n ** 255n)}`)).toThrow("out of bounds");
  });
});

test("version numbers are 1 to 2^32 - 1", () => {
  expect([1, 4_294_967_295].map(isVersionNumber)).toEqual([true, true]);
  expect([0, -1, 1.5, 4_294_967_296, Number.NaN].map(isVersionNumber)).toEqual([false, false, false, false, false]);
});
