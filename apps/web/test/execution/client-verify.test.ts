import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Address, concat, decodeFunctionData, encodeFunctionData, type Hex, parseAbi } from "viem";
import {
  AMZN,
  buildBlockedPlan,
  buildReadyPlan,
  chainReadsFor,
  DIVERSIFIED,
  NVDA,
  OPEN_MARKET_TIME,
  TSLA,
  testSwapCalldata,
  USDC,
} from "../../e2e/execution-plans";
import { KYBERSWAP_ROUTER, kyberswapRouterAbi } from "../../src/lib/execution/calldata";
import { adverseDeviationBps, type ChainReads, CLIENT_PRICE_BOUND_BPS } from "../../src/lib/execution/market";
import { executionNetwork } from "../../src/lib/execution/networks";
import { type ExecutionPlanView, parseExecutionPlan, PlanShapeError } from "../../src/lib/execution/response";
import { type PlanVerification, verifyExecutionPlan } from "../../src/lib/execution/verify";

const recorded = JSON.parse(
  readFileSync(new URL("../fixtures/execution/plan-recorded.json", import.meta.url), "utf8"),
) as { body: { data: Record<string, unknown>; meta: Record<string, unknown> } };

const RECORDED_ACCOUNT: Address = "0x9696f59e4d72e237be84ffd425dcad154bf96976";
const ACCOUNT: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONSTITUENTS: Address[] = [
  "0xb2000000000000000000001e800a7f5189430cd0",
  "0xb2000000000000000000004884b426556b92883d",
  "0xb20000000000000000000078ee7ce2fe4908108c",
  "0xb200000000000000000000c2e324d24d7eecd1fb",
  "0xb200000000000000000000d9192b6b456483c2e8",
];
const base = executionNetwork(8453, { NODE_ENV: "production" });
const EXPIRES = 1_800_000_000;

/** A plan that sells NVDA and buys TSLA and AMZN, for `ACCOUNT` on Base. */
function rebalanceBody() {
  return buildReadyPlan({
    account: ACCOUNT,
    chainId: 8453,
    expiresAt: EXPIRES,
    legs: [
      { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
      { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n },
      { side: "buy", token: AMZN, symbol: "AMZNc", amountIn: 200_000_000n, quotedAmountOut: 90_000_000n },
    ],
    balances: { [USDC]: 250_500_000n, [NVDA]: 2_464_860_328n, [TSLA]: 456_555_856n, [AMZN]: 503_968_753n },
    warnings: [["reference_freshness", "delayed", 1]],
  });
}

type Body = ReturnType<typeof rebalanceBody>;

const INDEX = { indexId: DIVERSIFIED.indexId, version: DIVERSIFIED.version };

/** Verifies an answer with what the browser would read for it, unless `market` replaces that. */
function verify(body: unknown, account: Address = ACCOUNT, network = base, market?: ChainReads): PlanVerification {
  const plan = parseExecutionPlan(body);
  return verifyExecutionPlan(plan, {
    account,
    network,
    constituents: CONSTITUENTS,
    index: INDEX,
    market: market ?? chainReadsFor(plan),
  });
}

function codes(outcome: PlanVerification): string[] {
  return outcome.ok ? [] : outcome.failures.map(({ code, detail }) => (detail === null ? code : `${code}:${detail}`));
}

/** A copy of the rebalance body with `edit` applied to its data. */
function edited(edit: (data: Body["data"]) => void): Body {
  const body = structuredClone(rebalanceBody());
  edit(body.data);
  return body;
}

function swapArgs(data: Hex) {
  const [execution] = decodeFunctionData({ abi: kyberswapRouterAbi, data }).args;
  return execution;
}

function reencode(data: Hex, change: (execution: ReturnType<typeof swapArgs>) => ReturnType<typeof swapArgs>): Hex {
  return encodeFunctionData({ abi: kyberswapRouterAbi, functionName: "swap", args: [change(swapArgs(data))] });
}

describe("the recorded answer of the server", () => {
  test("parses, and verifies in the browser for the account it was built for", () => {
    const plan = parseExecutionPlan(recorded.body);
    expect(plan.chainId).toBe(8453);
    expect(plan.calls).toHaveLength(6);
    const outcome = verifyExecutionPlan(plan, {
      account: RECORDED_ACCOUNT,
      network: base,
      constituents: CONSTITUENTS,
      index: INDEX,
      market: chainReadsFor(parseExecutionPlan(recorded.body)),
    });
    if (!outcome.ok) throw new Error(codes(outcome).join(" "));
    expect(outcome.hashMatches).toBe(true);
    expect(outcome.localPlanHash).toBe(plan.planHash ?? "0x");
    expect(outcome.calls.map(({ kind }) => kind)).toEqual(["approve", "swap", "swap", "swap", "swap", "swap"]);
    expect(outcome.totals.maxUsdcForBuys).toBe(735_638_949n);
    expect(outcome.totals.endBalances[0]).toEqual({ token: USDC, before: 739_335_637n, afterAtMinimum: 3_696_688n });
  });

  test("is refused for any other account: the receiver and the hash are bound to the address", () => {
    const outcome = verifyExecutionPlan(parseExecutionPlan(recorded.body), {
      account: ACCOUNT,
      network: base,
      constituents: CONSTITUENTS,
      index: INDEX,
      market: chainReadsFor(parseExecutionPlan(recorded.body)),
    });
    expect(codes(outcome)).toEqual(["account_mismatch"]);
  });
});

describe("a plan built for the tests", () => {
  test("verifies, with the decoded minimums, the deadlines and the totals at minimum", () => {
    const outcome = verify(rebalanceBody());
    if (!outcome.ok) throw new Error(codes(outcome).join(" "));
    expect(outcome.hashMatches).toBe(true);
    expect(outcome.calls.map((call) => (call.kind === "swap" ? `swap:${call.leg}` : `approve:${call.token}`))).toEqual([
      `approve:${NVDA}`,
      `approve:${USDC}`,
      "swap:0",
      "swap:1",
      "swap:2",
    ]);
    const sell = outcome.calls[2];
    expect(sell?.kind === "swap" && sell.minAmountOut).toBe(516_405_000n);
    expect(sell?.kind === "swap" && sell.deadline).toBe(EXPIRES);
    expect(outcome.totals.minUsdcFromSells).toBe(516_405_000n);
    expect(outcome.totals.maxUsdcForBuys).toBe(500_000_000n);
    expect(outcome.totals.endBalances[0]?.afterAtMinimum).toBe(250_500_000n + 516_405_000n - 500_000_000n);
  });

  test("a blocked plan is not ready and never verifies", () => {
    expect(codes(verify(buildBlockedPlan(ACCOUNT, 8453)))).toEqual(["not_ready"]);
  });

  test("a check that did not pass refuses the plan even when it claims to be ready", () => {
    const body = edited((data) => {
      data.checks.push({
        check: "simulation",
        status: "not_simulated",
        reason: "x",
        token: null,
        leg: null,
        detail: null,
      });
    });
    expect(codes(verify(body))).toEqual(["check_not_passed:simulation:not_simulated"]);
  });

  test("a plan for a chain this build does not send on is refused, and the local chain only in development", () => {
    const local = buildReadyPlan({ ...rebalanceOptions(), chainId: 31337 });
    expect(codes(verify(local, ACCOUNT, executionNetwork(31337, { NODE_ENV: "production" })))).toEqual([
      "unsupported_chain:31337",
    ]);
    const outcome = verify(local, ACCOUNT, executionNetwork(31337, { NODE_ENV: "development" }));
    expect(outcome.ok).toBe(true);
  });
});

function rebalanceOptions() {
  return {
    account: ACCOUNT,
    chainId: 8453,
    expiresAt: EXPIRES,
    legs: [
      { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
      { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n },
    ] as const,
    balances: { [USDC]: 250_500_000n, [NVDA]: 2_464_860_328n },
  };
}

describe("every field of every call is verified in the browser", () => {
  const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
  const swapIndex = 2;

  const swapEdit = (change: (execution: ReturnType<typeof swapArgs>) => ReturnType<typeof swapArgs>) =>
    edited((data) => {
      const call = data.calls[swapIndex];
      if (call === undefined) throw new Error("no swap");
      call.data = reencode(call.data, change);
    });

  const cases: [string, Body, string][] = [
    [
      "a swap to another router",
      edited((data) => {
        const call = data.calls[swapIndex];
        if (call) call.to = "0x1111111111111111111111111111111111111111";
      }),
      "swap_not_verified:router_not_allowed:0x1111111111111111111111111111111111111111",
    ],
    [
      "a swap with trailing bytes",
      edited((data) => {
        const call = data.calls[swapIndex];
        if (call) call.data = concat([call.data, "0x00"]);
      }),
      "swap_not_verified:calldata_mismatch:encoding",
    ],
    [
      "a swap with native value",
      edited((data) => {
        const call = data.calls[swapIndex];
        if (call) call.value = "1";
      }),
      "swap_not_verified:calldata_mismatch:value",
    ],
    [
      "a swap that delivers to someone else",
      swapEdit((execution) => ({
        ...execution,
        desc: { ...execution.desc, dstReceiver: "0x2222222222222222222222222222222222222222" },
      })),
      "swap_not_verified:calldata_mismatch:dstReceiver",
    ],
    [
      "a swap that pulls more than its leg",
      swapEdit((execution) => ({
        ...execution,
        desc: { ...execution.desc, amount: execution.desc.amount + 1n, srcAmounts: [execution.desc.amount + 1n] },
      })),
      "swap_not_verified:calldata_mismatch:amount,srcAmounts",
    ],
    [
      "a swap of another token",
      swapEdit((execution) => ({ ...execution, desc: { ...execution.desc, srcToken: TSLA } })),
      "swap_not_verified:calldata_mismatch:srcToken",
    ],
    [
      "a swap with a weaker minimum than the slippage allows",
      swapEdit((execution) => ({ ...execution, desc: { ...execution.desc, minReturnAmount: 1n } })),
      "swap_not_verified:calldata_mismatch:minReturnAmount",
    ],
    [
      "a swap with a fee receiver",
      swapEdit((execution) => ({
        ...execution,
        desc: { ...execution.desc, feeReceivers: [ACCOUNT], feeAmounts: [1n] },
      })),
      "swap_not_verified:calldata_mismatch:fee",
    ],
    [
      "a swap whose minimum differs from the one the plan shows",
      edited((data) => {
        const leg = data.legs[0];
        if (leg) leg.quote.minAmountOut = (BigInt(leg.quote.minAmountOut) + 1n).toString();
      }),
      "swap_mismatch:minAmountOut",
    ],
    [
      "a swap call whose stated minimum differs from its calldata",
      edited((data) => {
        const call = data.calls[swapIndex];
        if (call) call.minAmountOut = "1";
      }),
      "swap_mismatch:callMinAmountOut",
    ],
    [
      "a swap whose route runs after the expiry",
      edited((data) => {
        const call = data.calls[swapIndex];
        const leg = data.legs[0];
        if (call === undefined || leg === undefined) return;
        call.data = testSwapCalldata({
          tokenIn: NVDA,
          tokenOut: USDC,
          amountIn: 400_000_000n,
          minAmountOut: BigInt(leg.quote.minAmountOut),
          payout: 519_000_000n,
          account: ACCOUNT.toLowerCase() as Address,
          deadline: EXPIRES + 16,
        });
        leg.quote.deadline = new Date((EXPIRES + 16) * 1000).toISOString().replace(".000Z", "Z");
      }),
      `deadline_out_of_range:${EXPIRES + 16}`,
    ],
    [
      "an approval above the amount swapped",
      edited((data) => {
        const call = data.calls[0];
        if (call)
          call.data = encodeFunctionData({
            abi: approveAbi,
            functionName: "approve",
            args: [KYBERSWAP_ROUTER, 400_000_001n],
          });
      }),
      "approval_not_exact",
    ],
    [
      "an unlimited approval",
      edited((data) => {
        const call = data.calls[0];
        if (call)
          call.data = encodeFunctionData({
            abi: approveAbi,
            functionName: "approve",
            args: [KYBERSWAP_ROUTER, 2n ** 256n - 1n],
          });
      }),
      "approval_not_exact",
    ],
    [
      "an approval toward another spender",
      edited((data) => {
        const call = data.calls[0];
        if (call)
          call.data = encodeFunctionData({
            abi: approveAbi,
            functionName: "approve",
            args: ["0x3333333333333333333333333333333333333333", 400_000_000n],
          });
      }),
      "approval_not_exact",
    ],
    [
      "the swaps out of order",
      edited((data) => {
        const [first, second] = [data.calls[2], data.calls[3]];
        if (first && second) [data.calls[2], data.calls[3]] = [second, first];
      }),
      "call_order",
    ],
    [
      "an extra call",
      edited((data) => {
        const call = data.calls[0];
        if (call) data.calls.unshift({ ...call });
      }),
      "approval_not_exact",
    ],
    [
      "a leg that trades a token outside the index",
      edited((data) => {
        const leg = data.legs[1];
        if (leg) leg.token = "0xb2000000000000000000008bc8786b856e61707c";
      }),
      "leg_invalid:pair,not_constituent",
    ],
    [
      "a router other than the pinned one named by the plan",
      edited((data) => {
        data.provider.router = "0x1111111111111111111111111111111111111111";
      }),
      "router_mismatch",
    ],
    [
      "totals that differ from the calls",
      edited((data) => {
        data.totals.maxUsdcForBuys = "1";
      }),
      "totals_mismatch:maxUsdcForBuys",
    ],
    [
      "an expected balance after the calls that differs from the calls",
      edited((data) => {
        const last = data.totals.endBalances[2];
        if (last) last.after = (BigInt(last.after) + 1n).toString();
      }),
      "totals_mismatch:endBalances",
    ],
  ];

  for (const [name, body, code] of cases) {
    test(`${name} is refused`, () => {
      const outcome = verify(body);
      expect(codes(outcome)[0]?.startsWith(code)).toBe(true);
    });
  }

  test("a server hash that differs from the hash of the calls is reported apart, for its own refusal", () => {
    const body = edited((data) => {
      data.planHash = `0x${"ab".repeat(32)}`;
    });
    const outcome = verify(body);
    if (!outcome.ok) throw new Error(codes(outcome).join(" "));
    expect(outcome.hashMatches).toBe(false);
  });

  test("an expiry that differs from the one the hash was computed with breaks the hash", () => {
    const body = edited((data) => {
      data.expiresAt = new Date((EXPIRES - 1) * 1000).toISOString().replace(".000Z", "Z");
    });
    // The routes now run past the expiry by one second, within tolerance, and the hash no longer matches.
    const outcome = verify(body);
    expect(outcome.ok && outcome.hashMatches).toBe(false);
  });
});

describe("the answer is parsed strictly", () => {
  const malformed: [string, unknown][] = [
    ["not an object", "plan"],
    ["no data", { meta: {} }],
    ["an amount with a sign", edited((data) => Object.assign(data.totals, { usdcBalance: "-1" }))],
    ["an amount as a number", edited((data) => Object.assign(data.totals, { usdcBalance: 1 }))],
    ["an amount above uint256", edited((data) => Object.assign(data.totals, { usdcBalance: (2n ** 256n).toString() }))],
    ["an address that is not one", edited((data) => Object.assign(data, { address: "0x12" }))],
    ["calldata that is not hex", edited((data) => Object.assign(data.calls[0] ?? {}, { data: "0xzz" }))],
    ["an unknown status", edited((data) => Object.assign(data, { status: "maybe" }))],
    ["a timestamp in another format", edited((data) => Object.assign(data, { expiresAt: "1800000000" }))],
    ["a hash of another length", edited((data) => Object.assign(data, { planHash: "0x12" }))],
  ];
  for (const [name, body] of malformed) {
    test(`${name} is refused as malformed`, () => {
      expect(() => parseExecutionPlan(body)).toThrow(PlanShapeError);
    });
  }

  test("addresses are lowercased and amounts are bigint", () => {
    const plan: ExecutionPlanView = parseExecutionPlan(rebalanceBody());
    expect(plan.address).toBe(ACCOUNT.toLowerCase() as Address);
    expect(plan.totals?.usdcBalance).toBe(250_500_000n);
    expect(plan.expiresAt).toBe(EXPIRES);
  });
});

describe("the browser bounds prices and decimals with its own reads", () => {
  const plan = () => parseExecutionPlan(rebalanceBody());

  test("a plan whose minimums are within the bound of the feeds read in the browser verifies, with each leg's deviation", () => {
    const outcome = verify(rebalanceBody());
    if (!outcome.ok) throw new Error(codes(outcome).join(" "));
    // Each minimum is the 50 bps slippage under a quote at exactly the feed's price.
    expect(outcome.market.map(({ adverseBps }) => adverseBps)).toEqual([50n, 51n, 51n]);
  });

  test("a sale at a price the feed contradicts is refused, whatever the server's quote and minimum say", () => {
    // The answer quotes 519 USDC for 4 NVDAc; the feed read in the browser says 134 USD a token.
    const market = chainReadsFor(plan(), { prices: { [NVDA]: 13_400_000_000n } });
    expect(codes(verify(rebalanceBody(), ACCOUNT, base, market))).toEqual(["price_out_of_bounds:366"]);
  });

  test("a buy that pays more per token than the bound allows is refused", () => {
    const market = chainReadsFor(plan(), { prices: { [TSLA]: 37_000_000_000n } });
    expect(codes(verify(rebalanceBody(), ACCOUNT, base, market))[0]?.startsWith("price_out_of_bounds")).toBe(true);
  });

  test("the bound is the server's default band plus its default slippage, and is inclusive", () => {
    expect(CLIENT_PRICE_BOUND_BPS).toBe(200);
    const sell = {
      kind: "swap" as const,
      to: KYBERSWAP_ROUTER,
      data: "0x" as Hex,
      value: 0n as const,
      leg: 0,
      side: "sell" as const,
      tokenIn: NVDA,
      tokenOut: USDC,
      amountIn: 100_000_000n,
      minAmountOut: 98_000_000n,
      quotedAmountOut: 99_000_000n,
      deadline: 1,
    };
    expect(adverseDeviationBps(sell, 8, 10_000_000_000n)).toBe(200n);
    expect(adverseDeviationBps({ ...sell, minAmountOut: 97_999_999n }, 8, 10_000_000_000n)).toBe(201n);
    expect(adverseDeviationBps({ ...sell, minAmountOut: 101_000_000n }, 8, 10_000_000_000n)).toBe(-100n);
  });

  const unusable: [string, () => ChainReads, string][] = [
    [
      "a feed that answers another description",
      () => {
        const market = chainReadsFor(plan());
        const feed = market.feeds.get(NVDA);
        return {
          ...market,
          feeds: new Map([
            ...market.feeds,
            [NVDA, { ...feed, decimals: 8, description: "Other", round: feed?.round ?? null }],
          ]),
        };
      },
      "reference_unusable:feed_mismatch",
    ],
    [
      "a feed that could not be read",
      () => {
        const market = chainReadsFor(plan());
        return {
          ...market,
          feeds: new Map([...market.feeds, [NVDA, { decimals: null, description: null, round: null }]]),
        };
      },
      "reference_unusable:feed_read_failed",
    ],
    [
      "a feed read while the market is closed",
      // Saturday, 2027-01-16 15:00 UTC.
      () => chainReadsFor(plan(), { chainTime: OPEN_MARKET_TIME + 3 * 86_400 }),
      "reference_unusable:last_close",
    ],
    [
      "a feed silent for more than its heartbeat of trading time",
      () => {
        const market = chainReadsFor(plan(), { chainTime: OPEN_MARKET_TIME + 7 * 86_400 });
        const feed = market.feeds.get(NVDA);
        if (feed?.round === null || feed === undefined) throw new Error("no feed");
        const round = { ...feed.round, updatedAt: BigInt(OPEN_MARKET_TIME) };
        return { ...market, feeds: new Map([...market.feeds, [NVDA, { ...feed, round }]]) };
      },
      "reference_unusable:stale_feed",
    ],
  ];
  for (const [name, market, code] of unusable) {
    test(`${name} leaves the leg without a reference, and the plan is refused`, () => {
      expect(codes(verify(rebalanceBody(), ACCOUNT, base, market()))).toContain(code);
    });
  }

  test("decimals read on the chain that differ from the plan's are refused, for a token and for USDC", () => {
    expect(codes(verify(rebalanceBody(), ACCOUNT, base, chainReadsFor(plan(), { decimals: { [NVDA]: 18 } })))).toEqual([
      `decimals_mismatch:${NVDA}`,
    ]);
    expect(codes(verify(rebalanceBody(), ACCOUNT, base, chainReadsFor(plan(), { decimals: { [USDC]: 18 } })))).toEqual([
      `decimals_mismatch:${USDC}`,
    ]);
  });

  test("a plan for another index or version than the comparison on the page is refused", () => {
    const outcome = verifyExecutionPlan(plan(), {
      account: ACCOUNT,
      network: base,
      constituents: CONSTITUENTS,
      index: { indexId: DIVERSIFIED.indexId, version: 1 },
      market: chainReadsFor(plan()),
    });
    expect(codes(outcome)[0]?.startsWith("index_mismatch")).toBe(true);
  });
});
