import { mulDivDown } from "@equityos/core";
import type { Address } from "viem";

/** A token whose balance is read: its address on Base mainnet and its decimals. */
export interface TokenRef {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * USDC on Base mainnet, the native token issued by Circle. The address is the one Circle publishes at
 * https://developers.circle.com/stablecoins/usdc-contract-addresses, and `symbol()` and `decimals()` of the
 * contract answer "USDC" and 6.
 */
export const USDC = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
} as const satisfies TokenRef & { name: string };

/** Minimal ABI of the one ERC-20 function the app calls from the browser. */
export const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** The balance of one token, in base units. `null` when its read failed: a failed read is never shown as zero. */
export interface TokenBalance<token extends TokenRef = TokenRef> {
  readonly token: token;
  readonly balance: bigint | null;
}

/** One result of a multicall that allows failures. */
export type BalanceRead = { readonly status: "success"; readonly result: unknown } | { readonly status: "failure" };

/** USDC first, then the given tokens in their order, without a second entry for USDC. */
export function withUsdc<token extends TokenRef>(tokens: readonly token[]): (token | typeof USDC)[] {
  const usdc = USDC.address.toLowerCase();
  return [USDC, ...tokens.filter(({ address }) => address.toLowerCase() !== usdc)];
}

/** Pairs each token with its multicall result. A failed, missing or non-integer result is `null`. */
export function toTokenBalances<token extends TokenRef>(
  tokens: readonly token[],
  reads: readonly BalanceRead[],
): TokenBalance<token>[] {
  return tokens.map((token, index) => {
    const read = reads[index];
    const balance = read?.status === "success" && typeof read.result === "bigint" ? read.result : null;
    return { token, balance };
  });
}

/** Decimals of a reference price and of a value computed from it. */
export const USD_E8_DECIMALS = 8;

/**
 * Value of a balance at a reference price, in USD scaled by 1e8. Rounded down, so a shown value never exceeds
 * the exact one. It is an indication of value, not what a trade would return.
 *
 * @param balance token base units
 * @param decimals decimals of the token
 * @param priceE8 USD per whole token, scaled by 1e8
 */
export function referenceValueE8(balance: bigint, decimals: number, priceE8: bigint): bigint {
  return mulDivDown(balance, priceE8, 10n ** BigInt(decimals));
}

/** A row of the balances table: a balance and, when both exist, its reference price and value. */
export interface ValuedBalance<token extends TokenRef = TokenRef> extends TokenBalance<token> {
  /** USD per whole token, scaled by 1e8. `null` when the token has no usable reference price. */
  readonly priceE8: bigint | null;
  /** `null` when the balance or the price is missing. Never defaulted to zero. */
  readonly valueE8: bigint | null;
}

export interface BalanceSummary<token extends TokenRef = TokenRef> {
  /** Balances above zero, and balances that could not be read: both must stay visible. */
  readonly held: readonly ValuedBalance<token>[];
  /** Balances read as exactly zero. */
  readonly empty: readonly ValuedBalance<token>[];
  /** Sum of the values that exist, USD scaled by 1e8. `null` when no held balance has a value. */
  readonly totalE8: bigint | null;
  /** Number of held balances left out of the total because they have no value. */
  readonly unvalued: number;
}

/**
 * Values each balance and splits the rows into held and empty.
 *
 * @param priceE8Of the usable reference price of a token, or `null` when it has none
 */
export function summarizeBalances<token extends TokenRef>(
  balances: readonly TokenBalance<token>[],
  priceE8Of: (token: token) => bigint | null,
): BalanceSummary<token> {
  const rows = balances.map(({ token, balance }): ValuedBalance<token> => {
    const priceE8 = priceE8Of(token);
    const valueE8 = balance === null || priceE8 === null ? null : referenceValueE8(balance, token.decimals, priceE8);
    return { token, balance, priceE8, valueE8 };
  });
  const held = rows.filter(({ balance }) => balance !== 0n);
  const values = held.flatMap(({ valueE8 }) => (valueE8 === null ? [] : [valueE8]));
  return {
    held,
    empty: rows.filter(({ balance }) => balance === 0n),
    totalE8: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0n),
    unvalued: held.length - values.length,
  };
}
