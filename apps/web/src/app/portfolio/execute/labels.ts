import { formatFixed, formatTokenQuantity, MISSING, shortenAddress } from "@/lib/format";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import type { ApiPortfolio } from "@/lib/portfolio/api";

export interface TokenLabels {
  readonly symbolOf: (token: string) => string;
  /** Decimals read on the chain by the browser, never the plan's. `null` when the read failed. */
  readonly decimalsOf: (token: string) => number | null;
  /**
   * The name of a contract the review knows: the router, USDC, a constituent by its symbol or the rebalance log.
   * `null` for any other address, which is then shown by its address alone.
   */
  readonly contractName: (address: string) => string | null;
}

export function tokenLabels(snapshot: ExecutionSnapshot, comparison: ApiPortfolio): TokenLabels {
  const usdc = snapshot.network?.usdc ?? null;
  const symbols = new Map<string, string>(
    comparison.constituents.map(({ token, symbol }) => [token.toLowerCase(), symbol ?? shortenAddress(token)]),
  );
  const named = new Map<string, string>(
    comparison.constituents.flatMap(({ token, symbol }) => (symbol === null ? [] : [[token.toLowerCase(), symbol]])),
  );
  const router = snapshot.network?.router ?? null;
  const log = snapshot.attestation.status === "included" ? snapshot.attestation.call.to.toLowerCase() : null;
  return {
    symbolOf: (token) =>
      usdc !== null && token.toLowerCase() === usdc
        ? "USDC"
        : (symbols.get(token.toLowerCase()) ?? shortenAddress(token)),
    decimalsOf: (token) => snapshot.decimals.get(token.toLowerCase()) ?? null,
    contractName: (address) => {
      const lower = address.toLowerCase();
      if (router !== null && lower === router) return "Router";
      if (usdc !== null && lower === usdc) return "USDC";
      if (log !== null && lower === log) return "Rebalance log";
      return named.get(lower) ?? null;
    },
  };
}

/** A token amount with the decimals read on the chain, or the missing marker when they could not be read. */
export function quantity(value: bigint, decimals: number | null): string {
  return decimals === null ? MISSING : formatTokenQuantity(value, decimals);
}

/**
 * A token amount with every decimal the token has, and the base units it is: `4.00000000 NVDAc (400000000 base
 * units)`. Exact: nothing is rounded. The missing marker stands for the decimal value when the decimals could not
 * be read on the chain; the base units are still shown.
 */
export function exactAmount(value: bigint, token: string, tokens: TokenLabels): string {
  const decimals = tokens.decimalsOf(token);
  const decimal = decimals === null ? MISSING : formatFixed(value, decimals, decimals);
  return `${decimal} ${tokens.symbolOf(token)} (${value.toString()} base units)`;
}

/** What one call does, in words, from its decoded calldata. */
export function callTitle(call: VerifiedCall, tokens: TokenLabels): string {
  if (call.kind === "approve") return `Approve ${tokens.symbolOf(call.token)}`;
  return call.side === "sell" ? `Sell ${tokens.symbolOf(call.tokenIn)}` : `Buy ${tokens.symbolOf(call.tokenOut)}`;
}
