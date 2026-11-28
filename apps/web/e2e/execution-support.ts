import type { Page } from "@playwright/test";
import type { Address } from "viem";
import { buildReadyPlan, fairPriceE8, NVDA, OPEN_MARKET_TIME, TSLA, USDC } from "./execution-plans";
import { TEST_ACCOUNT } from "./wallet-support";

/**
 * The executable plan the browser tests answer themselves: the server of the smoke tests replays recorded market
 * data and builds none. Shared by the execution review tests and the journeys.
 */
export const INDEX = "diversified-equity-d622e2a5";
export const ACCOUNT = TEST_ACCOUNT.toLowerCase() as Address;
/** Latest block time of the mocked chain: a minute into an open market session. */
export const CHAIN_TIME = OPEN_MARKET_TIME;

/** Feed answers at which the legs of the ready plan are quoted fairly. */
export function fairPrices(): Record<string, bigint> {
  return Object.fromEntries(readyPlan(CHAIN_TIME + 100).data.legs.map((leg) => [leg.token, fairPriceE8(leg)]));
}

/** A plan with a sell and a buy, ready to sign once its delayed price warning is acknowledged. */
export function readyPlan(expiresAt: number) {
  return buildReadyPlan({
    account: ACCOUNT,
    chainId: 8453,
    expiresAt,
    legs: [
      { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
      { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n },
    ],
    balances: { [USDC]: 250_500_000n, [NVDA]: 2_464_860_328n, [TSLA]: 456_555_856n },
    warnings: [["reference_freshness", "delayed", 1]],
  });
}

/** Answers every `POST /api/v1/portfolio/execution-plan` with `body`, and returns the request bodies seen. */
export async function answerPlan(page: Page, body: unknown, status = 200) {
  const requests: unknown[] = [];
  await page.route("**/api/v1/portfolio/execution-plan", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status, json: body });
  });
  return requests;
}
