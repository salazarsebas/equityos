import { describe, expect, test } from "bun:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  type Hex,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from "viem";
import type { CheckResult } from "../../src/server/execution/checks";
import { KYBERSWAP_ROUTER, planHash } from "../../src/lib/execution/calldata";
import {
  buildExecutionPlan,
  DEADLINE_TOLERANCE_SECONDS,
  DeadlineExceededError,
  type ExecutionDependencies,
  type ExecutionLeg,
  type ExecutionPlanInput,
  MULTIPLIER_WINDOW_SECONDS,
  PLAN_TTL_SECONDS,
  ProviderRateLimitedError,
} from "../../src/server/execution/plan";
import type { QuoteProvider } from "../../src/server/execution/provider";
import type { Jurisdiction } from "../../src/server/jurisdiction";
import { USDC_ADDRESS } from "../../src/server/market/balances";
import {
  ACCOUNT,
  buyLeg,
  constructedProvider,
  executorData,
  FakeExecutionChain,
  NO_DEADLINE,
  NVDA,
  OPEN_AT,
  OPEN_BUDGET,
  sellLeg,
  swapCalldata,
  TSLA,
} from "./support";

const NVDA_TWO = "0xb200000000000000000000c2e324d24d7eecd1fb";
const PERMITTED: Jurisdiction = { restricted: false, reason: "permitted_country", country: "DE" };
const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** A wallet that holds what the two default legs need, with no allowance yet. */
function wallet(): FakeExecutionChain {
  return new FakeExecutionChain().token(NVDA, { balance: 3_000_000n }).token(TSLA);
}

interface Setup {
  readonly chain?: FakeExecutionChain;
  readonly legs?: readonly ExecutionLeg[];
  readonly provider?: QuoteProvider;
  readonly input?: Partial<ExecutionPlanInput>;
  readonly clock?: () => number;
  readonly budget?: ExecutionDependencies["providerBudget"];
  readonly signal?: AbortSignal;
}

async function plan(setup: Setup = {}) {
  const chain = setup.chain ?? wallet();
  const legs = setup.legs ?? [sellLeg(), buyLeg()];
  const provider = setup.provider ?? constructedProvider(legs).provider;
  return buildExecutionPlan(
    {
      provider,
      client: chain.client(),
      now: setup.clock ?? (() => OPEN_AT),
      providerBudget: setup.budget ?? OPEN_BUDGET,
      signal: setup.signal ?? NO_DEADLINE,
    },
    {
      account: ACCOUNT,
      reference: { status: "ready", legs },
      jurisdiction: PERMITTED,
      slippageBps: 50,
      maxDeviationBps: 100,
      allowUnsimulated: false,
      ...setup.input,
    },
  );
}

const find = (checks: readonly CheckResult[], check: CheckResult["check"], token?: string) =>
  checks.filter((entry) => entry.check === check && (token === undefined || entry.token === token));

describe("a ready plan", () => {
  test("approves exactly what it swaps, then sells, then buys, and binds the calls with planHash", async () => {
    const result = await plan();
    expect(result.blockedBy).toEqual([]);
    expect(result.status).toBe("ready");
    expect(result.executable).toBe(true);
    expect(result.simulationMethod).toBe("eth_simulateV1");
    const calls = result.calls ?? [];
    expect(calls.map(({ kind, to }) => [kind, to])).toEqual([
      ["approve", NVDA],
      ["approve", USDC_ADDRESS],
      ["swap", KYBERSWAP_ROUTER],
      ["swap", KYBERSWAP_ROUTER],
    ]);
    const approvals = calls.slice(0, 2).map(({ data }) => {
      const [spender, amount] = decodeFunctionData({ abi: approveAbi, data }).args;
      return [spender.toLowerCase(), amount];
    });
    expect(approvals).toEqual([
      [KYBERSWAP_ROUTER, 3_000_000n],
      [KYBERSWAP_ROUTER, 5_000_000n],
    ]);
    expect(calls.map((call) => call.leg)).toEqual([null, null, 0, 1]);
    expect(calls.every((call) => call.value === 0n)).toBe(true);
    expect(result.planHash).toBe(planHash(8453, ACCOUNT, OPEN_AT + PLAN_TTL_SECONDS, calls));
    expect(result.expiresAt).toBe(OPEN_AT + PLAN_TTL_SECONDS);
    expect(result.checkedAtBlock?.number).toBe(61_000_000n);
  });

  test("states totals at the minimum amounts out", async () => {
    const result = await plan();
    const sellMinimum = result.legs[0]?.quoted?.quote.minAmountOut ?? 0n;
    const buyMinimum = result.legs[1]?.quoted?.quote.minAmountOut ?? 0n;
    // 4.80 USDC quoted at the reference, 50 bps tolerance.
    expect(sellMinimum).toBe(4_776_000n);
    expect(result.totals).toEqual({
      usdcBalance: 10_000_000n,
      minUsdcFromSells: sellMinimum,
      maxUsdcForBuys: 5_000_000n,
      endBalances: [
        { token: USDC_ADDRESS, before: 10_000_000n, after: 10_000_000n + sellMinimum - 5_000_000n },
        { token: NVDA, before: 3_000_000n, after: 0n },
        { token: TSLA, before: 0n, after: buyMinimum },
      ],
    });
    expect(result.legs.map((leg) => leg.quoted?.deviationBps)).toEqual([0, 0]);
  });

  test("asks no approval for an allowance that already covers the swap", async () => {
    const chain = wallet();
    chain.token(NVDA, { balance: 3_000_000n, allowance: 3_000_000n });
    chain.usdc.allowance = 4_999_999n;
    const result = await plan({ chain });
    expect(result.approvals.map(({ token, required }) => [token, required])).toEqual([
      [NVDA, false],
      [USDC_ADDRESS, true],
    ]);
    expect((result.calls ?? []).filter((call) => call.kind === "approve").map((call) => call.to)).toEqual([
      USDC_ADDRESS,
    ]);
  });

  test("passes the account as sender and recipient, the tolerance and one deadline to the provider", async () => {
    const legs = [sellLeg(), buyLeg()];
    const { provider, requests } = constructedProvider(legs);
    await plan({ legs, provider });
    expect(requests).toEqual([
      {
        tokenIn: NVDA,
        tokenOut: USDC_ADDRESS,
        amountIn: 3_000_000n,
        account: ACCOUNT,
        slippageBps: 50,
        deadline: OPEN_AT + PLAN_TTL_SECONDS,
      },
      {
        tokenIn: USDC_ADDRESS,
        tokenOut: TSLA,
        amountIn: 5_000_000n,
        account: ACCOUNT,
        slippageBps: 50,
        deadline: OPEN_AT + PLAN_TTL_SECONDS,
      },
    ]);
  });
});

describe("planHash", () => {
  const calls = [
    { to: NVDA, value: 0n, data: "0x095ea7b3" as Hex },
    { to: KYBERSWAP_ROUTER, value: 0n, data: "0xe21fd0e9" as Hex },
  ];

  test("is keccak256 of the documented encoding", () => {
    const encoded = encodeAbiParameters(
      parseAbiParameters("string, uint256, address, uint64, (address to, uint256 value, bytes data)[]"),
      ["equityos.execution-plan/1", 8453n, ACCOUNT, 1_795_532_520n, calls],
    );
    expect(planHash(8453, ACCOUNT, 1_795_532_520, calls)).toBe(keccak256(encoded));
  });

  test("changes with the chain, the account, the expiry, the order and every field of every call", () => {
    const E = 1_795_532_520;
    const base = planHash(8453, ACCOUNT, E, calls);
    const [first, second] = calls;
    if (first === undefined || second === undefined) throw new Error("two calls");
    const variants = [
      planHash(84532, ACCOUNT, E, calls),
      planHash(8453, ACCOUNT, E + 1, calls),
      planHash(8453, NVDA, E, calls),
      planHash(8453, ACCOUNT, E, [second, first]),
      planHash(8453, ACCOUNT, E, [first]),
      planHash(8453, ACCOUNT, E, [{ ...first, to: TSLA }, second]),
      planHash(8453, ACCOUNT, E, [{ ...first, value: 1n }, second]),
      planHash(8453, ACCOUNT, E, [first, { ...second, data: "0xe21fd0ea" }]),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("blocking checks", () => {
  test("the jurisdiction gate blocks before any quote or read", async () => {
    const chain = wallet();
    const legs = [sellLeg()];
    const { provider, requests } = constructedProvider(legs);
    for (const jurisdiction of [
      { restricted: true, reason: "restricted_country", country: "US" },
      { restricted: true, reason: "country_unknown", country: null },
    ] as const) {
      const result = await plan({ chain, legs, provider, input: { jurisdiction } });
      expect(result.status).toBe("blocked");
      expect(result.blockedBy.map(({ check, reason }) => [check, reason])).toEqual([
        ["jurisdiction", jurisdiction.reason],
      ]);
      expect(result.legs).toEqual([]);
    }
    expect(requests).toEqual([]);
    expect(chain.requests).toEqual([]);
  });

  test("a blocked reference plan, an empty one and one with too many legs are not quoted", async () => {
    const blocked = await plan({ input: { reference: { status: "blocked", codes: ["missing_price"] } } });
    expect(blocked.blockedBy[0]).toMatchObject({
      check: "reference_plan",
      reason: "plan_blocked",
      detail: "missing_price",
    });
    const empty = await plan({ input: { reference: { status: "ready", legs: [] } } });
    expect(empty.blockedBy[0]).toMatchObject({ reason: "no_legs" });
    const many = Array.from({ length: 6 }, () => buyLeg());
    expect((await plan({ legs: many })).blockedBy[0]).toMatchObject({ reason: "too_many_legs", detail: "6" });
  });

  test("a last close or unavailable reference blocks, a delayed one warns", async () => {
    const closed = await plan({ legs: [sellLeg({ priceStatus: "last_close" }), buyLeg()] });
    expect(closed.blockedBy).toMatchObject([{ check: "reference_freshness", reason: "last_close", leg: 0 }]);
    expect(closed.legs.every((leg) => leg.quoted === null)).toBe(true);
    expect((await plan({ legs: [buyLeg({ priceStatus: "unavailable" })] })).status).toBe("blocked");
    const delayed = await plan({ legs: [sellLeg({ priceStatus: "delayed" }), buyLeg()] });
    expect(delayed.status).toBe("ready");
    expect(delayed.executable).toBe(true);
    expect(find(delayed.checks, "reference_freshness")[0]?.status).toBe("warn");
  });

  test("a paused token blocks", async () => {
    const chain = wallet();
    chain.token(TSLA, { paused: true });
    const result = await plan({ chain });
    expect(result.blockedBy).toMatchObject([{ check: "transfers_not_paused", token: TSLA, reason: "paused" }]);
    expect(result.calls).toBeNull();
    expect(result.planHash).toBeNull();
    const usdcPaused = wallet();
    usdcPaused.usdc.paused = true;
    expect((await plan({ chain: usdcPaused })).blockedBy).toMatchObject([
      { check: "transfers_not_paused", token: USDC_ADDRESS },
    ]);
  });

  test("the policy must authorize the account to send and receive, and the router as executor", async () => {
    const user = wallet().deny(5n, ACCOUNT);
    expect(find((await plan({ chain: user })).blockedBy, "policy_authorized", NVDA)[0]?.detail).toBe("sender,receiver");
    const router = wallet().deny(5n, KYBERSWAP_ROUTER);
    expect(find((await plan({ chain: router })).blockedBy, "policy_authorized", TSLA)[0]?.detail).toBe("executor");
    const separate = wallet().token(NVDA, {
      balance: 3_000_000n,
      policies: { sender: 7n, receiver: 5n, executor: 5n },
    });
    separate.deny(7n, ACCOUNT);
    expect(find((await plan({ chain: separate })).blockedBy, "policy_authorized", NVDA)[0]?.detail).toBe("sender");
    const blacklisted = wallet();
    blacklisted.usdc.blacklisted.add(ACCOUNT);
    expect(find((await plan({ chain: blacklisted })).blockedBy, "policy_authorized", USDC_ADDRESS)[0]?.detail).toBe(
      "sender,receiver",
    );
  });

  test("a multiplier update within the window blocks, one beyond it passes", async () => {
    const chain = wallet();
    chain.token(TSLA, { effectiveAt: BigInt(OPEN_AT + MULTIPLIER_WINDOW_SECONDS) });
    expect((await plan({ chain })).blockedBy).toMatchObject([{ check: "multiplier_window", token: TSLA }]);
    chain.token(TSLA, { effectiveAt: BigInt(OPEN_AT + MULTIPLIER_WINDOW_SECONDS + 1) });
    expect((await plan({ chain })).status).toBe("ready");
  });

  test("an executable price outside the band blocks, in either direction", async () => {
    const legs = [sellLeg(), buyLeg()];
    for (const deviationBps of [150n, -150n]) {
      const result = await plan({ legs, provider: constructedProvider(legs, { deviationBps }).provider });
      expect(result.blockedBy.map(({ check }) => check)).toContain("price_deviation");
    }
    // 40 bps under the reference, and 50 bps of slippage under that: the minimum is within the 100 bps band.
    const inside = await plan({ legs, provider: constructedProvider(legs, { deviationBps: -40n }).provider });
    expect(inside.status).toBe("ready");
    expect(inside.legs[0]?.quoted).toMatchObject({ deviationBps: -40, minimumDeviationBps: -90 });
    // 60 bps under is within the band at the quote, and not at the minimum.
    const worst = await plan({ legs, provider: constructedProvider(legs, { deviationBps: -60n }).provider });
    expect(find(worst.blockedBy, "price_deviation").map(({ leg, detail }) => [leg, detail])).toEqual([[0, "-60/-110"]]);
  });

  test("the minimum-out price must be within the band, for a sell and for a buy", async () => {
    const legs = [sellLeg(), buyLeg()];
    const loose = await plan({ legs, input: { slippageBps: 150 } });
    const blocked = find(loose.blockedBy, "price_deviation");
    expect(blocked.map(({ leg }) => leg)).toEqual([0, 1]);
    // A sell's minimum is a lower price, a buy's minimum a higher one.
    expect(loose.legs.map((leg) => leg.quoted?.minimumDeviationBps)).toEqual([-150, 153]);
    expect((await plan({ legs, input: { slippageBps: 90 } })).status).toBe("ready");
  });

  test("buys are funded by the minimum amounts out of the sells, not by their quoted amounts", async () => {
    const legs = [sellLeg(), buyLeg({ quoteAmount: 5_000_000n })];
    const chain = wallet();
    // Held 0.224 USDC: the sell quotes 4.80 and guarantees 4.776, so 5.024 is quoted and 5.000 guaranteed.
    chain.usdc.balance = 224_000n;
    expect((await plan({ chain, legs })).status).toBe("ready");
    chain.usdc.balance = 223_999n;
    const short = await plan({ chain, legs });
    expect(short.blockedBy).toMatchObject([
      { check: "balance", token: USDC_ADDRESS, reason: "insufficient", detail: "5000000/4999999" },
    ]);
  });

  test("a sell above the balance held blocks", async () => {
    const chain = wallet().token(NVDA, { balance: 2_999_999n });
    expect((await plan({ chain })).blockedBy).toMatchObject([
      { check: "balance", token: NVDA, detail: "3000000/2999999" },
    ]);
  });

  test("a quote that does not verify blocks its leg and skips the funding and simulation", async () => {
    const legs = [sellLeg(), buyLeg()];
    const provider = constructedProvider(legs, {
      tamper: (quote, request) =>
        request.tokenIn === NVDA ? { ...quote, calldata: swapCalldata(request, 1n, { dstReceiver: NVDA }) } : quote,
    }).provider;
    const result = await plan({ legs, provider });
    expect(result.blockedBy).toMatchObject([{ check: "quote", leg: 0, reason: "calldata_mismatch" }]);
    expect(find(result.checks, "simulation")[0]?.status).toBe("skipped");
    expect(result.legs[0]?.quoted).toBeNull();
    expect(result.approvals).toHaveLength(2);
  });

  test("a reverted call blocks with the decoded error and its position", async () => {
    const chain = wallet();
    const forbids = parseAbi(["error PolicyForbids(bytes32 policyScope, uint64 policyId)"]);
    chain.revert = {
      index: 3,
      data: encodeErrorResult({ abi: forbids, errorName: "PolicyForbids", args: [`0x${"00".repeat(32)}`, 5n] }),
    };
    const result = await plan({ chain });
    expect(result.blockedBy).toMatchObject([
      { check: "simulation", reason: "call_reverted", detail: "3:PolicyForbids" },
    ]);
    chain.revert = { index: 2, data: "0x08c379a0" as Hex };
    expect((await plan({ chain })).blockedBy[0]?.detail).toBe("2:unknown");
  });

  test("a plan whose quotes took longer than its lifetime is blocked as expired", async () => {
    let now = OPEN_AT;
    const result = await plan({ clock: () => (now += 31) });
    expect(result.blockedBy).toMatchObject([{ check: "plan_expiry", reason: "expired" }]);
  });
});

describe("simulation without eth_simulateV1", () => {
  test("blocks by default when the sequence cannot be simulated, and never claims it was", async () => {
    const chain = wallet();
    chain.simulation = "unsupported";
    const result = await plan({ chain });
    expect(result.simulationMethod).toBe("eth_call");
    expect(result.blockedBy).toMatchObject([
      { check: "simulation", status: "not_simulated", reason: "sequence_not_supported", detail: "2,3" },
    ]);
    expect(result.calls).toBeNull();
  });

  test("an explicit acceptance makes the plan ready but never executable", async () => {
    const chain = wallet();
    chain.simulation = "unsupported";
    const result = await plan({ chain, input: { allowUnsimulated: true } });
    expect(result.status).toBe("ready");
    expect(result.executable).toBe(false);
    expect(result.calls).toHaveLength(4);
  });

  test("calls that all ran alone are still not a simulated sequence: blocked, never executable", async () => {
    const chain = wallet().token(NVDA, { balance: 3_000_000n, allowance: 3_000_000n });
    chain.usdc.allowance = 5_000_000n;
    chain.simulation = "unsupported";
    const result = await plan({ chain });
    expect(result.blockedBy).toMatchObject([
      { check: "simulation", status: "not_simulated", reason: "calls_simulated_alone" },
    ]);
    expect(result.simulationMethod).toBe("eth_call");
    const accepted = await plan({ chain, input: { allowUnsimulated: true } });
    expect(accepted.status).toBe("ready");
    expect(accepted.executable).toBe(false);
  });

  test("a transport failure of eth_simulateV1 is retried once; twice is a fallback to single calls", async () => {
    const flaky = wallet();
    flaky.simulation = "flaky";
    const recovered = await plan({ chain: flaky });
    expect(recovered.simulationMethod).toBe("eth_simulateV1");
    expect(recovered.executable).toBe(true);
    expect(flaky.requests.filter((method) => method === "eth_simulateV1")).toHaveLength(2);
    const down = wallet();
    down.simulation = "down";
    const fallback = await plan({ chain: down });
    expect(down.requests.filter((method) => method === "eth_simulateV1")).toHaveLength(2);
    expect(fallback.simulationMethod).toBe("eth_call");
    expect(fallback.executable).toBe(false);
    expect(fallback.blockedBy.map(({ check }) => check)).toEqual(["simulation"]);
  });
});

describe("deadlines, rate limits and warnings", () => {
  const atDeadline = (deadline: number) =>
    constructedProvider([sellLeg(), buyLeg()], {
      tamper: (quote, request) =>
        request.tokenIn === NVDA
          ? {
              ...quote,
              calldata: swapCalldata(
                request,
                (quote.quotedAmountOut * 9_950n) / 10_000n,
                {},
                { targetData: executorData(request.account, deadline) },
              ),
            }
          : quote,
    }).provider;

  test("the route deadline is decoded, asked as the plan lifetime, and shortens the expiry", async () => {
    const result = await plan();
    expect(result.legs.map((leg) => leg.quoted?.quote.deadline)).toEqual([
      OPEN_AT + PLAN_TTL_SECONDS,
      OPEN_AT + PLAN_TTL_SECONDS,
    ]);
    const sooner = await plan({ provider: atDeadline(OPEN_AT + 30) });
    expect(sooner.expiresAt).toBe(OPEN_AT + 30);
    expect(sooner.planHash).toBe(planHash(8453, ACCOUNT, OPEN_AT + 30, sooner.calls ?? []));
  });

  test("a route deadline beyond the expiry and its tolerance blocks", async () => {
    const edge = OPEN_AT + PLAN_TTL_SECONDS + DEADLINE_TOLERANCE_SECONDS;
    expect((await plan({ provider: atDeadline(edge) })).status).toBe("ready");
    const late = await plan({ provider: atDeadline(edge + 1) });
    expect(late.blockedBy).toMatchObject([
      { check: "plan_expiry", reason: "deadline_after_expiry", leg: 0, detail: String(edge + 1) },
    ]);
    const past = await plan({ provider: atDeadline(OPEN_AT) });
    expect(past.blockedBy).toMatchObject([{ check: "plan_expiry", reason: "expired" }]);
  });

  test("the provider budget is taken before quoting and a refusal throws with the wait", async () => {
    const taken: number[] = [];
    const budget = {
      take: (count: number) => {
        taken.push(count);
        return { ok: false, retryAfterSeconds: 7 } as const;
      },
    };
    const { provider, requests } = constructedProvider([sellLeg(), buyLeg()]);
    const error = await plan({ provider, budget }).catch((rejection: unknown) => rejection);
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect(error).toMatchObject({ retryAfterSeconds: 7 });
    expect(taken).toEqual([4]);
    expect(requests).toEqual([]);
  });

  test("a 429 of the provider fails the plan fast with the provider's wait", async () => {
    const limited: QuoteProvider = {
      name: "kyberswap",
      requestsPerQuote: 2,
      quote: async () => ({ status: "failed", reason: "provider_rate_limited", detail: "9" }),
    };
    await expect(plan({ provider: limited })).rejects.toMatchObject({
      name: "ProviderRateLimitedError",
      retryAfterSeconds: 9,
    });
  });

  test("an aborted request stops with DeadlineExceededError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(plan({ signal: controller.signal })).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  test("quotes run at most two at a time and keep the order of the legs", async () => {
    const legs = [sellLeg(), buyLeg(), buyLeg({ token: NVDA_TWO })];
    const base = constructedProvider(legs).provider;
    let running = 0;
    let peak = 0;
    const slow: QuoteProvider = {
      ...base,
      quote: async (request, context) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return base.quote(request, context);
      },
    };
    const chain = wallet().token(NVDA_TWO);
    chain.usdc.balance = 20_000_000n;
    const result = await plan({ chain, legs, provider: slow });
    expect(peak).toBe(2);
    expect(result.legs.map((leg) => leg.quoted?.quote.routeId)).toEqual([
      "constructed-sell",
      "constructed-buy",
      "constructed-buy",
    ]);
    expect(result.status).toBe("ready");
  });

  test("every warning is listed, an allowance above the plan included", async () => {
    const chain = wallet().token(NVDA, { balance: 3_000_000n, allowance: 2n ** 256n - 1n });
    const result = await plan({ chain, legs: [sellLeg({ priceStatus: "delayed" }), buyLeg()] });
    expect(result.executable).toBe(true);
    expect(result.warnings.map(({ check, reason, detail }) => [check, reason, detail])).toEqual([
      ["reference_freshness", "delayed", null],
      ["allowance", "above_plan", (2n ** 256n - 1n).toString()],
    ]);
  });
});
