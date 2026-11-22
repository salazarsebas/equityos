import { describe, expect, test } from "bun:test";
import {
  type BalanceRead,
  referenceValueE8,
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

describe("referenceValueE8", () => {
  test("multiplies base units by the price and rounds down", () => {
    // 4.125 tokens at 129.82480034 USD is 535.5273014025 USD: the ninth decimal is dropped.
    expect(referenceValueE8(412_500_000n, 8, 12_982_480_034n)).toBe(53_552_730_140n);
    expect(referenceValueE8(1n, 8, 12_982_480_034n)).toBe(129n);
    expect(referenceValueE8(1n, 18, 99_999_999n)).toBe(0n);
    expect(referenceValueE8(0n, 8, 12_982_480_034n)).toBe(0n);
  });

  test("handles tokens with other decimals", () => {
    expect(referenceValueE8(1_500_000n, 6, 100_000_000n)).toBe(150_000_000n);
    expect(referenceValueE8(2n * 10n ** 18n, 18, 250_000_000n)).toBe(500_000_000n);
  });
});

describe("summarizeBalances", () => {
  const balances = toTokenBalances(withUsdc([NVDA, AAPL]), [ok(1_250_500_000n), ok(412_500_000n), ok(0n)]);

  test("splits held from empty and totals the values that exist", () => {
    const summary = summarizeBalances(balances, priceOf);
    expect(summary.held.map(({ token }) => token.symbol)).toEqual(["USDC", "NVDAc"]);
    expect(summary.empty.map(({ token }) => token.symbol)).toEqual(["AAPLc"]);
    expect(summary.totalE8).toBe(53_552_730_140n);
    expect(summary.unvalued).toBe(1);
    expect(summary.held[0]).toMatchObject({ priceE8: null, valueE8: null });
    expect(summary.empty[0]).toMatchObject({ valueE8: 0n });
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
