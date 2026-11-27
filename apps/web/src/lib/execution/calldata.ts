/**
 * Verification of swap calldata from a quote provider, and the hash that binds a plan's calls. Pure and
 * browser-safe: no network, no clock, no server import. The server runs it on every quote before an execution
 * plan is built, and a client that sends a plan runs it again on the calls it is about to send.
 *
 * Every rule here is an allowlist of what was observed in the provider's answers for Base: one router, one
 * function, one executor, one value of `flags`, one layout of the executor data. Anything else is refused with a
 * typed reason, so a change at the provider blocks execution until it is reviewed.
 */

import { mulDivDown } from "@equityos/core";
import {
  type Address,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  parseAbi,
  toFunctionSelector,
} from "viem";

/** Chain id of Base mainnet, the only chain execution plans are built for. */
export const EXECUTION_CHAIN_ID = 8453;

/**
 * A route's deadline may exceed the plan's expiry by at most this many seconds, the clock skew allowed. The
 * server blocks a plan with a later deadline, and a client that sends a plan refuses one.
 */
export const ROUTE_DEADLINE_TOLERANCE_SECONDS = 15;

/**
 * Lifetime of an execution plan from its first quote, in seconds. The server never sets a later expiry, and a
 * client that sends a plan refuses one that expires later than this, plus the deadline tolerance, after the
 * block it read the chain at.
 */
export const PLAN_LIFETIME_SECONDS = 120;

/** Default slippage tolerance of a plan, in basis points. The server documents why. */
export const PLAN_DEFAULT_SLIPPAGE_BPS = 50;
/** Default deviation band of a plan, in basis points, applied to the quoted and to the minimum-out price. */
export const PLAN_DEFAULT_MAX_DEVIATION_BPS = 150;

/**
 * KyberSwap `MetaAggregationRouterV2` on Base mainnet, lowercase. Listed for chain 8453 in the KyberSwap
 * contract documentation, returned as `routerAddress` by the aggregator API for Base, verified on Sourcify for
 * chain 8453 (solc 0.8.9) and answering `WETH()` with the Base WETH predeploy. Calldata addressed to any other
 * contract is refused, including the newer router the provider also lists on Base.
 */
export const KYBERSWAP_ROUTER: Address = "0x6131b5fae19ea4f9d964eac0408e4408b66337b5";

/**
 * KyberSwap `AggregationExecutorProxy` on Base mainnet, lowercase: listed for chain 8453 in the KyberSwap
 * contract documentation, deployed (it has code), and the `callTarget` and only `srcReceivers` of every answer
 * recorded. The router sends the user's tokens to it and calls it with the executor data.
 */
export const KYBERSWAP_EXECUTOR: Address = "0x8f10b468b06c6fd214b65f87778827f7d113f996";

/**
 * The swap function of the router, as in its verified source. `SwapDescriptionV2` names the tokens, the amount
 * pulled from the sender, the receiver and the minimum amount out that the router enforces onchain. The two
 * other swap functions of the router (`swapGeneric`, `swapSimpleMode`) were never returned for Base and are
 * refused like any other selector.
 */
export const kyberswapRouterAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);

/** `swap`, `0xe21fd0e9`: the only selector accepted. */
export const SWAP_SELECTOR: Hex = toFunctionSelector(kyberswapRouterAbi[0]);

/**
 * Values of `flags` accepted: `0x200`, the only value in every answer recorded for Base. It is not one of the
 * flags the router's source names, so it changes nothing in the swap path the source shows. Any other value,
 * including the partial fill, extra ETH and simple swap flags, is refused.
 */
export const ALLOWED_FLAGS: ReadonlySet<bigint> = new Set([0x200n]);

/**
 * The first 20 bytes of every executor data recorded: the executor selector `0xd7a5c6b5` and a constant
 * 16-byte prefix. The executor's source is not published, so its layout is known only from the answers: after
 * this header come 32-byte words, the 9th of which is the recipient and the 17th the deadline. An answer
 * whose executor data does not start with this header is refused.
 */
export const EXECUTOR_DATA_HEADER: Hex = "0xd7a5c6b52756e795f680b0f7e0c2f21281dde6ef";
const EXECUTOR_RECIPIENT_WORD = 8;
const EXECUTOR_DEADLINE_WORD = 16;

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** One exact-input swap to quote. Amounts are base units of the token they are in. */
export interface QuoteRequest {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Exact amount of `tokenIn` to swap. */
  readonly amountIn: bigint;
  /** The account that sends `tokenIn` and receives `tokenOut`. */
  readonly account: Address;
  /** Tolerance the provider applies to its quoted amount to derive the minimum amount out, in basis points. */
  readonly slippageBps: number;
  /** Unix seconds. Asked of the provider as the time after which its route must not execute. */
  readonly deadline: number;
}

/** What a provider answered, before any verification. Nothing in it is trusted. */
export interface ProviderQuote {
  readonly provider: string;
  /** Amount out the provider quotes, base units of `tokenOut`. */
  readonly quotedAmountOut: bigint;
  /** Amount in the provider says the calldata swaps. Checked against the request. */
  readonly amountIn: bigint;
  /** Contract the calldata is addressed to. Checked against the router allowlist. */
  readonly router: Address;
  readonly calldata: Hex;
  /** Native value to send with the call, in wei. */
  readonly value: bigint;
  /** Gas the provider estimates for the swap. An estimate of the provider, never verified. */
  readonly gasEstimate: bigint;
  /** Identifier of the route at the provider, for support requests. */
  readonly routeId: string;
}

/**
 * Why there is no executable quote. Expected states, returned as data:
 * - `no_route`: the provider found no route for the pair and amount.
 * - `provider_rejected`: the provider refused the request (a 4xx other than rate limiting).
 * - `provider_rate_limited`: the provider answered 429, or the deployment's own budget of provider requests is
 *   spent. `detail` is the number of seconds to wait.
 * - `provider_unavailable`: transport failure, timeout or 5xx, after the one retry.
 * - `provider_malformed`: the answer does not have the documented shape.
 * - `router_not_allowed`: the calldata is addressed to a contract other than the allowlisted router.
 * - `unknown_selector`: the calldata calls a function other than `swap`.
 * - `executor_not_allowed`: the router would hand the tokens to, or call, a contract other than the executor.
 * - `flags_not_allowed`: `flags` is not a value in the allowlist.
 * - `executor_data_unrecognized`: the executor data does not have the recorded layout.
 * - `calldata_mismatch`: the decoded calldata does not swap what was requested, for whom it was requested, with
 *   a minimum at least the one recomputed here, or is not exactly the encoding of what it decodes to.
 */
export type QuoteFailureReason =
  | "no_route"
  | "provider_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_malformed"
  | "router_not_allowed"
  | "unknown_selector"
  | "executor_not_allowed"
  | "flags_not_allowed"
  | "executor_data_unrecognized"
  | "calldata_mismatch";

export interface QuoteFailure {
  readonly status: "failed";
  readonly reason: QuoteFailureReason;
  /** Machine-readable context: the provider error code, or the fields that did not verify. */
  readonly detail: string | null;
}

/** A provider quote whose calldata was decoded and checked against the request. */
export interface ExecutableQuote {
  readonly provider: string;
  readonly router: Address;
  readonly calldata: Hex;
  readonly value: bigint;
  readonly functionName: "swap";
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  /** The minimum the router enforces, decoded from the calldata. */
  readonly minAmountOut: bigint;
  /** Unix seconds after which the route does not execute, decoded from the executor data. */
  readonly deadline: number;
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

function failed(reason: QuoteFailureReason, detail: string): QuoteFailure {
  return { status: "failed", reason, detail };
}

/** The 32-byte word `index` after the executor data header, or `null` when the data is shorter. */
function executorWord(data: Hex, index: number): bigint | null {
  const start = EXECUTOR_DATA_HEADER.length + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 64 ? BigInt(`0x${word}`) : null;
}

/**
 * Verifies a provider quote before anything else may use it. The calldata is accepted only when it is addressed
 * to the allowlisted router, calls `swap` and is exactly the encoding of what it decodes to, sends no native
 * value, hands the tokens to the allowlisted executor with no approval target, carries an allowed `flags`
 * value, swaps exactly `amountIn` of `tokenIn` for `tokenOut` delivered to the account with no fee, no permit
 * and a minimum at least the one recomputed from the quote, and its executor data has the recorded layout with
 * the same recipient and a readable deadline.
 */
export function verifyQuote(
  request: QuoteRequest,
  quote: ProviderQuote,
): { readonly status: "ok"; readonly quote: ExecutableQuote } | QuoteFailure {
  if (!same(quote.router, KYBERSWAP_ROUTER)) return failed("router_not_allowed", quote.router.toLowerCase());
  const selector = quote.calldata.slice(0, 10).toLowerCase();
  if (selector !== SWAP_SELECTOR) return failed("unknown_selector", selector);
  let execution: ReturnType<typeof decodeFunctionData<typeof kyberswapRouterAbi>>["args"][0];
  try {
    const decoded = decodeFunctionData({ abi: kyberswapRouterAbi, data: quote.calldata });
    // Trailing bytes and non-canonical encodings decode too: the calldata must be exactly its own encoding.
    if (
      !same(encodeFunctionData({ abi: kyberswapRouterAbi, functionName: "swap", args: decoded.args }), quote.calldata)
    ) {
      return failed("calldata_mismatch", "encoding");
    }
    execution = decoded.args[0];
  } catch {
    return failed("calldata_mismatch", "undecodable");
  }
  const { desc } = execution;
  if (
    !same(execution.callTarget, KYBERSWAP_EXECUTOR) ||
    !same(execution.approveTarget, ZERO_ADDRESS) ||
    desc.srcReceivers.length !== 1 ||
    !desc.srcReceivers.every((receiver) => same(receiver, KYBERSWAP_EXECUTOR))
  ) {
    return failed("executor_not_allowed", execution.callTarget.toLowerCase());
  }
  if (!ALLOWED_FLAGS.has(desc.flags)) return failed("flags_not_allowed", desc.flags.toString());
  const targetData = execution.targetData.toLowerCase() as Hex;
  const recipient = executorWord(targetData, EXECUTOR_RECIPIENT_WORD);
  const deadline = executorWord(targetData, EXECUTOR_DEADLINE_WORD);
  if (
    !targetData.startsWith(EXECUTOR_DATA_HEADER) ||
    recipient === null ||
    deadline === null ||
    deadline > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return failed("executor_data_unrecognized", "layout");
  }
  const floor = minimumAmountOut(quote.quotedAmountOut, request.slippageBps);
  const sumIn = desc.srcAmounts.reduce((sum, amount) => sum + amount, 0n);
  const mismatches = [
    quote.value !== 0n && "value",
    quote.amountIn !== request.amountIn && "amountIn",
    quote.quotedAmountOut <= 0n && "quotedAmountOut",
    !same(desc.srcToken, request.tokenIn) && "srcToken",
    !same(desc.dstToken, request.tokenOut) && "dstToken",
    desc.amount !== request.amountIn && "amount",
    (desc.srcAmounts.length !== 1 || sumIn !== request.amountIn) && "srcAmounts",
    (desc.feeReceivers.length > 0 || desc.feeAmounts.length > 0) && "fee",
    !same(desc.dstReceiver, request.account) && "dstReceiver",
    recipient !== BigInt(request.account) && "executorRecipient",
    desc.permit !== "0x" && "permit",
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
      functionName: "swap",
      amountIn: request.amountIn,
      quotedAmountOut: quote.quotedAmountOut,
      minAmountOut: desc.minReturnAmount,
      deadline: Number(deadline),
      gasEstimate: quote.gasEstimate,
      routeId: quote.routeId,
    },
  };
}

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/**
 * Whether a call is exactly `approve(spender, amount)` on `token`, with no native value and nothing appended:
 * the only approval an execution plan contains.
 */
export function isExactApproval(
  call: { readonly to: Address; readonly value: bigint; readonly data: Hex },
  expected: { readonly token: Address; readonly spender: Address; readonly amount: bigint },
): boolean {
  const data = encodeFunctionData({
    abi: approveAbi,
    functionName: "approve",
    args: [expected.spender, expected.amount],
  });
  return same(call.to, expected.token) && call.value === 0n && same(call.data, data);
}

/** Domain tag of the plan hash encoding, versioned with it. */
export const PLAN_HASH_DOMAIN = "equityos.execution-plan/1";

/**
 * keccak256 of `abi.encode(PLAN_HASH_DOMAIN, chainId, account, expiresAt, (to, value, data)[])` over the calls
 * in order. A client recomputes it from the calls it is about to send and the expiry it enforces, and sends
 * nothing when it differs from the hash it showed.
 */
export function planHash(
  chainId: number,
  account: Address,
  expiresAt: number,
  calls: readonly { readonly to: Address; readonly value: bigint; readonly data: Hex }[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint64" },
        {
          type: "tuple[]",
          components: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      [
        PLAN_HASH_DOMAIN,
        BigInt(chainId),
        account,
        BigInt(expiresAt),
        calls.map(({ to, value, data }) => ({ to, value, data })),
      ],
    ),
  );
}
