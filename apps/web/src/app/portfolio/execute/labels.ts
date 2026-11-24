import { formatTokenQuantity, MISSING, shortenAddress } from "@/lib/format";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import type { ApiPortfolio } from "@/lib/portfolio/api";

export interface TokenLabels {
  readonly symbolOf: (token: string) => string;
  /** Decimals read on the chain by the browser, never the plan's. `null` when the read failed. */
  readonly decimalsOf: (token: string) => number | null;
}

export function tokenLabels(snapshot: ExecutionSnapshot, comparison: ApiPortfolio): TokenLabels {
  const usdc = snapshot.network?.usdc ?? null;
  const symbols = new Map<string, string>(
    comparison.constituents.map(({ token, symbol }) => [token.toLowerCase(), symbol ?? shortenAddress(token)]),
  );
  return {
    symbolOf: (token) =>
      usdc !== null && token.toLowerCase() === usdc
        ? "USDC"
        : (symbols.get(token.toLowerCase()) ?? shortenAddress(token)),
    decimalsOf: (token) => snapshot.decimals.get(token.toLowerCase()) ?? null,
  };
}

/** A token amount with the decimals read on the chain, or the missing marker when they could not be read. */
export function quantity(value: bigint, decimals: number | null): string {
  return decimals === null ? MISSING : formatTokenQuantity(value, decimals);
}

/** What one call does, in words, from its decoded calldata. */
export function callTitle(call: VerifiedCall, tokens: TokenLabels): string {
  if (call.kind === "approve") return `Approve ${tokens.symbolOf(call.token)}`;
  return call.side === "sell" ? `Sell ${tokens.symbolOf(call.tokenIn)}` : `Buy ${tokens.symbolOf(call.tokenOut)}`;
}
