import { expect, type Page, test } from "@playwright/test";
import { buildBlockedPlan } from "./execution-plans";
import { ACCOUNT, answerPlan, CHAIN_TIME, fairPrices, readyPlan } from "./execution-support";
import { installMockWallet, mockBaseRpc, TEST_ACCOUNT } from "./wallet-support";

/**
 * Journeys: each one starts where a visitor starts and moves by the links and controls a visitor uses, never by
 * typing a URL, until the final state. The feature tests next to this file check each page in depth; these check
 * that the pages lead to each other.
 *
 * Covered here: verify an index, read the drift of a wallet and a plan, publish (up to the network check, the only
 * step this build without a chain can reach), publish a new version as the creator, execute with a mocked wallet,
 * a blocked plan, and the jurisdiction gate. Sending a transaction for real is covered against a local chain in
 * `e2e-chain`.
 */
const INDEX_NAME = "Diversified Equity";
const SPEC_HASH = "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6";

/** Console errors and uncaught exceptions: a journey that works must not log either. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function openIndexFromLanding(page: Page) {
  await page.goto("/");
  await page.getByRole("main").getByRole("link", { name: "Explore indexes" }).first().click();
  await expect(page).toHaveURL(/\/indexes$/);
  await page.getByRole("region", { name: "Published indexes" }).getByRole("link", { name: INDEX_NAME }).click();
  await expect(page.getByRole("heading", { level: 1, name: INDEX_NAME })).toBeVisible();
}

async function connectFromHeader(page: Page) {
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
  await expect(page.getByRole("banner").getByRole("button", { name: /^Account 0x/ })).toBeVisible();
}

test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

test("verify: from the landing page to an index whose five checks pass, matching what the API serves", async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  await openIndexFromLanding(page);
  const verification = page.getByRole("region", { name: "Verification" });
  await page.getByRole("link", { name: "Verification", exact: true }).click();
  await expect(page).toHaveURL(/#verification-heading$/);
  const checks = verification.getByRole("listitem");
  await expect(checks).toHaveCount(5);
  for (const check of await checks.all()) await expect(check).toContainText("Pass");
  await expect(checks.first()).toContainText(SPEC_HASH);

  // The JSON link of the composition is the API answer of this version, with the same hash.
  const json = page.getByRole("region", { name: "Composition of version 2" }).getByRole("link", { name: "JSON" });
  const href = (await json.getAttribute("href")) ?? "";
  expect(href).toMatch(/^\/api\/v1\/indexes\/0x[0-9a-f]{64}\/composition\?version=2$/);
  const api = await (await request.get(href.replace(/\/composition\?version=2$/, "/versions/2"))).json();
  expect(api.data.specHash).toBe(SPEC_HASH);
  expect(errors).toEqual([]);
});

test("drift: from an index to a wallet compared with it, then a buy-only plan with a deposit", async ({ page }) => {
  const errors = collectErrors(page);
  await openIndexFromLanding(page);
  await page.getByRole("link", { name: "Compare a wallet with this index" }).click();
  await expect(page.getByRole("combobox", { name: "Index" })).toHaveValue(/diversified-equity-d622e2a5/);
  await page.getByRole("textbox", { name: "Address" }).fill(TEST_ACCOUNT);
  await page.getByRole("button", { name: "Compare" }).click();
  await expect(
    page.getByRole("heading", { level: 2, name: /0xf39f\.\.\.2266 compared with Diversified Equity/ }),
  ).toBeVisible();
  await expect(page.getByTestId("threshold-status")).toContainText("Above threshold");

  await page.getByRole("radio", { name: "Buy only: never sells" }).check();
  await page.getByLabel("Deposit added before the plan (USD)").fill("500");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page).toHaveURL(/plan=buy_only&deposit=500$/);
  const legs = page.getByRole("region", { name: "Legs at reference prices" });
  await expect(legs.getByRole("rowheader")).toHaveText(["TSLAc", "MSTRc", "AAPLc", "AMZNc"]);
  await expect(legs.getByRole("row", { name: /Sell/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("publish: from the landing page to the review, which names the network check that blocks sending", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await page.getByRole("banner").getByRole("link", { name: "Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await page.getByLabel("Name", { exact: true }).fill("Chips and Platforms");
  for (const symbol of ["NVDAc", "INTCc", "MSFTc"]) {
    await page.getByRole("checkbox", { name: new RegExp(`^${symbol}`) }).check();
  }
  await page.getByRole("button", { name: "Review and publish" }).click();
  await expect(page.getByRole("heading", { name: "Review and publish" })).toBeVisible();
  await expect(page.getByText("createIndex(salt, spec, tokens, weightsBps)")).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Preconditions" }).getByRole("listitem").filter({ hasText: "Registry on Base" }),
  ).toHaveAttribute("data-state", "blocked");
  await page.getByRole("button", { name: "Back to the editor" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Chips and Platforms");
  expect(errors).toEqual([]);
});

test("new version: the creator connects on the index page, opens the Studio from it and sees the changes", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await installMockWallet(page, { chainId: 8453 });
  await openIndexFromLanding(page);
  await expect(page.getByRole("link", { name: "Publish a new version" })).toHaveCount(0);
  await connectFromHeader(page);
  await page.getByRole("link", { name: "Publish a new version" }).click();
  await expect(page).toHaveURL(/\/studio\?index=diversified-equity-d622e2a5$/);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(INDEX_NAME);
  await expect(page.getByText("based on version 2, its latest, verified in this browser")).toBeVisible();
  await page.getByLabel("Weight of AAPLc").fill("20");
  await page.getByLabel("Weight of AMZNc").fill("20");
  await expect(page.getByRole("list", { name: "Changes from version 2" }).getByRole("listitem")).toHaveText([
    "2 weights changed",
  ]);
  await expect(page.getByRole("button", { name: "Publishing is not available" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(errors).toEqual([]);
});

test.describe("execute", () => {
  async function openExecution(page: Page) {
    await installMockWallet(page, { chainId: 8453, rejectSend: true });
    await mockBaseRpc(page, {}, { blockTimestamp: CHAIN_TIME, prices: fairPrices() });
    await openIndexFromLanding(page);
    await page.getByRole("link", { name: "Compare a wallet with this index" }).click();
    await page.getByRole("textbox", { name: "Address" }).fill(TEST_ACCOUNT);
    await page.getByRole("button", { name: "Compare" }).click();
    const panel = page.getByRole("region", { name: "Execute from your wallet" });
    await panel.getByRole("button", { name: "Connect wallet" }).click();
    await page
      .getByRole("dialog", { name: "Connect a wallet" })
      .getByRole("button", { name: /Test Wallet/ })
      .click();
    return panel;
  }

  test("a ready plan is reviewed, its warning acknowledged, signed and declined in the wallet, and nothing is sent", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    const requests = await answerPlan(page, readyPlan(CHAIN_TIME + 100));
    await openExecution(page);
    await page.getByRole("button", { name: "Prepare to execute" }).click();
    const review = page.getByRole("region", { name: "Review the executable plan" });
    await expect(review.getByRole("region", { name: "Calls you would sign" }).getByRole("rowheader")).toHaveText([
      "Approve NVDAc",
      "Approve USDC",
      "Sell NVDAc",
      "Buy TSLAc",
    ]);
    const sign = page.getByRole("button", { name: /^Sign \d+ (calls|transactions) in your wallet/ });
    await expect(sign).toHaveAttribute("aria-disabled", "true");
    await review.getByRole("checkbox", { name: /^I acknowledge this warning\./ }).check();
    await sign.click();
    const declined = page.getByRole("status").filter({ hasText: "You declined the request in the wallet." });
    await expect(declined).toContainText("Nothing was sent");
    await declined.getByRole("button", { name: "Back to the review" }).click();
    await expect(sign).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test("a blocked plan offers nothing to sign, says what blocks it and offers a new plan", async ({ page }) => {
    await answerPlan(page, buildBlockedPlan(ACCOUNT, 8453));
    await openExecution(page);
    await page.getByRole("button", { name: "Prepare to execute" }).click();
    const review = page.getByRole("region", { name: "Review the executable plan" });
    await expect(review.getByRole("alert")).toContainText("The plan is blocked: no call can be signed.");
    await expect(page.getByRole("button", { name: /^Sign / })).toHaveCount(0);
    await expect(review.getByRole("button", { name: "Get a new plan" })).toBeVisible();
  });
});

test.describe("from a restricted region", () => {
  test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "US" } });

  test("the comparison still works, and execution says it is unavailable without asking for anything", async ({
    page,
  }) => {
    const requests = await answerPlan(page, readyPlan(CHAIN_TIME + 100));
    await openIndexFromLanding(page);
    await page.getByRole("link", { name: "Compare a wallet with this index" }).click();
    await page.getByRole("textbox", { name: "Address" }).fill(TEST_ACCOUNT);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page.getByTestId("threshold-status")).toContainText("Above threshold");
    await expect(page.getByRole("region", { name: "Execute from your wallet" })).toContainText(
      "Execution is not available in your region.",
    );
    await expect(page.getByRole("button", { name: "Prepare to execute" })).toHaveCount(0);
    expect(requests).toEqual([]);
  });
});
