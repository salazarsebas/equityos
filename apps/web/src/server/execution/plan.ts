import "server-only";
import type { PriceStatus } from "@equityos/core";
import { type Address, encodeAbiParameters, encodeFunctionData, type Hex, keccak256, parseAbi } from "viem";
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
import { EXECUTION_CHAIN_ID, type QuoteProvider, type QuoteRequest } from "./provider";
import { readPreTrade } from "./reads";
import { type ExecutableQuote, KYBERSWAP_ROUTER, verifyQuote } from "./router";
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
 * Default deviation band, 100 bps. A current reference price can trail its market by up to 50 bps (the feed
 * publishes on a 0.5% move), and a small swap pays a pool fee and some price impact on top. Weekend gaps of
 * about 60 bps were observed between pools and a frozen feed; a closed market is blocked by the freshness
 * check instead of being covered by a wider band.
 */
export const DEFAULT_MAX_DEVIATION_BPS = 100;
/** Largest deviation band accepted, 500 bps. */
export const MAX_DEVIATION_BPS = 500;
/** A multiplier update that takes effect within this many seconds blocks the legs of its token: 24 hours. */
export const MULTIPLIER_WINDOW_SECONDS = 86_400;
/** The plan must be quoted again this many seconds after its first quote. */
export const PLAN_TTL_SECONDS = 60;
/** Deadline passed to the provider, seconds after quoting: time for several confirmations in a wallet. */
export const QUOTE_DEADLINE_SECONDS = 300;
/** Most legs one plan quotes: two provider requests each, against a keyless limit of 10 per 10 seconds. */
export const MAX_EXECUTION_LEGS = 10;

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
}

export interface QuotedLeg {
  readonly quote: ExecutableQuote;
  /** Unix seconds when the provider answered. */
  readonly quotedAt: number;
  readonly deviationBps: number;
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
  readonly approvals: readonly Approval[];
  /** Ready only: approvals, then sells, then buys. */
  readonly calls: readonly PlannedCall[] | null;
  readonly totals: ExecutionTotals | null;
  readonly planHash: Hex | null;
  readonly simulationMethod: SimulationOutcome["method"] | null;
  readonly checkedAtBlock: { readonly number: bigint; readonly timestamp: number } | null;
  readonly expiresAt: number | null;
}

/** Domain tag of the plan hash encoding, versioned with it. */
export const PLAN_HASH_DOMAIN = "equityos.execution-plan/1";

/**
 * keccak256 of `abi.encode(PLAN_HASH_DOMAIN, chainId, account, (to, value, data)[])` over the calls in
 * order. A client binds what it shows to what it sends by recomputing it from the calls it is about to send.
 */
export function planHash(
  chainId: number,
  account: Address,
  calls: readonly Pick<PlannedCall, "to" | "value" | "data">[],
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
        {
          type: "tuple[]",
          components: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
          ],
        },
      ],
      [PLAN_HASH_DOMAIN, BigInt(chainId), account, calls.map(({ to, value, data }) => ({ to, value, data }))],
    ),
  );
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
  const skipped = outcome.calls.flatMap((call, index) => (call.status === "not_simulated" ? [index] : []));
  return skipped.length > 0
    ? result("simulation", "not_simulated", "sequence_not_supported", { detail: skipped.join(",") })
    : result("simulation", "warn", "calls_simulated_alone");
}

/**
 * Turns a reference-price plan into an executable plan for `account` on Base mainnet: quotes each leg,
 * verifies the calldata, reads the token state at one block, runs every pre-trade check and simulates the
 * calls. Nothing is signed or sent. Stages run in order and a stage runs only when the earlier ones let it:
 * the jurisdiction gate, then the reference plan and its freshness, then quotes, reads and simulation.
 *
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

  const deadline = deps.now() + QUOTE_DEADLINE_SECONDS;
  const quotes: (QuotedLeg | null)[] = [];
  for (const [index, leg] of legs.entries()) {
    const request: QuoteRequest = {
      tokenIn: leg.tokenIn,
      tokenOut: leg.tokenOut,
      amountIn: leg.amountIn,
      account,
      slippageBps: input.slippageBps,
      deadline,
    };
    const answer = await deps.provider.quote(request);
    const verified = answer.status === "ok" ? verifyQuote(request, answer.quote) : answer;
    if (verified.status !== "ok") {
      checks.push(result("quote", "block", verified.reason, { token: leg.token, leg: index, detail: verified.detail }));
      quotes.push(null);
      continue;
    }
    const { quote } = verified;
    const [usdc, tokens] =
      leg.side === "sell" ? [quote.quotedAmountOut, leg.amountIn] : [leg.amountIn, quote.quotedAmountOut];
    const deviation = deviationBps(usdc, tokens, leg.decimals, leg.priceE8);
    checks.push(result("quote", "pass", "verified", { token: leg.token, leg: index, detail: quote.routeId }));
    checks.push(deviationCheck(deviation, input.maxDeviationBps, leg.token, index));
    quotes.push({ quote, quotedAt: deps.now(), deviationBps: reportedDeviation(deviation) });
  }
  legs = legs.map((leg, index) => ({ ...leg, quoted: quotes[index] ?? null }));

  const tokens = [USDC_ADDRESS, ...new Set(legs.map((leg) => leg.token))];
  const read = await readPreTrade(deps.client, account, KYBERSWAP_ROUTER, tokens);
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
  const spentTokens = [...new Set(legs.map((leg) => leg.tokenIn))];
  for (const token of spentTokens) checks.push(allowanceCheck(state(token)?.allowance ?? null, token));
  const approvals = requiredApprovals(legs, (token) => state(token)?.allowance ?? 0n, KYBERSWAP_ROUTER);
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
  checks.push(simulationCheck(simulation, calls));

  const expiresAt = Math.min(...quoted.map(({ quotedAt }) => quotedAt)) + PLAN_TTL_SECONDS;
  const expired = deps.now() >= expiresAt;
  checks.push(
    result("plan_expiry", expired ? "block" : "pass", expired ? "expired" : "current", { detail: String(expiresAt) }),
  );
  return finish({
    approvals,
    calls,
    totals: executionTotals(legs, quoted, (token) => balanceOf(token) ?? 0n),
    planHash: planHash(EXECUTION_CHAIN_ID, account, calls),
    simulationMethod: simulation.method,
    checkedAtBlock,
    expiresAt,
  });
}
