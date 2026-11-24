/**
 * Live verification of the execution layer against the KyberSwap API and Base mainnet. Read-only: HTTP GET and
 * POST to the quote API, `eth_call` and `eth_simulateV1`. Nothing is signed or sent. Skipped unless
 * `LIVE_TESTS=1`, so it never runs in CI:
 *
 *   LIVE_TESTS=1 bun test test/execution/live.test.ts
 *
 * Uses `BASE_RPC_URL`, or the public endpoint when it is unset. The account defaults to an externally owned
 * account that held USDC on Base mainnet when this test was written; `LIVE_ACCOUNT` replaces it.
 */
import { describe, expect, test } from "bun:test";
import {
  type Address,
  concat,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  isAddress,
  parseAbi,
} from "viem";
import { builderCodeSuffix } from "../../src/lib/execution/builder-code";
import { REFERENCE_FEEDS } from "../../src/lib/market/feeds";
import { createKyberSwapProvider, resolveClientId } from "../../src/server/execution/kyberswap";
import { createExecutionLimits } from "../../src/server/execution/limits";
import { buildExecutionPlan, type ExecutionLeg } from "../../src/server/execution/plan";
import { POLICY_SCOPES, readPreTrade } from "../../src/server/execution/reads";
import { KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER, minimumAmountOut, verifyQuote } from "../../src/lib/execution/calldata";
import { USDC_ADDRESS } from "../../src/server/market/balances";
import { resolveBaseRpcUrl } from "../../src/server/market/config";
import { createMarketData } from "../../src/server/market/index";
import { NVDA, TSLA } from "./support";

const live = process.env.LIVE_TESTS === "1";
const HOLDER: Address = "0x3304e22ddaa22bcdc5fca2269b418046ae7b566a";
const configured = process.env.LIVE_ACCOUNT ?? "";
const ACCOUNT: Address = isAddress(configured) ? (configured.toLowerCase() as Address) : HOLDER;
const routerAbi = parseAbi(["function WETH() view returns (address)"]);
const scopeAbi = parseAbi([
  "function TRANSFER_SENDER_POLICY() view returns (bytes32)",
  "function TRANSFER_RECEIVER_POLICY() view returns (bytes32)",
  "function TRANSFER_EXECUTOR_POLICY() view returns (bytes32)",
]);

describe.skipIf(!live)("live: KyberSwap and Base mainnet", () => {
  const client = createPublicClient({ transport: http(resolveBaseRpcUrl(), { retryCount: 3, retryDelay: 1_000 }) });
  const provider = createKyberSwapProvider({ clientId: resolveClientId() });
  const now = () => Math.floor(Date.now() / 1000);

  /** Runs `calls` in order on one simulated block at `blockNumber`, read-only, without validation. */
  async function simulateSequence(
    calls: readonly { readonly from: Address; readonly to: Address; readonly data: Hex }[],
    blockNumber: bigint,
  ): Promise<string[]> {
    const [block] = await client.simulateBlocks({
      blockNumber,
      validation: false,
      blocks: [{ calls: calls.map(({ from, to, data }) => ({ account: from, to, data })) }],
    });
    return block?.calls.map(({ status, data }) => `${status}:${data}`) ?? [];
  }

  test("the allowlisted router is deployed on Base and the pinned policy scopes are the token's", async () => {
    expect((await client.getCode({ address: KYBERSWAP_ROUTER }))?.length ?? 0).toBeGreaterThan(1_000);
    expect((await client.getCode({ address: KYBERSWAP_EXECUTOR }))?.length ?? 0).toBeGreaterThan(1_000);
    expect(await client.readContract({ address: KYBERSWAP_ROUTER, abi: routerAbi, functionName: "WETH" })).toBe(
      "0x4200000000000000000000000000000000000006",
    );
    for (const token of [NVDA, TSLA]) {
      const read = (functionName: (typeof scopeAbi)[number]["name"]) =>
        client.readContract({ address: token, abi: scopeAbi, functionName });
      expect(await read("TRANSFER_SENDER_POLICY")).toBe(POLICY_SCOPES.sender);
      expect(await read("TRANSFER_RECEIVER_POLICY")).toBe(POLICY_SCOPES.receiver);
      expect(await read("TRANSFER_EXECUTOR_POLICY")).toBe(POLICY_SCOPES.executor);
    }
  }, 30_000);

  test("a buy and a sell are quoted keyless and their calldata verifies", async () => {
    for (const [tokenIn, tokenOut, amountIn] of [
      [USDC_ADDRESS, NVDA, 5_000_000n],
      [NVDA, USDC_ADDRESS, 3_000_000n],
    ] as const) {
      const request = { tokenIn, tokenOut, amountIn, account: ACCOUNT, slippageBps: 50, deadline: now() + 300 };
      const answer = await provider.quote(request, { signal: AbortSignal.timeout(20_000), takeRetry: () => false });
      if (answer.status !== "ok") throw new Error(`quote failed: ${answer.reason} ${answer.detail}`);
      const verified = verifyQuote(request, answer.quote);
      if (verified.status !== "ok") throw new Error(`verification failed: ${verified.reason} ${verified.detail}`);
      expect(verified.quote.minAmountOut).toBeGreaterThanOrEqual(minimumAmountOut(verified.quote.quotedAmountOut, 50));
      console.log(
        `quote: ${amountIn} of ${tokenIn} -> ${verified.quote.quotedAmountOut} of ${tokenOut}, min ${verified.quote.minAmountOut}, ${verified.quote.functionName} on ${verified.quote.router}`,
      );
    }
  }, 30_000);

  test("the pre-trade read of the account answers every field at one block", async () => {
    const read = await readPreTrade(client, ACCOUNT, KYBERSWAP_ROUTER, [USDC_ADDRESS, NVDA, TSLA]);
    for (const [token, state] of read.tokens) {
      expect(state.paused).not.toBeNull();
      expect(state.balance).not.toBeNull();
      expect(state.allowance).not.toBeNull();
      expect(Object.values(state.authorization).every((value) => value !== null)).toBe(true);
      console.log(
        `read ${token} at ${read.blockNumber}: ${JSON.stringify(state, (_, v) => (typeof v === "bigint" ? `${v}` : v))}`,
      );
    }
  }, 30_000);

  test("an executable plan of two buys is checked and simulated read-only", async () => {
    const snapshot = await createMarketData().getSnapshot();
    const priceOf = (token: Address) => {
      const price = snapshot.assets.get(token)?.referencePrice;
      if (price === undefined || price === null || price.status === "unavailable")
        throw new Error(`no price for ${token}`);
      return price;
    };
    const nvda = priceOf(NVDA);
    const tsla = priceOf(TSLA);
    const buy = (token: Address, price: { priceE8: bigint; status: ExecutionLeg["priceStatus"] }): ExecutionLeg => ({
      side: "buy",
      token,
      decimals: 8,
      tokenQuantity: (5_000_000n * 10n ** 10n) / price.priceE8,
      quoteAmount: 5_000_000n,
      priceE8: price.priceE8,
      priceStatus: price.status,
    });
    const legs = [buy(NVDA, nvda), buy(TSLA, tsla)];
    const plan = await buildExecutionPlan(
      { provider, client, now, providerBudget: createExecutionLimits().provider, signal: AbortSignal.timeout(20_000) },
      {
        account: ACCOUNT,
        reference: { status: "ready", legs },
        jurisdiction: { restricted: false, reason: "permitted_country", country: "DE" },
        slippageBps: 50,
        maxDeviationBps: 100,
        allowUnsimulated: false,
      },
    );
    for (const check of plan.checks) {
      console.log(`check ${check.check} ${check.status} ${check.reason} ${check.token ?? ""} ${check.detail ?? ""}`);
    }
    console.log(
      `plan: ${plan.status}, executable ${plan.executable}, simulation ${plan.simulationMethod}, deviations ${plan.legs.map((leg) => leg.quoted?.deviationBps).join("/")} bps, planHash ${plan.planHash}`,
    );
    const fresh = legs.every((leg) => leg.priceStatus === "live" || leg.priceStatus === "delayed");
    if (!fresh) {
      // A closed market blocks before any quote, which is the rule.
      expect(plan.blockedBy.every((check) => check.check === "reference_freshness")).toBe(true);
      return;
    }
    expect(plan.checks.filter((check) => check.check === "quote").every((check) => check.status === "pass")).toBe(true);
    for (const check of ["transfers_not_paused", "policy_authorized", "multiplier_window"] as const) {
      expect(plan.checks.filter((entry) => entry.check === check).every((entry) => entry.status === "pass")).toBe(true);
    }
    expect(plan.simulationMethod).toBe("eth_simulateV1");
    expect(plan.checks.find((check) => check.check === "simulation")?.reason).toBe("sequence_simulated");
  }, 60_000);

  test("the router and the tokens accept the ERC-8021 suffix: a suffixed sequence returns what the plain one does", async () => {
    // Approve USDC, buy NVDA, approve NVDA, sell what the buy returns at minimum: every call once without and
    // once with the Builder Code suffix appended, on one simulated block each, read-only.
    const quote = async (tokenIn: Address, tokenOut: Address, amountIn: bigint) => {
      const request = { tokenIn, tokenOut, amountIn, account: ACCOUNT, slippageBps: 50, deadline: now() + 300 };
      const answer = await provider.quote(request, { signal: AbortSignal.timeout(20_000), takeRetry: () => false });
      if (answer.status !== "ok") throw new Error(`quote failed: ${answer.reason} ${answer.detail}`);
      const verified = verifyQuote(request, answer.quote);
      if (verified.status !== "ok") throw new Error(`verification failed: ${verified.reason} ${verified.detail}`);
      return verified.quote;
    };
    const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
    const approve = (amount: bigint) => encodeFunctionData({ abi: approveAbi, args: [KYBERSWAP_ROUTER, amount] });
    const buy = await quote(USDC_ADDRESS, NVDA, 5_000_000n);
    const sell = await quote(NVDA, USDC_ADDRESS, buy.minAmountOut);
    const calls = [
      { to: USDC_ADDRESS, data: approve(5_000_000n) },
      { to: KYBERSWAP_ROUTER, data: buy.calldata },
      { to: NVDA, data: approve(buy.minAmountOut) },
      { to: KYBERSWAP_ROUTER, data: sell.calldata },
    ];
    const suffix = builderCodeSuffix("equityos");
    if (suffix === null) throw new Error("no suffix");
    const blockNumber = await client.getBlockNumber();
    const simulate = (appended: boolean) =>
      simulateSequence(
        calls.map((call) => ({ from: ACCOUNT, to: call.to, data: appended ? concat([call.data, suffix]) : call.data })),
        blockNumber,
      );
    const plain = await simulate(false);
    const suffixed = await simulate(true);
    console.log(`suffix ${suffix} at block ${blockNumber}: ${suffixed.join(" ")}`);
    expect(plain.every((result) => result.startsWith("success:"))).toBe(true);
    expect(suffixed).toEqual(plain);
  }, 60_000);

  test("every feed-covered token and USDC accept the ERC-8021 suffix on approve, transfer and transferFrom", async () => {
    // One read-only simulation per variant: for each token, from the account an exact approval of the router and
    // a transfer of zero to itself, then from the router a transferFrom of zero from the account. Without and
    // with the suffix appended to every call. The suffix must change no outcome and no returned data.
    const tokenAbi = parseAbi([
      "function approve(address spender, uint256 amount) returns (bool)",
      "function transfer(address to, uint256 amount) returns (bool)",
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    ]);
    const tokens = [USDC_ADDRESS, ...REFERENCE_FEEDS.keys()];
    const calls = tokens.flatMap((token) => [
      {
        from: ACCOUNT,
        to: token,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [KYBERSWAP_ROUTER, 1n] }),
      },
      {
        from: ACCOUNT,
        to: token,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [ACCOUNT, 0n] }),
      },
      {
        from: KYBERSWAP_ROUTER,
        to: token,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "transferFrom", args: [ACCOUNT, ACCOUNT, 0n] }),
      },
    ]);
    const suffix = builderCodeSuffix("equityos");
    if (suffix === null) throw new Error("no suffix");
    const blockNumber = await client.getBlockNumber();
    const simulate = (appended: boolean) =>
      simulateSequence(
        calls.map((call) => ({ ...call, data: appended ? concat([call.data, suffix]) : call.data })),
        blockNumber,
      );
    const plain = await simulate(false);
    const suffixed = await simulate(true);
    console.log(
      `${tokens.length} tokens at block ${blockNumber}: ${plain.filter((result) => result.startsWith("success:")).length}/${plain.length} calls succeed`,
    );
    expect(plain).toHaveLength(calls.length);
    expect(suffixed).toEqual(plain);
    // Every exact approval succeeds, with and without the suffix.
    for (let index = 0; index < plain.length; index += 3) expect(suffixed[index]?.startsWith("success:")).toBe(true);
  }, 60_000);
});
