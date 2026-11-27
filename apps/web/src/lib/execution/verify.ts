/**
 * Verification of an execution plan in the browser, before anything of it may be sent. Pure: the inputs are the
 * parsed answer of the server, the connected account and the network this build accepts for the plan's chain.
 *
 * This is the trust boundary of execution. The server already verified every quote, but the browser does not
 * take its word for it: every call is decoded and checked again here, against the plan's legs and the
 * account that will sign, with the same module the server uses (`calldata.ts`). The plan hash is recomputed
 * from the calls as received and compared with the server's. What the review shows is what this module
 * decoded, never a field of the JSON next to the calldata.
 */
import { type Address, type Hex, isAddressEqual } from "viem";
import {
  isExactApproval,
  PLAN_DEFAULT_MAX_DEVIATION_BPS,
  PLAN_DEFAULT_SLIPPAGE_BPS,
  PLAN_LIFETIME_SECONDS,
  type ProviderQuote,
  planHash,
  type QuoteFailureReason,
  type QuoteRequest,
  ROUTE_DEADLINE_TOLERANCE_SECONDS,
  verifyQuote,
} from "./calldata";
import { type ChainReads, checkMarket, type LegMarket } from "./market";
import type { ExecutionNetwork } from "./networks";
import type { ExecutionPlanView, PlanLeg } from "./response";

/** Why a plan is refused. Each failure names the call and the leg it concerns when there is one. */
export type VerificationFailureCode =
  /** The plan is not `ready` and `executable`, or lacks its calls, totals, hash or expiry. */
  | "not_ready"
  /** No check may block, be skipped or be unsimulated in a plan that is sent. */
  | "check_not_passed"
  /**
   * The plan was built with another slippage tolerance or deviation band than the defaults the page requests,
   * the parameters the browser's price bound is derived from. `detail` names them.
   */
  | "parameters_mismatch"
  /** This build does not send plans on the plan's chain. */
  | "unsupported_chain"
  /** The plan was built for another address than the connected account. */
  | "account_mismatch"
  /** The plan names another router than the one pinned for its chain. */
  | "router_mismatch"
  /** A leg does not swap its token against USDC in its direction, is not a constituent, or has no quote. */
  | "leg_invalid"
  /** The calls are not the approvals, then one swap per sell, then one swap per buy, in leg order. */
  | "call_order"
  /** An approval is not exactly `approve(router, total swapped of the token)` on the token, without value. */
  | "approval_not_exact"
  /** The swap calldata does not verify against its leg and the account. `detail` is the reason. */
  | "swap_not_verified"
  /** The decoded minimum or deadline differs from what the answer reports for the leg or the call. */
  | "swap_mismatch"
  /**
   * The plan expires later than a plan's lifetime, plus the deadline tolerance, after the block the browser read
   * the chain at: its quotes and the price bound would be relied on for longer than they are checked for.
   */
  | "expiry_out_of_range"
  /** A route deadline is before the plan's expiry, or more than the tolerance after it. */
  | "deadline_out_of_range"
  /** The totals of the answer differ from the totals recomputed from the decoded calls. */
  | "totals_mismatch"
  /** The plan names another index id or version than the comparison on the page. */
  | "index_mismatch"
  /** `decimals()` read on the chain differs from the plan's, or could not be read. `detail` is the token. */
  | "decimals_mismatch"
  /** The browser has no usable reference price for a leg: no feed, a failed read, or a stale or closed one. */
  | "reference_unusable"
  /** A leg's minimum out is further from the browser's reference price than the bound allows. `detail` in bps. */
  | "price_out_of_bounds";

export interface VerificationFailure {
  readonly code: VerificationFailureCode;
  /** Index of the call in the plan, or `null`. */
  readonly call: number | null;
  /** Index of the leg in the plan, or `null`. */
  readonly leg: number | null;
  /** Machine-readable context, such as the reason of a calldata failure or the field that differs. */
  readonly detail: string | null;
}

export interface VerifiedApproval {
  readonly kind: "approve";
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
}

export interface VerifiedSwap {
  readonly kind: "swap";
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly leg: number;
  readonly side: "sell" | "buy";
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  /** Decoded from the calldata: the router enforces it. */
  readonly minAmountOut: bigint;
  /** The provider's estimate, not guaranteed. */
  readonly quotedAmountOut: bigint;
  /** Decoded from the executor data, Unix seconds. */
  readonly deadline: number;
}

export type VerifiedCall = VerifiedApproval | VerifiedSwap;

export interface VerifiedTotals {
  readonly usdcBefore: bigint;
  /** Sum of the decoded minimum amounts out of the sells. */
  readonly minUsdcFromSells: bigint;
  /** Sum of the exact USDC amounts the buys spend. */
  readonly maxUsdcForBuys: bigint;
  /** USDC first, then by leg: the balance the server read, and the balance after when every swap returns its minimum. */
  readonly endBalances: readonly {
    readonly token: Address;
    readonly before: bigint;
    readonly afterAtMinimum: bigint;
  }[];
}

export type PlanVerification =
  | {
      readonly ok: true;
      readonly calls: readonly VerifiedCall[];
      readonly totals: VerifiedTotals;
      readonly expiresAt: number;
      /** The hash recomputed here from the calls as received. */
      readonly localPlanHash: Hex;
      /** Whether it equals the server's `planHash`. A mismatch is a refusal of its own. */
      readonly hashMatches: boolean;
      /** Per leg, the reference price the browser read and the minimum's deviation from it. */
      readonly market: readonly LegMarket[];
    }
  | { readonly ok: false; readonly failures: readonly VerificationFailure[] };

export interface VerificationContext {
  /** The connected account that will sign every call. */
  readonly account: Address;
  /** The network this build accepts for the plan's chain, or `null` when it accepts none. */
  readonly network: ExecutionNetwork | null;
  /** The constituents of the compared index version: no leg may trade anything else. */
  readonly constituents: readonly Address[];
  /** The index id and version of the comparison on the page: the plan must name the same. */
  readonly index: { readonly indexId: Hex; readonly version: number };
  /** Decimals and reference feeds read by the browser on the plan's chain. */
  readonly market: ChainReads;
}

function failure(
  code: VerificationFailureCode,
  scope: { call?: number; leg?: number; detail?: string } = {},
): VerificationFailure {
  return { code, call: scope.call ?? null, leg: scope.leg ?? null, detail: scope.detail ?? null };
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The legs in the order their swaps must appear: every sell, then every buy, each in leg order. */
function swapOrder(legs: readonly PlanLeg[]): number[] {
  const indexes = legs.map((_, index) => index);
  return [
    ...indexes.filter((index) => legs[index]?.side === "sell"),
    ...indexes.filter((index) => legs[index]?.side === "buy"),
  ];
}

function legFailures(plan: ExecutionPlanView, network: ExecutionNetwork, constituents: readonly Address[]) {
  const failures: VerificationFailure[] = [];
  const seen = new Set<string>();
  for (const [index, leg] of plan.legs.entries()) {
    const pairOk =
      leg.side === "sell"
        ? same(leg.tokenIn, leg.token) && same(leg.tokenOut, network.usdc)
        : same(leg.tokenIn, network.usdc) && same(leg.tokenOut, leg.token);
    const fields = [
      !pairOk && "pair",
      !constituents.some((token) => same(token, leg.token)) && "not_constituent",
      seen.has(leg.token) && "duplicate",
      leg.quote === null && "no_quote",
      leg.amountIn === 0n && "amount",
      leg.quote !== null && !same(leg.quote.router, network.router) && "router",
    ].filter((field): field is string => field !== false);
    seen.add(leg.token);
    if (fields.length > 0) failures.push(failure("leg_invalid", { leg: index, detail: fields.join(",") }));
  }
  return failures;
}

/**
 * Verifies a plan for sending from `context.account`. Returns every failure found, not only the first, so that
 * the review can state them all.
 */
export function verifyExecutionPlan(plan: ExecutionPlanView, context: VerificationContext): PlanVerification {
  const { account, network } = context;
  const failures: VerificationFailure[] = [];
  const refuse = (...found: VerificationFailure[]): PlanVerification => ({ ok: false, failures: found });

  const { calls, totals, expiresAt, planHash: serverHash } = plan;
  if (
    plan.status !== "ready" ||
    !plan.executable ||
    calls === null ||
    totals === null ||
    expiresAt === null ||
    serverHash === null
  ) {
    return refuse(failure("not_ready"));
  }
  const unsettled = [...plan.checks, ...plan.blockedBy].filter(({ status }) => status !== "pass" && status !== "warn");
  if (plan.blockedBy.length > 0 || unsettled.length > 0) {
    return refuse(
      ...unsettled.map((check) => failure("check_not_passed", { detail: `${check.check}:${check.status}` })),
    );
  }
  const parameters = [
    plan.slippageBps !== PLAN_DEFAULT_SLIPPAGE_BPS && "slippageBps",
    plan.maxDeviationBps !== PLAN_DEFAULT_MAX_DEVIATION_BPS && "maxDeviationBps",
  ].filter((field): field is string => field !== false);
  if (parameters.length > 0) return refuse(failure("parameters_mismatch", { detail: parameters.join(",") }));
  if (network === null) return refuse(failure("unsupported_chain", { detail: String(plan.chainId) }));
  if (!isAddressEqual(plan.address, account)) return refuse(failure("account_mismatch"));
  // The price bound is checked at the browser's reads: a plan that outlives them would be signed on old checks.
  if (expiresAt > context.market.chainTime + PLAN_LIFETIME_SECONDS + ROUTE_DEADLINE_TOLERANCE_SECONDS) {
    return refuse(failure("expiry_out_of_range", { detail: String(expiresAt) }));
  }
  if (
    plan.index.indexId.toLowerCase() !== context.index.indexId.toLowerCase() ||
    plan.index.version !== context.index.version
  ) {
    return refuse(failure("index_mismatch", { detail: `${plan.index.indexId}:${plan.index.version}` }));
  }
  if (!same(plan.providerRouter, network.router)) return refuse(failure("router_mismatch"));

  failures.push(...legFailures(plan, network, context.constituents));
  if (failures.length > 0) return refuse(...failures);

  // The calls must be: approvals, then the swaps in the order of `swapOrder`, one per leg and nothing else.
  const order = swapOrder(plan.legs);
  const approvalCount = calls.length - order.length;
  if (approvalCount < 0) return refuse(failure("call_order", { detail: "too_few_calls" }));
  const totalIn = new Map<string, bigint>();
  for (const leg of plan.legs) totalIn.set(leg.tokenIn, (totalIn.get(leg.tokenIn) ?? 0n) + leg.amountIn);

  const verified: VerifiedCall[] = [];
  const approved = new Set<string>();
  for (const [index, call] of calls.entries()) {
    if (index < approvalCount) {
      const amount = totalIn.get(call.token);
      const exact =
        call.kind === "approve" &&
        call.leg === null &&
        call.minAmountOut === null &&
        amount !== undefined &&
        !approved.has(call.token) &&
        isExactApproval(call, { token: call.token, spender: network.router, amount });
      if (!exact || amount === undefined) {
        failures.push(failure(call.kind === "approve" ? "approval_not_exact" : "call_order", { call: index }));
        continue;
      }
      approved.add(call.token);
      verified.push({
        kind: "approve",
        to: call.to,
        data: call.data,
        value: 0n,
        token: call.token,
        spender: network.router,
        amount,
      });
      continue;
    }
    const legIndex = order[index - approvalCount];
    const leg = legIndex === undefined ? undefined : plan.legs[legIndex];
    if (
      legIndex === undefined ||
      leg === undefined ||
      leg.quote === null ||
      call.kind !== "swap" ||
      call.leg !== legIndex
    ) {
      failures.push(failure("call_order", { call: index, ...(legIndex === undefined ? {} : { leg: legIndex }) }));
      continue;
    }
    if (!same(call.token, leg.tokenIn)) {
      failures.push(failure("swap_mismatch", { call: index, leg: legIndex, detail: "token" }));
      continue;
    }
    const request: QuoteRequest = {
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      account,
      slippageBps: plan.slippageBps,
      // Not read by the verification: the deadline is decoded from the calldata and checked below.
      deadline: expiresAt,
    };
    const quote: ProviderQuote = {
      provider: leg.quote.provider,
      quotedAmountOut: leg.quote.quotedAmountOut,
      amountIn: leg.amountIn,
      router: call.to,
      calldata: call.data,
      value: call.value,
      gasEstimate: leg.quote.gasEstimate,
      routeId: leg.quote.routeId,
    };
    const outcome = verifyQuote(request, quote);
    if (outcome.status !== "ok") {
      const reason: QuoteFailureReason = outcome.reason;
      const detail = outcome.detail === null ? reason : `${reason}:${outcome.detail}`;
      failures.push(failure("swap_not_verified", { call: index, leg: legIndex, detail }));
      continue;
    }
    const decoded = outcome.quote;
    const mismatched = [
      decoded.minAmountOut !== leg.quote.minAmountOut && "minAmountOut",
      call.minAmountOut !== decoded.minAmountOut && "callMinAmountOut",
      decoded.deadline !== leg.quote.deadline && "deadline",
    ].filter((field): field is string => field !== false);
    if (mismatched.length > 0) {
      failures.push(failure("swap_mismatch", { call: index, leg: legIndex, detail: mismatched.join(",") }));
      continue;
    }
    if (decoded.deadline < expiresAt || decoded.deadline > expiresAt + ROUTE_DEADLINE_TOLERANCE_SECONDS) {
      failures.push(failure("deadline_out_of_range", { call: index, leg: legIndex, detail: String(decoded.deadline) }));
      continue;
    }
    verified.push({
      kind: "swap",
      to: call.to,
      data: call.data,
      value: 0n,
      leg: legIndex,
      side: leg.side,
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      minAmountOut: decoded.minAmountOut,
      quotedAmountOut: decoded.quotedAmountOut,
      deadline: decoded.deadline,
    });
  }
  if (failures.length > 0) return refuse(...failures);

  const recomputed = recomputeTotals(plan, verified, network.usdc);
  if (recomputed.mismatch !== null) return refuse(failure("totals_mismatch", { detail: recomputed.mismatch }));
  const swaps = verified.filter((call): call is VerifiedSwap => call.kind === "swap");
  const market = checkMarket(plan, swaps, context.market, network.usdc);
  if (market.failures.length > 0) return refuse(...market.failures);

  const localPlanHash = planHash(plan.chainId, plan.address, expiresAt, calls);
  return {
    ok: true,
    calls: verified,
    totals: recomputed.totals,
    expiresAt,
    localPlanHash,
    hashMatches: localPlanHash === serverHash.toLowerCase(),
    market: market.legs,
  };
}

/**
 * The totals at the minimum amounts out, recomputed from the decoded swaps and the balances the server read,
 * compared with the answer's. The answer cannot carry a negative balance after the calls (it does not parse),
 * so totals that match also mean that every balance covers what the calls spend.
 */
function recomputeTotals(
  plan: ExecutionPlanView,
  calls: readonly VerifiedCall[],
  usdc: Address,
): { totals: VerifiedTotals; mismatch: string | null } {
  const reported = plan.totals;
  const swaps = calls.filter((call): call is VerifiedSwap => call.kind === "swap");
  const minUsdcFromSells = swaps.reduce((sum, swap) => (swap.side === "sell" ? sum + swap.minAmountOut : sum), 0n);
  const maxUsdcForBuys = swaps.reduce((sum, swap) => (swap.side === "buy" ? sum + swap.amountIn : sum), 0n);
  const beforeOf = (token: Address) =>
    reported?.endBalances.find((balance) => same(balance.token, token))?.before ?? null;
  const usdcBefore = reported?.usdcBalance ?? 0n;
  const usdcAfter = usdcBefore + minUsdcFromSells - maxUsdcForBuys;
  const legBalances = plan.legs.map((leg, index) => {
    const before = beforeOf(leg.token) ?? 0n;
    const swap = swaps.find((entry) => entry.leg === index);
    const minimum = swap?.minAmountOut ?? 0n;
    return { token: leg.token, before, afterAtMinimum: leg.side === "sell" ? before - leg.amountIn : before + minimum };
  });
  const totals: VerifiedTotals = {
    usdcBefore,
    minUsdcFromSells,
    maxUsdcForBuys,
    endBalances: [{ token: usdc, before: usdcBefore, afterAtMinimum: usdcAfter }, ...legBalances],
  };
  const fields = [
    reported === null && "totals",
    reported !== null && reported.minUsdcFromSells !== minUsdcFromSells && "minUsdcFromSells",
    reported !== null && reported.maxUsdcForBuys !== maxUsdcForBuys && "maxUsdcForBuys",
    reported !== null && reported.endBalances.length !== totals.endBalances.length && "endBalances",
    reported !== null &&
      totals.endBalances.some((balance, index) => {
        const entry = reported.endBalances[index];
        return (
          entry === undefined ||
          !same(entry.token, balance.token) ||
          entry.before !== balance.before ||
          entry.after !== balance.afterAtMinimum
        );
      }) &&
      "endBalances",
  ].filter((field): field is string => field !== false);
  const mismatch = fields.length === 0 ? null : [...new Set(fields)].join(",");
  return { totals, mismatch };
}
