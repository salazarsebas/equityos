import { describe, expect, test } from "bun:test";
import { type Address, decodeFunctionData, parseAbi } from "viem";
import { buildExecutionPlan, type ExecutionLeg } from "../../src/server/execution/plan";
import { USDC_ADDRESS } from "../../src/server/market/balances";
import { ACCOUNT, constructedProvider, FakeExecutionChain, NO_DEADLINE, OPEN_AT, OPEN_BUDGET } from "./support";

const approveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const CASES = 300;

/** Deterministic PRNG (mulberry32), so every run checks the same cases. */
function random(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const big = (min: bigint, max: bigint) => min + (BigInt(Math.floor(next() * 2 ** 48)) * (max - min)) / 2n ** 48n;
  return { int, big };
}

function token(index: number): Address {
  return `0xb2${index.toString(16).padStart(38, "0")}`;
}

describe("executable plan properties", () => {
  test(`over ${CASES} seeded plans: approvals never exceed swaps and buys never spend more than is guaranteed`, async () => {
    let ready = 0;
    let blockedByFunds = 0;
    for (let seed = 1; seed <= CASES; seed += 1) {
      const { int, big } = random(seed);
      const chain = new FakeExecutionChain();
      chain.usdc.balance = big(0n, 50_000_000n);
      chain.usdc.allowance = int(0, 3) === 0 ? big(0n, 50_000_000n) : 0n;
      const legs: ExecutionLeg[] = [];
      const count = int(1, 5);
      for (let index = 1; index <= count; index += 1) {
        const address = token(index);
        const priceE8 = big(1_000_000_000n, 100_000_000_000n);
        const side = int(0, 1) === 0 ? "sell" : "buy";
        const tokenQuantity = big(100_000n, 50_000_000n);
        const quoteAmount = big(1_000_000n, 30_000_000n);
        const held = side === "sell" ? tokenQuantity + big(0n, 1_000n) - big(0n, 1_000n) : 0n;
        chain.token(address, { balance: held, allowance: int(0, 3) === 0 ? big(0n, tokenQuantity * 2n) : 0n });
        legs.push({ side, token: address, decimals: 8, tokenQuantity, quoteAmount, priceE8, priceStatus: "live" });
      }
      // Sells before buys, as the reference plan orders them.
      legs.sort((a, b) => (a.side === b.side ? 0 : a.side === "sell" ? -1 : 1));
      const deviationBps = BigInt(int(-90, 90));
      const plan = await buildExecutionPlan(
        {
          provider: constructedProvider(legs, { deviationBps }).provider,
          client: chain.client(),
          now: () => OPEN_AT,
          providerBudget: OPEN_BUDGET,
          signal: NO_DEADLINE,
        },
        {
          account: ACCOUNT,
          reference: { status: "ready", legs },
          jurisdiction: { restricted: false, reason: "permitted_country", country: "DE" },
          slippageBps: int(0, 200),
          maxDeviationBps: 500,
          allowUnsimulated: false,
        },
      );
      const minimumFromSells = plan.legs.reduce(
        (sum, leg) => (leg.side === "sell" ? sum + (leg.quoted?.quote.minAmountOut ?? 0n) : sum),
        0n,
      );
      const buys = plan.legs.filter((leg) => leg.side === "buy").reduce((sum, leg) => sum + leg.amountIn, 0n);
      const fundable = chain.usdc.balance + minimumFromSells >= buys;
      if (plan.status !== "ready") {
        if (!fundable) blockedByFunds += 1;
        continue;
      }
      ready += 1;
      expect(fundable).toBe(true);
      const swapped = new Map<Address, bigint>();
      for (const leg of plan.legs) swapped.set(leg.tokenIn, (swapped.get(leg.tokenIn) ?? 0n) + leg.amountIn);
      const approved = new Map<Address, bigint>();
      for (const call of plan.calls ?? []) {
        if (call.kind !== "approve") continue;
        const [, amount] = decodeFunctionData({ abi: approveAbi, data: call.data }).args;
        expect(approved.has(call.to)).toBe(false);
        approved.set(call.to, amount);
      }
      for (const [address, amount] of approved) expect(amount).toBe(swapped.get(address) ?? -1n);
      for (const approval of plan.approvals) expect(approval.amount).toBe(swapped.get(approval.token) ?? -1n);
      expect(buys).toBeLessThanOrEqual(chain.usdc.balance + minimumFromSells);
      expect(plan.totals?.endBalances[0]).toEqual({
        token: USDC_ADDRESS,
        before: chain.usdc.balance,
        after: chain.usdc.balance + minimumFromSells - buys,
      });
      expect(plan.totals?.endBalances.every(({ after }) => after >= 0n)).toBe(true);
    }
    // Both outcomes occur, so the property is not vacuous.
    expect(ready).toBeGreaterThan(50);
    expect(blockedByFunds).toBeGreaterThan(20);
  });
});
