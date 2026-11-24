import { expect, type Page, test } from "@playwright/test";
import type { Address } from "viem";
import { buildBlockedPlan, buildReadyPlan, fairPriceE8, NVDA, OPEN_MARKET_TIME, TSLA, USDC } from "./execution-plans";
import { installMockWallet, mockBaseRpc, TEST_ACCOUNT } from "./wallet-support";

/**
 * The review states of an executable plan, without a chain. The server of these tests replays recorded market
 * data and builds no executable plan, so each test answers `POST /api/v1/portfolio/execution-plan` itself
 * with a plan of `execution-plans.ts`, and the Base mainnet endpoint with `mockBaseRpc`, whose feeds answer the
 * price at which each leg's quote is fair, a minute before a latest block in an open session. Nothing is sent.
 */
const INDEX = "diversified-equity-d622e2a5";
const ACCOUNT = TEST_ACCOUNT.toLowerCase() as Address;
const CHAIN_TIME = OPEN_MARKET_TIME;

/** Feed answers at which the legs of the ready plan are quoted fairly. */
function fairPrices(): Record<string, bigint> {
  return Object.fromEntries(readyPlan(CHAIN_TIME + 100).data.legs.map((leg) => [leg.token, fairPriceE8(leg)]));
}

function readyPlan(expiresAt: number) {
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

async function answerPlan(page: Page, body: unknown, status = 200) {
  const requests: unknown[] = [];
  await page.route("**/api/v1/portfolio/execution-plan", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status, json: body });
  });
  return requests;
}

async function openReview(page: Page, prices: Record<string, bigint> = fairPrices()) {
  await installMockWallet(page, { chainId: 8453, rejectSend: true });
  await mockBaseRpc(page, {}, { blockTimestamp: CHAIN_TIME, prices });
  await page.goto(`/portfolio?address=${TEST_ACCOUNT}&index=${INDEX}`);
  const panel = page.getByRole("region", { name: "Execute from your wallet" });
  await panel.getByRole("button", { name: "Connect wallet" }).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
  await page.getByRole("button", { name: "Prepare to execute" }).click();
  return page.getByRole("region", { name: "Review the executable plan" });
}

const signButton = (page: Page) => page.getByRole("button", { name: /^Sign \d+ (calls|transactions) in your wallet/ });

test.describe("execution review", () => {
  test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

  test("a ready plan shows every call, the totals and checks, and signs only once each warning is acknowledged", async ({
    page,
  }) => {
    const requests = await answerPlan(page, readyPlan(CHAIN_TIME + 100));
    const review = await openReview(page);
    expect(requests).toEqual([{ address: ACCOUNT, index: "diversified-equity-d622e2a5", mode: "rebalance" }]);
    const calls = review.getByRole("region", { name: "Calls you would sign" });
    await expect(calls.getByRole("rowheader")).toHaveText(["Approve NVDAc", "Approve USDC", "Sell NVDAc", "Buy TSLAc"]);
    await expect(calls.getByRole("row", { name: /Approve NVDAc/ })).toContainText("Exactly 4 NVDAc to the router");
    await expect(calls.getByRole("row", { name: /Sell NVDAc/ })).toContainText("for at least 516.405 USDC");
    // The worst price against the feed read in the browser, and the route deadline decoded from the calldata.
    await expect(calls.getByRole("row", { name: /Sell NVDAc/ })).toContainText(
      "Reference 129.75 USD a token, read in this browser from its feed (live): the minimum is 0.50% worse than it",
    );
    await expect(calls.getByRole("row", { name: /Sell NVDAc/ })).toContainText(
      `Reverts after ${new Date((CHAIN_TIME + 100) * 1000).toISOString().replace(".000Z", "Z")}`,
    );
    await expect(review).toContainText(
      "Index id 0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610, version 2",
    );
    await expect(review).toContainText("The rebalance log is not deployed on this network");
    await expect(review.getByRole("region", { name: "Expected balances at minimum amounts out" })).toContainText(
      "466.905",
    );
    await expect(review.getByRole("list", { name: "Pre-trade checks" })).toContainText(
      "reference_freshness warn: delayed",
    );
    for (const statement of [
      "differ from the reference prices",
      "Nothing here is advice",
      "sign every call in your own wallet",
    ]) {
      await expect(review).toContainText(statement);
    }
    await expect(review.getByTestId("plan-expiry")).toContainText("Expires in");
    // The button exists but cannot sign until the warning is acknowledged.
    await expect(signButton(page)).toHaveText("Sign 4 calls in your wallet");
    await expect(signButton(page)).toHaveAttribute("aria-disabled", "true");
    await expect(review.getByTestId("send-refusal")).toContainText("Acknowledge every warning above");
    await review.getByRole("checkbox", { name: /reference_freshness: delayed for TSLAc/ }).check();
    await expect(signButton(page)).not.toHaveAttribute("aria-disabled", "true");

    // Declining in the wallet is calm: nothing was sent, and the same plan can be reviewed again.
    await signButton(page).click();
    const declined = page.getByRole("status").filter({ hasText: "You declined the request in the wallet." });
    await expect(declined).toContainText("Nothing was sent");
    await declined.getByRole("button", { name: "Back to the review" }).click();
    await expect(signButton(page)).toBeVisible();
  });

  test("a sale at a price the feed read in the browser contradicts is refused, whatever the plan says", async ({
    page,
  }) => {
    await answerPlan(page, readyPlan(CHAIN_TIME + 100));
    // The plan sells 4 NVDAc for at least 516.405 USDC; the feed read in the browser answers 134 USD a token.
    const review = await openReview(page, { ...fairPrices(), [NVDA]: 13_400_000_000n });
    await expect(review.getByRole("alert")).toContainText("This browser refused the plan.");
    await expect(review.getByRole("alert")).toContainText("further from the reference price read in this browser");
    await expect(review.getByRole("alert")).toContainText("price_out_of_bounds");
    await expect(signButton(page)).toHaveCount(0);
  });

  test("an allowance already above the plan is shown with how to reduce it, and is not approved again", async ({
    page,
  }) => {
    const plan = buildReadyPlan({
      account: ACCOUNT,
      chainId: 8453,
      expiresAt: CHAIN_TIME + 100,
      legs: [{ side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n }],
      balances: { [USDC]: 250_500_000n },
      allowances: { [USDC]: 2n ** 256n - 1n },
    });
    await answerPlan(page, plan);
    // The same buy as the ready plan, so the same fair feed price.
    const review = await openReview(page);
    const calls = review.getByRole("region", { name: "Calls you would sign" });
    await expect(calls.getByRole("rowheader")).toHaveText(["Buy TSLAc"]);
    const callout = review.getByText("Your wallet already allows the router to spend more than this plan swaps.");
    await expect(callout).toBeVisible();
    await expect(review).toContainText("USDC: allowed an unlimited amount, this plan swaps 300 USDC");
    await expect(review).toContainText("approve a lower amount, or zero, for this spender");
  });

  test("a blocked plan offers nothing to sign and says what blocks it", async ({ page }) => {
    await answerPlan(page, buildBlockedPlan(ACCOUNT, 8453));
    const review = await openReview(page);
    await expect(review.getByRole("alert")).toContainText("The plan is blocked: no call can be signed.");
    await expect(review.getByRole("alert")).toContainText("reference_freshness last_close (NVDAc)");
    await expect(signButton(page)).toHaveCount(0);
    await expect(review.getByRole("button", { name: "Get a new plan" })).toBeVisible();
  });

  test("a plan past its expiry by chain time cannot be signed, whatever the device clock says", async ({ page }) => {
    // Expired by 10 seconds at the latest block. The device clock is years before it.
    const requests = await answerPlan(page, readyPlan(CHAIN_TIME - 10));
    const review = await openReview(page);
    await expect(review.getByTestId("plan-expiry")).toHaveText("This plan expired by the time of the latest block.");
    await expect(signButton(page)).toHaveCount(0);
    await review.getByRole("button", { name: "Get a new plan" }).click();
    await expect.poll(() => requests.length).toBe(2);
  });

  test("a plan whose hash does not match the calls is refused in the browser", async ({ page }) => {
    const plan = readyPlan(CHAIN_TIME + 100);
    plan.data.planHash = `0x${"ab".repeat(32)}`;
    await answerPlan(page, plan);
    const review = await openReview(page);
    await expect(review.getByRole("alert")).toContainText("The plan hash does not match. Nothing can be signed.");
    await expect(signButton(page)).toHaveCount(0);
  });

  test("calldata that does not verify in the browser is refused with the reason", async ({ page }) => {
    const plan = readyPlan(CHAIN_TIME + 100);
    const leg = plan.data.legs[0];
    if (leg !== undefined) leg.quote.minAmountOut = "1";
    await answerPlan(page, plan);
    const review = await openReview(page);
    await expect(review.getByRole("alert")).toContainText("This browser refused the plan.");
    await expect(review.getByRole("alert")).toContainText("decoded minimum or deadline differs");
    await expect(signButton(page)).toHaveCount(0);
  });

  test("a server that builds no plan is stated as such, and nothing is signed", async ({ page }) => {
    await answerPlan(
      page,
      {
        error: { status: 409, code: "execution_unavailable", message: "x", details: { reason: "market_data_replay" } },
      },
      409,
    );
    await installMockWallet(page, { chainId: 8453 });
    await mockBaseRpc(page, {}, { blockTimestamp: CHAIN_TIME, prices: fairPrices() });
    await page.goto(`/portfolio?address=${TEST_ACCOUNT}&index=${INDEX}`);
    await page
      .getByRole("region", { name: "Execute from your wallet" })
      .getByRole("button", { name: "Connect wallet" })
      .click();
    await page
      .getByRole("dialog", { name: "Connect a wallet" })
      .getByRole("button", { name: /Test Wallet/ })
      .click();
    await page.getByRole("button", { name: "Prepare to execute" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "serves recorded market data" })).toBeVisible();
  });
});

test.describe("where execution is unavailable", () => {
  test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "US" } });

  test("the review cannot be reached and the reason is shown", async ({ page }) => {
    const requests = await answerPlan(page, readyPlan(CHAIN_TIME + 100));
    await installMockWallet(page, { chainId: 8453 });
    await mockBaseRpc(page, {}, { blockTimestamp: CHAIN_TIME, prices: fairPrices() });
    await page.goto(`/portfolio?address=${TEST_ACCOUNT}&index=${INDEX}`);
    const panel = page.getByRole("region", { name: "Execute from your wallet" });
    await expect(panel).toContainText("Execution is not available in your region.");
    await expect(page.getByRole("button", { name: "Prepare to execute" })).toHaveCount(0);
    expect(requests).toEqual([]);
  });
});
