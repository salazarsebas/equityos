import { describe, expect, test } from "bun:test";
import {
  type BalanceRead,
  isUsdc,
  summarizeBalances,
  type TokenRef,
  toTokenBalances,
  USDC,
  withUsdc,
} from "../../src/lib/wallet/balances";

const NVDA = { address: "0xb20000000000000000000078ee7ce2fe4908108c", symbol: "NVDAc", decimals: 8 } as const;
const AAPL = { address: "0xb200000000000000000000c2e324d24d7eecd1fb", symbol: "AAPLc", decimals: 8 } as const;
const PRICES: Record<string, bigint> = { NVDAc: 12_982_480_034n, AAPLc: 34_529_769_685n };
const priceOf = ({ symbol }: TokenRef) => PRICES[symbol] ?? null;
const ok = (result: unknown): BalanceRead => ({ status: "success", result });

describe("withUsdc", () => {
  test("puts USDC first and keeps the order of the others", () => {
    expect(withUsdc([NVDA, AAPL]).map(({ symbol }) => symbol)).toEqual(["USDC", "NVDAc", "AAPLc"]);
  });

  test("does not list USDC twice, whatever the case of the address", () => {
    const lower = { ...USDC, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } as const;
    expect(withUsdc([lower, NVDA])).toEqual([USDC, NVDA]);
  });
});

describe("toTokenBalances", () => {
  test("pairs each token with its read", () => {
    expect(toTokenBalances([USDC, NVDA], [ok(5n), ok(0n)])).toEqual([
      { token: USDC, balance: 5n },
      { token: NVDA, balance: 0n },
    ]);
  });

  test("a failed, missing or non-integer read is null, never zero", () => {
    const balances = toTokenBalances([USDC, NVDA, AAPL], [{ status: "failure" }, ok("12")]);
    expect(balances.map(({ balance }) => balance)).toEqual([null, null, null]);
  });
});

describe("summarizeBalances", () => {
  const balances = toTokenBalances(withUsdc([NVDA, AAPL]), [ok(1_250_500_000n), ok(412_500_000n), ok(0n)]);

  test("values USDC at the assumed parity and the rest at reference prices, rounded down", () => {
    const summary = summarizeBalances(balances, priceOf);
    expect(summary.held.map(({ token }) => token.symbol)).toEqual(["USDC", "NVDAc"]);
    expect(summary.empty.map(({ token }) => token.symbol)).toEqual(["AAPLc"]);
    // 1,250.5 USDC at 1.00 USD.
    expect(summary.held[0]).toMatchObject({ priceE8: 100_000_000n, valueE8: 125_050_000_000n });
    // 4.125 tokens at 129.82480034 USD is 535.5273014025 USD: the ninth decimal is dropped.
    expect(summary.held[1]).toMatchObject({ priceE8: 12_982_480_034n, valueE8: 53_552_730_140n });
    expect(summary.totalE8).toBe(178_602_730_140n);
    expect(summary.unvalued).toBe(0);
    expect(summary.empty[0]).toMatchObject({ valueE8: 0n });
  });

  test("the parity applies to USDC only and never comes from the price lookup", () => {
    const lower = { ...USDC, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } as const;
    expect(isUsdc(lower)).toBe(true);
    expect(isUsdc(NVDA)).toBe(false);
    const summary = summarizeBalances(toTokenBalances([USDC, NVDA], [ok(1n), ok(1n)]), () => null);
    expect(summary.held.map(({ valueE8 }) => valueE8)).toEqual([100n, null]);
    expect(summary.totalE8).toBe(100n);
    expect(summary.unvalued).toBe(1);
  });

  test("rounds a value down to the eighth decimal", () => {
    const value = (balance: bigint, token: TokenRef, price: bigint) =>
      summarizeBalances(toTokenBalances([token], [ok(balance)]), () => price).held[0]?.valueE8;
    expect(value(1n, NVDA, 12_982_480_034n)).toBe(129n);
    expect(value(1n, { ...NVDA, decimals: 18 }, 99_999_999n)).toBe(0n);
    expect(value(2n * 10n ** 18n, { ...NVDA, decimals: 18 }, 250_000_000n)).toBe(500_000_000n);
  });

  test("a balance that could not be read stays visible and has no value", () => {
    const summary = summarizeBalances(toTokenBalances([NVDA], [{ status: "failure" }]), priceOf);
    expect(summary.held).toEqual([{ token: NVDA, balance: null, priceE8: 12_982_480_034n, valueE8: null }]);
    expect(summary.totalE8).toBeNull();
    expect(summary.unvalued).toBe(1);
  });

  test("there is no total when nothing is held", () => {
    const summary = summarizeBalances(toTokenBalances([NVDA, AAPL], [ok(0n), ok(0n)]), priceOf);
    expect(summary.held).toEqual([]);
    expect(summary.totalE8).toBeNull();
    expect(summary.unvalued).toBe(0);
  });
});
