import "server-only";
import { mulDivDown } from "@equityos/core";
import { type Address, decodeFunctionData, type Hex, parseAbi, toFunctionSelector } from "viem";
import type { ProviderQuote, QuoteFailure, QuoteRequest } from "./provider";

/**
 * KyberSwap `MetaAggregationRouterV2` on Base mainnet, lowercase. Listed for chain 8453 in the KyberSwap
 * contract documentation, returned as `routerAddress` by the aggregator API for Base, verified on Sourcify
 * for chain 8453 (solc 0.8.9) and answering `WETH()` with the Base WETH predeploy. Calldata addressed to any
 * other contract is refused, including other routers of the same provider.
 */
export const KYBERSWAP_ROUTER: Address = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";

/**
 * The swap functions of the router, as in its verified source. Each one carries a `SwapDescriptionV2`, which
 * names the tokens, the amount pulled from the sender, the receiver and the minimum amount out that the router
 * enforces onchain. No other function of the router is ever accepted.
 */
export const kyberswapRouterAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapGeneric(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
  "function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256 returnAmount, uint256 gasUsed)",
]);

/** Selectors of the allowed functions: `0xe21fd0e9`, `0x59e50fed` and `0x8af033fb`. */
export const ALLOWED_SELECTORS: ReadonlySet<Hex> = new Set(
  kyberswapRouterAbi.filter((item) => item.type === "function").map((item) => toFunctionSelector(item)),
);

/**
 * Router flags that change what a swap does to the sender: a partial fill sells less than `amount`, and
 * extra ETH would take native value from the sender. Neither is part of a plan, so a description that sets
 * either is refused.
 */
const FORBIDDEN_FLAGS = 0x01n | 0x02n;

/** A provider quote whose calldata was decoded and checked against the request. */
export interface ExecutableQuote {
  readonly provider: string;
  readonly router: Address;
  readonly calldata: Hex;
  readonly value: bigint;
  readonly functionName: "swap" | "swapGeneric" | "swapSimpleMode";
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  /** The minimum the router enforces, decoded from the calldata. */
  readonly minAmountOut: bigint;
  readonly gasEstimate: bigint;
  readonly routeId: string;
}

/** `floor(quoted * (10000 - slippageBps) / 10000)`: down, so the floor of what the request tolerates. */
export function minimumAmountOut(quoted: bigint, slippageBps: number): bigint {
  return mulDivDown(quoted, BigInt(10_000 - slippageBps), 10_000n);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function failed(reason: QuoteFailure["reason"], detail: string): QuoteFailure {
  return { status: "failed", reason, detail };
}

/**
 * Verifies a provider quote before anything else may use it. The provider is a third party: its calldata is
 * accepted only when it is addressed to the allowlisted router, calls one of the allowed swap functions, sends
 * no native value, and its decoded description swaps exactly `amountIn` of `tokenIn` from the account for
 * `tokenOut` delivered to the account, with no fee, no permit, no partial fill and a minimum amount out at least
 * the minimum recomputed here from the quoted amount and the requested tolerance.
 */
export function verifyQuote(
  request: QuoteRequest,
  quote: ProviderQuote,
): { readonly status: "ok"; readonly quote: ExecutableQuote } | QuoteFailure {
  if (!same(quote.router, KYBERSWAP_ROUTER)) return failed("router_not_allowed", quote.router.toLowerCase());
  const selector = quote.calldata.slice(0, 10).toLowerCase();
  if (!ALLOWED_SELECTORS.has(selector as Hex)) return failed("unknown_selector", selector);
  let decoded: ReturnType<typeof decodeFunctionData<typeof kyberswapRouterAbi>>;
  try {
    decoded = decodeFunctionData({ abi: kyberswapRouterAbi, data: quote.calldata });
  } catch {
    return failed("calldata_mismatch", "undecodable");
  }
  const desc = decoded.functionName === "swapSimpleMode" ? decoded.args[1] : decoded.args[0].desc;
  const floor = minimumAmountOut(quote.quotedAmountOut, request.slippageBps);
  const sumIn = desc.srcAmounts.reduce((sum, amount) => sum + amount, 0n);
  const mismatches = [
    quote.value !== 0n && "value",
    quote.amountIn !== request.amountIn && "amountIn",
    quote.quotedAmountOut <= 0n && "quotedAmountOut",
    !same(desc.srcToken, request.tokenIn) && "srcToken",
    !same(desc.dstToken, request.tokenOut) && "dstToken",
    desc.amount !== request.amountIn && "amount",
    (desc.srcReceivers.length !== desc.srcAmounts.length || sumIn !== request.amountIn) && "srcAmounts",
    (desc.feeReceivers.length > 0 || desc.feeAmounts.length > 0) && "fee",
    !same(desc.dstReceiver, request.account) && "dstReceiver",
    desc.permit !== "0x" && "permit",
    (desc.flags & FORBIDDEN_FLAGS) !== 0n && "flags",
    (desc.minReturnAmount < floor || desc.minReturnAmount <= 0n || desc.minReturnAmount > quote.quotedAmountOut) &&
      "minReturnAmount",
  ].filter((field): field is string => field !== false);
  if (mismatches.length > 0) return failed("calldata_mismatch", mismatches.join(","));
  return {
    status: "ok",
    quote: {
      provider: quote.provider,
      router: KYBERSWAP_ROUTER,
      calldata: quote.calldata,
      value: 0n,
      functionName: decoded.functionName,
      amountIn: request.amountIn,
      quotedAmountOut: quote.quotedAmountOut,
      minAmountOut: desc.minReturnAmount,
      gasEstimate: quote.gasEstimate,
      routeId: quote.routeId,
    },
  };
}
