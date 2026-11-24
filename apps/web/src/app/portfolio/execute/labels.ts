import { shortenAddress } from "@/lib/format";
import type { ExecutionSnapshot } from "@/lib/execution/snapshot";
import type { VerifiedCall } from "@/lib/execution/verify";
import type { ApiPortfolio } from "@/lib/portfolio/api";

export interface TokenLabels {
  readonly symbolOf: (token: string) => string;
  readonly decimalsOf: (token: string) => number;
}

export function tokenLabels(snapshot: ExecutionSnapshot, comparison: ApiPortfolio): TokenLabels {
  const usdc = snapshot.network?.usdc ?? null;
  const symbols = new Map<string, string>(
    comparison.constituents.map(({ token, symbol }) => [token.toLowerCase(), symbol ?? shortenAddress(token)]),
  );
  const decimals = new Map<string, number>(
    comparison.constituents.map(({ token, decimals: d }) => [token.toLowerCase(), d]),
  );
  for (const leg of snapshot.plan.legs) decimals.set(leg.token.toLowerCase(), leg.decimals);
  return {
    symbolOf: (token) =>
      usdc !== null && token.toLowerCase() === usdc
        ? "USDC"
        : (symbols.get(token.toLowerCase()) ?? shortenAddress(token)),
    decimalsOf: (token) =>
      usdc !== null && token.toLowerCase() === usdc ? 6 : (decimals.get(token.toLowerCase()) ?? 0),
  };
}

/** What one call does, in words, from its decoded calldata. */
export function callTitle(call: VerifiedCall, tokens: TokenLabels): string {
  if (call.kind === "approve") return `Approve ${tokens.symbolOf(call.token)}`;
  return call.side === "sell" ? `Sell ${tokens.symbolOf(call.tokenIn)}` : `Buy ${tokens.symbolOf(call.tokenOut)}`;
}
