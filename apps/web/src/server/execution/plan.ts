import "server-only";
import type { PriceStatus } from "@equityos/core";
import { type Address, encodeFunctionData, type Hex, parseAbi } from "viem";
import { type ExecutableQuote, KYBERSWAP_ROUTER, planHash, verifyQuote } from "@/lib/execution/calldata";
import type { Jurisdiction } from "@/server/jurisdiction";
import { USDC_ADDRESS } from "@/server/market";
import {
  type Approval,
  allowanceCheck,
  approvalFor,
  balanceCheck,
  type CheckResult,
  deviationBps,
  deviationCheck,
  freshnessCheck,
  jurisdictionCheck,
  multiplierCheck,
  pauseCheck,
  policyCheck,
  reportedDeviation,
  result,
  verdict,
} from "./checks";
import { EXECUTION_CHAIN_ID, type QuoteFailure, type QuoteProvider, type QuoteRequest } from "./provider";
import { readPreTrade } from "./reads";
import { type ExecutionClient, type PlannedCall, type SimulationOutcome, simulateSequence } from "./simulate";

/**
 * Default slippage tolerance, 50 bps: the default reserve of a plan. Buys are sized to spend at most the
 * available USDC plus the reference proceeds of the sells less the reserve, so when executable prices are
 * near the reference, sells whose minimum is 50 bps under their quote still fund the buys.
 */
export const DEFAULT_SLIPPAGE_BPS = 50;
/** Largest slippage tolerance accepted, 200 bps. Together with the deviation band it bounds the loss a minimum allows. */
export const MAX_SLIPPAGE_BPS = 200;
/**
 * Default deviation band, 150 bps, applied to the quoted price and to the minimum-out price alike, so it bounds
 * the worst outcome a plan accepts. It is 100 bps of quote deviation (a current reference can trail its market
 * by up to 50 bps, since the feed publishes on a 0.5% move, plus a pool fee and some price impact) and the
 * default 50 bps of slippage. A closed market is blocked by the freshness check instead of a wider band.
 */
export const DEFAULT_MAX_DEVIATION_BPS = 150;
/** Largest deviation band accepted, 500 bps. */
export const MAX_DEVIATION_BPS = 500;
/** A multiplier update that takes effect within this many seconds blocks the legs of its token: 24 hours. */
export const MULTIPLIER_WINDOW_SECONDS = 86_400;
/**
 * Lifetime of a plan from its first quote, 120 seconds: time to review it and confirm an approval and a few
 * swaps in a wallet. It is also the deadline asked of the provider, so a swap sent later reverts onchain.
 */
export const PLAN_TTL_SECONDS = 120;
/** A route's deadline may exceed the plan's expiry by at most this many seconds, the clock skew allowed. */
export const DEADLINE_TOLERANCE_SECONDS = 15;
/**
 * Most legs one plan quotes: five. Each takes two provider requests, and the keyless limit is 10 requests per
 * 10 seconds, so a larger plan could not be quoted within one window.
 */
export const MAX_EXECUTION_LEGS = 5;
/** Legs quoted at the same time. The budget is taken before quoting, so concurrency never exceeds it. */
export const QUOTE_CONCURRENCY = 2;

/** The provider's limit, or the deployment's budget of provider requests, does not allow quoting the plan now. */
export class ProviderRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("the quote provider rate limit does not allow quoting the plan now");
    this.name = "ProviderRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The request being served reached its overall deadline. */
export class DeadlineExceededError extends Error {
  constructor() {
    super("the execution plan was not built within the deadline of the request");
    this.name = "DeadlineExceededError";
  }
}

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** One leg of a reference-price plan, as `planRebalance` sized it. */
export interface ExecutionLeg {
  readonly side: "sell" | "buy";
  readonly token: Address;
  readonly decimals: number;
  /** Sell: the exact quantity sold. Buy: the quantity at the reference price, for information. */
  readonly tokenQuantity: bigint;
  /** Buy: the exact USDC spent. Sell: the proceeds at the reference price, for information. */
  readonly quoteAmount: bigint;
  readonly priceE8: bigint;
  readonly priceStatus: PriceStatus;
}

export type ReferenceOutcome =
  | { readonly status: "ready"; readonly legs: readonly ExecutionLeg[] }
  | { readonly status: "blocked"; readonly codes: readonly string[] };

export interface ExecutionPlanInput {
  readonly account: Address;
  readonly reference: ReferenceOutcome;
  readonly jurisdiction: Jurisdiction;
  readonly slippageBps: number;
  readonly maxDeviationBps: number;
  readonly allowUnsimulated: boolean;
}

export interface ExecutionDependencies {
  readonly provider: QuoteProvider;
  readonly client: ExecutionClient;
  /** Clock in Unix seconds. */
  readonly now: () => number;
  /** The deployment's budget of provider requests. */
  readonly providerBudget: {
    take(count: number): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };
  };
  /** Aborted when the request being served reaches its overall deadline. */
  readonly signal: AbortSignal;
}

export interface QuotedLeg {
  readonly quote: ExecutableQuote;
  /** Unix seconds when the provider answered. */
  readonly quotedAt: number;
  /** Deviation of the quoted price from the reference, signed, in bps. */
  readonly deviationBps: number;
  /** Deviation of the minimum-out price from the reference, signed, in bps. */
  readonly minimumDeviationBps: number;
}

export interface LegExecution extends ExecutionLeg {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** Exact amount swapped: the sell quantity, or the USDC a buy spends. */
  readonly amountIn: bigint;
  readonly quoted: QuotedLeg | null;
}

export interface ExecutionTotals {
  readonly usdcBalance: bigint;
  /** Sum of the minimum amounts out of the sells, in USDC base units. */
  readonly minUsdcFromSells: bigint;
  /** Sum of the exact USDC amounts of the buys. */
  readonly maxUsdcForBuys: bigint;
  /** Balances after every call when each swap returns exactly its minimum, USDC first, then by leg. */
  readonly endBalances: readonly { readonly token: Address; readonly before: bigint; readonly after: bigint }[];
}

export interface ExecutionPlan {
  readonly status: "ready" | "blocked";
  /** True only when no check blocks and every check passed or warned. */
  readonly executable: boolean;
  readonly legs: readonly LegExecution[];
  readonly checks: readonly CheckResult[];
  readonly blockedBy: readonly CheckResult[];
  /** Every check that passed with a warning. A client shows each one and asks for an acknowledgement. */
  readonly warnings: readonly CheckResult[];
  readonly approvals: readonly Approval[];
  /** Ready only: approvals, then sells, then buys. */
  readonly calls: readonly PlannedCall[] | null;
  readonly totals: ExecutionTotals | null;
  readonly planHash: Hex | null;
  readonly simulationMethod: SimulationOutcome["method"] | null;
  readonly checkedAtBlock: { readonly number: bigint; readonly timestamp: number } | null;
  readonly expiresAt: number | null;
}

function legView(leg: ExecutionLeg): LegExecution {
  return leg.side === "sell"
    ? { ...leg, tokenIn: leg.token, tokenOut: USDC_ADDRESS, amountIn: leg.tokenQuantity, quoted: null }
    : { ...leg, tokenIn: USDC_ADDRESS, tokenOut: leg.token, amountIn: leg.quoteAmount, quoted: null };
}

function approveCall(approval: Approval): PlannedCall {
  const data = encodeFunctionData({
    abi: approveAbi,
    functionName: "approve",
    args: [approval.spender, approval.amount],
  });
  return { kind: "approve", to: approval.token, data, value: 0n, token: approval.token, leg: null, minAmountOut: null };
}

/** The approvals the swaps need, one per token sold, each for exactly the total swapped of that token. */
export function requiredApprovals(
  legs: readonly LegExecution[],
  allowanceOf: (token: Address) => bigint,
  spender: Address,
): Approval[] {
  const totals = new Map<Address, bigint>();
  for (const leg of legs) totals.set(leg.tokenIn, (totals.get(leg.tokenIn) ?? 0n) + leg.amountIn);
  return [...totals].map(([token, amount]) => approvalFor(token, spender, amount, allowanceOf(token)));
}

/**
 * Funds needed by the plan at the minimum amounts out: each sell is covered by the balance of its token, and
 * the buys by the USDC held plus the minimum the sells return. Quoted amounts are never counted as funds.
 */
export function fundingChecks(
  legs: readonly LegExecution[],
  minimumOut: (leg: number) => bigint,
  balanceOf: (token: Address) => bigint | null,
): CheckResult[] {
  const checks = legs
    .filter((leg) => leg.side === "sell")
    .map((leg) => balanceCheck(balanceOf(leg.token), leg.amountIn, leg.token));
  const buys = legs.filter((leg) => leg.side === "buy");
  if (buys.length === 0) return checks;
  const fromSells = legs.reduce((sum, leg, index) => (leg.side === "sell" ? sum + minimumOut(index) : sum), 0n);
  const held = balanceOf(USDC_ADDRESS);
  const spent = buys.reduce((sum, leg) => sum + leg.amountIn, 0n);
  return [...checks, balanceCheck(held === null ? null : held + fromSells, spent, USDC_ADDRESS)];
}

/** Totals at the minimum amounts out. */
export function executionTotals(
  legs: readonly LegExecution[],
  quotes: readonly QuotedLeg[],
  balanceOf: (token: Address) => bigint,
): ExecutionTotals {
  const usdcBalance = balanceOf(USDC_ADDRESS);
  let minUsdcFromSells = 0n;
  let maxUsdcForBuys = 0n;
  const endBalances = legs.map((leg, index) => {
    const before = balanceOf(leg.token);
    const minimum = quotes[index]?.quote.minAmountOut ?? 0n;
    if (leg.side === "sell") minUsdcFromSells += minimum;
    else maxUsdcForBuys += leg.amountIn;
    return { token: leg.token, before, after: leg.side === "sell" ? before - leg.amountIn : before + minimum };
  });
  const usdcAfter = usdcBalance + minUsdcFromSells - maxUsdcForBuys;
  return {
    usdcBalance,
    minUsdcFromSells,
    maxUsdcForBuys,
    endBalances: [{ token: USDC_ADDRESS, before: usdcBalance, after: usdcAfter }, ...endBalances],
  };
}

function simulationCheck(outcome: SimulationOutcome, calls: readonly PlannedCall[]): CheckResult {
  const failure = outcome.calls.findIndex(
    (call, index) =>
      call.status === "reverted" ||
      (call.status === "success" &&
        call.returnAmount !== null &&
        call.returnAmount < (calls[index]?.minAmountOut ?? 0n)),
  );
  const failed = outcome.calls[failure];
  if (failed !== undefined) {
    const error = failed.status === "reverted" ? failed.error : "below_minimum_out";
    return result("simulation", "block", "call_reverted", { detail: `${failure}:${error}` });
  }
  if (outcome.method === "eth_simulateV1") return result("simulation", "pass", "sequence_simulated");
  // Calls run alone say nothing about the sequence: never a pass, whether or not every call could run.
  const skipped = outcome.calls.flatMap((call, index) => (call.status === "not_simulated" ? [index] : []));
  return skipped.length > 0
    ? result("simulation", "not_simulated", "sequence_not_supported", { detail: skipped.join(",") })
    : result("simulation", "not_simulated", "calls_simulated_alone");
}

/** Runs `work` over `items` with at most `limit` at a time, and returns the results in the order of `items`. */
async function mapBounded<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await work(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Turns a reference-price plan into an executable plan for `account` on Base mainnet: quotes each leg,
 * verifies the calldata, reads the token state at one block, runs every pre-trade check and simulates the
 * calls. Nothing is signed or sent. Stages run in order and a stage runs only when the earlier ones let it:
 * the jurisdiction gate, then the reference plan and its freshness, then quotes, reads and simulation.
 *
 * @throws {ProviderRateLimitedError} if the provider budget or the provider's limit does not allow quoting.
 * @throws {DeadlineExceededError} if `deps.signal` is aborted.
 * @throws {UpstreamError} if Base mainnet does not answer the pre-trade read.
 * @throws {MissingConfigurationError} if the endpoint is not Base mainnet.
 */
export async function buildExecutionPlan(
  deps: ExecutionDependencies,
  input: ExecutionPlanInput,
): Promise<ExecutionPlan> {
  const { account } = input;
  const checks: CheckResult[] = [jurisdictionCheck(input.jurisdiction)];
  let legs: LegExecution[] = [];
  const finish = (extra: Partial<ExecutionPlan> = {}): ExecutionPlan => {
    const { blocking, executable } = verdict(checks, input.allowUnsimulated);
    const ready = blocking.length === 0 && extra.calls !== undefined && extra.calls !== null;
    return {
      status: ready ? "ready" : "blocked",
      executable: ready && executable,
      legs,
      checks,
      blockedBy: blocking,
      warnings: checks.filter(({ status }) => status === "warn"),
      approvals: [],
      calls: null,
      totals: null,
      planHash: null,
      simulationMethod: null,
      checkedAtBlock: null,
      expiresAt: null,
      ...extra,
      ...(ready ? {} : { calls: null, totals: null, planHash: null }),
    };
  };
  const ensureTime = () => {
    if (deps.signal.aborted) throw new DeadlineExceededError();
  };
  if (input.jurisdiction.restricted) return finish();

  const { reference } = input;
  if (reference.status === "blocked") {
    checks.push(result("reference_plan", "block", "plan_blocked", { detail: reference.codes.join(",") }));
    return finish();
  }
  if (reference.legs.length === 0) checks.push(result("reference_plan", "block", "no_legs"));
  else if (reference.legs.length > MAX_EXECUTION_LEGS) {
    checks.push(result("reference_plan", "block", "too_many_legs", { detail: String(reference.legs.length) }));
  } else checks.push(result("reference_plan", "pass", "ready"));
  legs = reference.legs.map(legView);
  for (const [index, leg] of legs.entries()) checks.push(freshnessCheck(leg.priceStatus, leg.token, index));
  if (verdict(checks, input.allowUnsimulated).blocking.length > 0) return finish();

  // The whole plan's provider requests are taken from the budget before the first one is sent.
  const budget = deps.providerBudget.take(legs.length * deps.provider.requestsPerQuote);
  if (!budget.ok) throw new ProviderRateLimitedError(budget.retryAfterSeconds);
  const startedAt = deps.now();
  const deadline = startedAt + PLAN_TTL_SECONDS;
  const context = { signal: deps.signal, takeRetry: () => deps.providerBudget.take(1).ok };
  const answers = await mapBounded(legs, QUOTE_CONCURRENCY, async (leg) => {
    const request: QuoteRequest = {
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      account,
      slippageBps: input.slippageBps,
      deadline,
    };
    const answer = await deps.provider.quote(request, context);
    const verified = answer.status === "ok" ? verifyQuote(request, answer.quote) : answer;
    return { verified, quotedAt: deps.now() };
  });
  ensureTime();
  const limited = answers.find(
    (answer): answer is { verified: QuoteFailure; quotedAt: number } =>
      answer.verified.status === "failed" && answer.verified.reason === "provider_rate_limited",
  );
  if (limited !== undefined) throw new ProviderRateLimitedError(Number(limited.verified.detail ?? "10") || 10);
  const quotes: (QuotedLeg | null)[] = [];
  for (const [index, leg] of legs.entries()) {
    const answer = answers[index];
    if (answer === undefined) throw new Error(`no answer for leg ${index}`);
    const { verified, quotedAt } = answer;
    if (verified.status !== "ok") {
      checks.push(result("quote", "block", verified.reason, { token: leg.token, leg: index, detail: verified.detail }));
      quotes.push(null);
      continue;
    }
    const { quote } = verified;
    // Deviation of the executable price: with the quoted amount, and with the minimum the router enforces.
    const deviationAt = (out: bigint) =>
      leg.side === "sell"
        ? deviationBps(out, leg.amountIn, leg.decimals, leg.priceE8)
        : deviationBps(leg.amountIn, out, leg.decimals, leg.priceE8);
    const quoted = deviationAt(quote.quotedAmountOut);
    const minimum = deviationAt(quote.minAmountOut);
    checks.push(result("quote", "pass", "verified", { token: leg.token, leg: index, detail: quote.routeId }));
    checks.push(deviationCheck(quoted, minimum, input.maxDeviationBps, leg.token, index));
    quotes.push({
      quote,
      quotedAt,
      deviationBps: reportedDeviation(quoted),
      minimumDeviationBps: reportedDeviation(minimum),
    });
  }
  legs = legs.map((leg, index) => ({ ...leg, quoted: quotes[index] ?? null }));

  const tokens = [USDC_ADDRESS, ...new Set(legs.map((leg) => leg.token))];
  const read = await readPreTrade(deps.client, account, KYBERSWAP_ROUTER, tokens);
  ensureTime();
  const state = (token: Address) => read.tokens.get(token);
  const observedAt = deps.now();
  for (const token of tokens) {
    const tokenRead = state(token);
    checks.push(pauseCheck(tokenRead?.paused ?? null, token));
    checks.push(policyCheck(tokenRead?.authorization ?? { sender: null, receiver: null, executor: null }, token));
    if (token !== USDC_ADDRESS) {
      const effectiveAt = tokenRead?.multiplierEffectiveAt ?? null;
      checks.push(multiplierCheck(effectiveAt, read.blockTimestamp, observedAt, MULTIPLIER_WINDOW_SECONDS, token));
    }
  }
  const approvals = requiredApprovals(legs, (token) => state(token)?.allowance ?? 0n, KYBERSWAP_ROUTER);
  for (const approval of approvals) {
    checks.push(allowanceCheck(state(approval.token)?.allowance ?? null, approval.amount, approval.token));
  }
  const checkedAtBlock = { number: read.blockNumber, timestamp: read.blockTimestamp };
  const pairs = legs.flatMap((leg, index) => {
    const quotedLeg = quotes[index];
    return quotedLeg === null || quotedLeg === undefined ? [] : [{ leg, index, quoted: quotedLeg }];
  });
  if (pairs.length < legs.length) {
    checks.push(result("balance", "skipped", "quote_unavailable"));
    checks.push(result("simulation", "skipped", "quote_unavailable"));
    return finish({ approvals, checkedAtBlock });
  }
  const quoted = pairs.map((pair) => pair.quoted);
  const balanceOf = (token: Address) => state(token)?.balance ?? null;
  checks.push(...fundingChecks(legs, (index) => quoted[index]?.quote.minAmountOut ?? 0n, balanceOf));

  // Approvals first, then every sell, then every buy: the sells fund the buys.
  const swaps = [...pairs.filter(({ leg }) => leg.side === "sell"), ...pairs.filter(({ leg }) => leg.side === "buy")];
  const calls: PlannedCall[] = [
    ...approvals.filter((approval) => approval.required).map(approveCall),
    ...swaps.map(
      ({ leg, index, quoted: { quote } }): PlannedCall => ({
        kind: "swap",
        to: quote.router,
        data: quote.calldata,
        value: quote.value,
        token: leg.tokenIn,
        leg: index,
        minAmountOut: quote.minAmountOut,
      }),
    ),
  ];
  // Alone, a call can run only on the state of the block: its approval in place and its input already held.
  const simulableAlone = new Set(
    calls.flatMap((call, index) => {
      if (call.kind === "approve") return [index];
      const amount = legs[call.leg ?? -1]?.amountIn ?? 0n;
      const tokenRead = state(call.token);
      const ready = (tokenRead?.allowance ?? 0n) >= amount && (tokenRead?.balance ?? 0n) >= amount;
      return ready ? [index] : [];
    }),
  );
  const simulation = await simulateSequence(deps.client, account, read.blockNumber, calls, simulableAlone);
  ensureTime();
  checks.push(simulationCheck(simulation, calls));

  // The plan expires with its first quote's lifetime, or with the earliest route deadline when that is sooner.
  // A route whose deadline runs past the plan's expiry would let a stale swap execute: it blocks.
  const lifetime = Math.min(...quoted.map(({ quotedAt }) => quotedAt)) + PLAN_TTL_SECONDS;
  const late = quoted.findIndex(({ quote }) => quote.deadline > lifetime + DEADLINE_TOLERANCE_SECONDS);
  const expiresAt = Math.min(lifetime, ...quoted.map(({ quote }) => quote.deadline));
  const now = deps.now();
  if (late >= 0) {
    checks.push(
      result("plan_expiry", "block", "deadline_after_expiry", {
        leg: pairs[late]?.index ?? late,
        detail: String(quoted[late]?.quote.deadline),
      }),
    );
  } else {
    const expired = now >= expiresAt;
    checks.push(
      result("plan_expiry", expired ? "block" : "pass", expired ? "expired" : "current", {
        detail: String(expiresAt),
      }),
    );
  }
  return finish({
    approvals,
    calls,
    totals: executionTotals(legs, quoted, (token) => balanceOf(token) ?? 0n),
    planHash: planHash(EXECUTION_CHAIN_ID, account, expiresAt, calls),
    simulationMethod: simulation.method,
    checkedAtBlock,
    expiresAt,
  });
}
