import { describe, expect, test } from "bun:test";
import { parseAddressLookup, storedAccount } from "../../src/lib/wallet/address";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("parseAddressLookup", () => {
  test("no parameter is not a lookup", () => {
    expect(parseAddressLookup(undefined)).toEqual({ status: "none" });
    expect(parseAddressLookup("  ")).toEqual({ status: "none" });
    expect(parseAddressLookup([])).toEqual({ status: "none" });
  });

  test("returns the checksum form of a valid address", () => {
    expect(parseAddressLookup(ACCOUNT)).toEqual({ status: "ok", address: ACCOUNT });
    expect(parseAddressLookup(` ${ACCOUNT.toLowerCase()} `)).toEqual({ status: "ok", address: ACCOUNT });
    expect(parseAddressLookup([ACCOUNT, "0x00"])).toEqual({ status: "ok", address: ACCOUNT });
  });

  test("rejects what is not an address, and a wrong checksum", () => {
    const wrongChecksum = ACCOUNT.replace("Fd6", "fd6");
    for (const input of ["0x1234", "vitalik.eth", ACCOUNT.slice(2), `${ACCOUNT}00`, wrongChecksum]) {
      expect(parseAddressLookup(input)).toEqual({ status: "invalid", input });
    }
  });
});

describe("storedAccount", () => {
  const state = (accounts: unknown, current: unknown = "uid") => ({
    chainId: 8453,
    current,
    connections: new Map([["uid", { accounts, chainId: 8453, connector: { id: "x", name: "X", type: "injected" } }]]),
  });

  test("returns the first account of the current connection", () => {
    expect(storedAccount(state([ACCOUNT, "0x0000000000000000000000000000000000000001"]))).toBe(ACCOUNT);
  });

  test("trusts nothing about the shape of a cookie", () => {
    const untrusted = [
      undefined,
      null,
      "state",
      {},
      { current: "uid", connections: {} },
      state([ACCOUNT], null),
      state([ACCOUNT], "other"),
      state([]),
      state("0x"),
      state(["<script>"]),
      state([`${ACCOUNT}0`]),
      { current: "uid", connections: new Map([["uid", null]]) },
    ];
    for (const value of untrusted) expect(storedAccount(value)).toBeNull();
  });
});
