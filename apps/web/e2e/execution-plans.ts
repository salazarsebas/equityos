/**
 * Builds answers of `POST /api/v1/portfolio/execution-plan` for tests, in exactly the shape the server writes,
 * with swap calldata in the layout the calldata verification accepts: the pinned router, executor, flags and
 * executor data header, the account as receiver and recipient, and the route deadline at its word.
 *
 * Used by the unit tests of the client verification and by the browser tests. In the chain suite, a mock
 * router and executor are installed at the pinned addresses of the local node (`e2e-chain/execution-chain.ts`):
 * the executor reads, after the header, word 0 as the token it pays out and word 1 as the amount it pays, which
 * this builder writes. Nothing here is real market data.
 */
import { DEPLOYMENTS, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { type Address, concat, encodeFunctionData, type Hex, pad, parseAbi, toHex } from "viem";
import {
  EXECUTOR_DATA_HEADER,
  KYBERSWAP_EXECUTOR,
  KYBERSWAP_ROUTER,
  kyberswapRouterAbi,
  planHash,
} from "../src/lib/execution/calldata";
import type { ChainReads, FeedReading } from "../src/lib/execution/market";
import { REFERENCE_FEEDS } from "../src/lib/market/feeds";

export const USDC: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** Constituents of the seeded "Diversified Equity" index, version 2, and their recorded symbols. */
export const TSLA: Address = "0xb2000000000000000000001e800a7f5189430cd0";
export const MSTR: Address = "0xb2000000000000000000004884b426556b92883d";
export const NVDA: Address = "0xb20000000000000000000078ee7ce2fe4908108c";
export const AAPL: Address = "0xb200000000000000000000c2e324d24d7eecd1fb";
export const AMZN: Address = "0xb200000000000000000000d9192b6b456483c2e8";
export const DIVERSIFIED = {
  indexId: "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610",
  identifier: "diversified-equity-d622e2a5",
  name: "Diversified Equity",
  version: 2,
} as const;

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export interface TestLeg {
  readonly side: "sell" | "buy";
  readonly token: Address;
  readonly symbol: string;
  /** Sell: the token quantity sold. Buy: the USDC spent. */
  readonly amountIn: bigint;
  readonly quotedAmountOut: bigint;
  /** Defaults to `floor(quoted * (10000 - slippage) / 10000)`. */
  readonly minAmountOut?: bigint;
  /** What the mock executor pays out. Defaults to the quoted amount. */
  readonly payout?: bigint;
  readonly referencePriceE8?: bigint;
}

export interface TestPlanOptions {
  readonly account: Address;
  readonly chainId: number;
  readonly legs: readonly TestLeg[];
  /** Unix seconds. Every route deadline equals it. */
  readonly expiresAt: number;
  readonly slippageBps?: number;
  /** Balances before the plan, by lowercase token. USDC and every leg token. */
  readonly balances: Readonly<Record<string, bigint>>;
  /** Warnings the plan carries, as `[check, reason, leg]`. */
  readonly warnings?: readonly (readonly [string, string, number | null])[];
  readonly registry?: { readonly chainId: number; readonly address: Address };
  /** Allowances toward the router before the plan, by lowercase token. A token whose allowance covers what the
   * plan swaps of it gets no approval call, as the server builds it. */
  readonly allowances?: Readonly<Record<string, bigint>>;
}

/** The executor data the mock executor reads: header, then words; 8 is the recipient, 16 the deadline. */
export function testExecutorData(tokenOut: Address, payout: bigint, recipient: Address, deadline: number): Hex {
  const words: Hex[] = Array.from({ length: 18 }, () => pad("0x00"));
  words[0] = pad(tokenOut);
  words[1] = toHex(payout, { size: 32 });
  words[8] = pad(recipient);
  words[16] = toHex(deadline, { size: 32 });
  return concat([EXECUTOR_DATA_HEADER, ...words]);
}

/** `swap` calldata in the recorded layout for one leg. */
export function testSwapCalldata(input: {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly payout: bigint;
  readonly account: Address;
  readonly deadline: number;
}): Hex {
  return encodeFunctionData({
    abi: kyberswapRouterAbi,
    functionName: "swap",
    args: [
      {
        callTarget: KYBERSWAP_EXECUTOR,
        approveTarget: ZERO,
        targetData: testExecutorData(input.tokenOut, input.payout, input.account, input.deadline),
        desc: {
          srcToken: input.tokenIn,
          dstToken: input.tokenOut,
          srcReceivers: [KYBERSWAP_EXECUTOR],
          srcAmounts: [input.amountIn],
          feeReceivers: [],
          feeAmounts: [],
          dstReceiver: input.account,
          amount: input.amountIn,
          minReturnAmount: input.minAmountOut,
          flags: 0x200n,
          permit: "0x",
        },
        clientData: "0x",
      },
    ],
  });
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function check(check: string, status: string, reason: string, token: Address | null, leg: number | null) {
  return { check, status, reason, token, leg, detail: null };
}

/** A `ready` answer for the legs, with every check passing apart from the given warnings. */
export function buildReadyPlan(options: TestPlanOptions) {
  const { account, chainId, expiresAt } = options;
  const slippageBps = options.slippageBps ?? 50;
  const lower = account.toLowerCase() as Address;
  const legs = options.legs.map((leg) => {
    const minAmountOut = leg.minAmountOut ?? (leg.quotedAmountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const tokenIn = leg.side === "sell" ? leg.token : USDC;
    const tokenOut = leg.side === "sell" ? USDC : leg.token;
    return { ...leg, minAmountOut, tokenIn, tokenOut, payout: leg.payout ?? leg.quotedAmountOut };
  });
  const totals = new Map<Address, bigint>();
  for (const leg of legs) totals.set(leg.tokenIn, (totals.get(leg.tokenIn) ?? 0n) + leg.amountIn);
  const allowanceOf = (token: Address) => options.allowances?.[token.toLowerCase()] ?? 0n;
  const approvals = [...totals].map(([token, amount]) => ({
    token,
    spender: KYBERSWAP_ROUTER,
    currentAllowance: allowanceOf(token).toString(),
    amount: amount.toString(),
    required: allowanceOf(token) < amount,
  }));
  const order = [
    ...legs.flatMap((leg, index) => (leg.side === "sell" ? [index] : [])),
    ...legs.flatMap((leg, index) => (leg.side === "buy" ? [index] : [])),
  ];
  const calls = [
    ...[...totals]
      .flatMap(([token, amount]) => (allowanceOf(token) >= amount ? [] : [[token, amount] as const]))
      .map(([token, amount]) => ({
        kind: "approve" as const,
        to: token,
        data: encodeFunctionData({ abi: approveAbi, functionName: "approve", args: [KYBERSWAP_ROUTER, amount] }),
        value: "0",
        token,
        leg: null,
        minAmountOut: null,
      })),
    ...order.map((index) => {
      const leg = legs[index];
      if (leg === undefined) throw new Error(`no leg ${index}`);
      return {
        kind: "swap" as const,
        to: KYBERSWAP_ROUTER,
        data: testSwapCalldata({ ...leg, account: lower, deadline: expiresAt }),
        value: "0",
        token: leg.tokenIn,
        leg: index,
        minAmountOut: leg.minAmountOut.toString(),
      };
    }),
  ];
  const before = (token: Address) => options.balances[token.toLowerCase()] ?? 0n;
  const minUsdcFromSells = legs.reduce((sum, leg) => (leg.side === "sell" ? sum + leg.minAmountOut : sum), 0n);
  const maxUsdcForBuys = legs.reduce((sum, leg) => (leg.side === "buy" ? sum + leg.amountIn : sum), 0n);
  const warnings = (options.warnings ?? []).map(([name, reason, leg]) =>
    check(name, "warn", reason, leg === null ? null : (legs[leg]?.token ?? null), leg),
  );
  const registry = options.registry ?? {
    chainId: LOCAL_CHAIN_ID,
    address: DEPLOYMENTS[LOCAL_CHAIN_ID].registry.toLowerCase() as Address,
  };
  const hash = planHash(
    chainId,
    lower,
    expiresAt,
    calls.map(({ to, data, value }) => ({ to, data, value: BigInt(value) })),
  );
  return {
    data: {
      address: lower,
      index: { ...DIVERSIFIED, latestVersion: 2, isLatest: true },
      chainId,
      priceBasis: "executable_quote",
      statement:
        "Executable quotes from a third-party aggregator, checked against reference prices and the chain at one block. Each swap returns at least its minimum amount out or reverts; more than the minimum is not guaranteed. The plan must be quoted again after expiresAt, and it is not an instruction to trade.",
      mode: legs.some((leg) => leg.side === "sell") ? "rebalance" : "buy_only",
      reserveBps: 50,
      minLegValueUsdE8: "100000000",
      slippageBps,
      maxDeviationBps: 150,
      allowUnsimulated: false,
      provider: { name: "kyberswap", router: KYBERSWAP_ROUTER },
      status: "ready",
      executable: true,
      expiresAt: iso(expiresAt),
      checkedAtBlock: { number: "1000", timestamp: iso(expiresAt - 120) },
      simulationMethod: "eth_simulateV1",
      legs: legs.map((leg) => ({
        side: leg.side,
        token: leg.token,
        symbol: leg.symbol,
        decimals: 8,
        tokenIn: leg.tokenIn,
        tokenOut: leg.tokenOut,
        amountIn: leg.amountIn.toString(),
        referencePriceE8: (leg.referencePriceE8 ?? 10_000_000_000n).toString(),
        referenceStatus: "live",
        referenceAmountOut: leg.quotedAmountOut.toString(),
        quote: {
          provider: "kyberswap",
          router: KYBERSWAP_ROUTER,
          functionName: "swap",
          quotedAmountOut: leg.quotedAmountOut.toString(),
          minAmountOut: leg.minAmountOut.toString(),
          deviationBps: 0,
          minimumDeviationBps: 50,
          deadline: iso(expiresAt),
          gasEstimate: "600000",
          quotedAt: iso(expiresAt - 120),
          routeId: `test-${leg.symbol}`,
        },
      })),
      checks: [
        check("jurisdiction", "pass", "permitted_country", null, null),
        check("reference_plan", "pass", "ready", null, null),
        ...warnings,
        check("simulation", "pass", "sequence_simulated", null, null),
        check("plan_expiry", "pass", "current", null, null),
      ],
      blockedBy: [],
      warnings,
      approvals,
      calls,
      totals: {
        usdcBalance: before(USDC).toString(),
        minUsdcFromSells: minUsdcFromSells.toString(),
        maxUsdcForBuys: maxUsdcForBuys.toString(),
        endBalances: [
          {
            token: USDC,
            before: before(USDC).toString(),
            after: (before(USDC) + minUsdcFromSells - maxUsdcForBuys).toString(),
          },
          ...legs.map((leg) => ({
            token: leg.token,
            before: before(leg.token).toString(),
            after: (leg.side === "sell"
              ? before(leg.token) - leg.amountIn
              : before(leg.token) + leg.minAmountOut
            ).toString(),
          })),
        ],
      },
      planHash: hash,
    },
    meta: { registry: { ...registry, mode: "live" } },
  };
}

/** A `blocked` answer: the reference freshness check blocks, as it does when the market is closed. */
export function buildBlockedPlan(account: Address, chainId: number) {
  const blocking = check("reference_freshness", "block", "last_close", NVDA, 0);
  return {
    data: {
      address: account.toLowerCase(),
      index: { ...DIVERSIFIED, latestVersion: 2, isLatest: true },
      chainId,
      priceBasis: "executable_quote",
      statement: "A fixed statement.",
      mode: "rebalance",
      slippageBps: 50,
      provider: { name: "kyberswap", router: KYBERSWAP_ROUTER },
      status: "blocked",
      executable: false,
      expiresAt: null,
      checkedAtBlock: null,
      simulationMethod: null,
      legs: [],
      checks: [check("jurisdiction", "pass", "permitted_country", null, null), blocking],
      blockedBy: [blocking],
      warnings: [],
      approvals: [],
      calls: null,
      totals: null,
      planHash: null,
    },
    meta: {
      registry: {
        chainId: LOCAL_CHAIN_ID,
        address: DEPLOYMENTS[LOCAL_CHAIN_ID].registry.toLowerCase(),
        mode: "replay",
      },
    },
  };
}

/** A Wednesday at 10:00 in New York: the regular session is open, so a feed round a minute old is live. */
export const OPEN_MARKET_TIME = 1_799_852_400;

/** A leg as the answer carries it or as the client parses it. */
interface LegAmounts {
  readonly side: string;
  readonly token: string;
  readonly decimals: number;
  readonly amountIn: bigint | string;
  readonly quote: { readonly quotedAmountOut: bigint | string } | null;
}

/** The price at which a leg's quote is exactly fair, USD per token scaled by 1e8, rounded down. */
export function fairPriceE8(leg: LegAmounts): bigint {
  const scale = 100n * 10n ** BigInt(leg.decimals);
  const quoted = BigInt(leg.quote?.quotedAmountOut ?? "0");
  const amountIn = BigInt(leg.amountIn);
  return leg.side === "sell" ? (quoted * scale) / amountIn : (amountIn * scale) / quoted;
}

/**
 * What the browser reads on the chain for a plan answer: the decimals the plan states, and for every leg its
 * pinned feed answering a fair price for the leg's quote, a minute before `chainTime`. `prices` replaces a
 * token's price; `decimals` replaces a token's decimals.
 */
export function chainReadsFor(
  plan: { readonly legs: readonly LegAmounts[] },
  options: {
    readonly chainTime?: number;
    readonly prices?: Readonly<Record<string, bigint>>;
    readonly decimals?: Readonly<Record<string, number>>;
  } = {},
): ChainReads {
  const chainTime = options.chainTime ?? OPEN_MARKET_TIME;
  const decimals = new Map<string, number | null>([[USDC, 6]]);
  const feeds = new Map<string, FeedReading>();
  for (const leg of plan.legs) {
    const token = leg.token.toLowerCase();
    decimals.set(token, options.decimals?.[token] ?? leg.decimals);
    const feed = REFERENCE_FEEDS.get(token as Address);
    if (feed === undefined) continue;
    feeds.set(token, {
      decimals: 8,
      description: feed.description,
      round: {
        roundId: 7n,
        answer: options.prices?.[token] ?? fairPriceE8(leg),
        updatedAt: BigInt(chainTime - 60),
        answeredInRound: 7n,
      },
    });
  }
  for (const [token, value] of Object.entries(options.decimals ?? {})) decimals.set(token, value);
  return { chainTime, decimals, feeds };
}
