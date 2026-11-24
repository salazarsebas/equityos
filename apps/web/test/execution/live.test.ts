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
import { type Address, createPublicClient, http, isAddress, parseAbi } from "viem";
import { createKyberSwapProvider, resolveClientId } from "../../src/server/execution/kyberswap";
import { buildExecutionPlan, type ExecutionLeg } from "../../src/server/execution/plan";
import { POLICY_SCOPES, readPreTrade } from "../../src/server/execution/reads";
import { KYBERSWAP_ROUTER, minimumAmountOut, verifyQuote } from "../../src/server/execution/router";
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

  test("the allowlisted router is deployed on Base and the pinned policy scopes are the token's", async () => {
    expect((await client.getCode({ address: KYBERSWAP_ROUTER }))?.length ?? 0).toBeGreaterThan(1_000);
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
      const answer = await provider.quote(request);
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
      { provider, client, now },
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
});
