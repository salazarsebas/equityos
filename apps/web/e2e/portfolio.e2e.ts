import { expect, type Page, test } from "@playwright/test";
import { NOT_DEPLOYED_ORIGIN } from "./servers";
import { installMockWallet, TEST_ACCOUNT } from "./wallet-support";

/** The recorded registry and the constructed balances of `test/fixtures/market/balances.json`. */
const INDEX = "diversified-equity-d622e2a5";
const ABOVE = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const EMPTY = "0x0000000000000000000000000000000000001003";
const ON_TARGET = "0x0000000000000000000000000000000000001001";
const ONLY_USDC = "0x0000000000000000000000000000000000001004";
const MISMATCHED = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const driftTable = (page: Page) => page.getByRole("region", { name: "Drift against the target weights" });
const legs = (page: Page) => page.getByRole("region", { name: "Legs at reference prices" });

// The geolocation header a deployment receives from its platform.
test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

test.describe("portfolio page", () => {
  test("the entry state offers the verified indexes and an address, and the GET form fills the URL", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
    await expect(page.getByText("Balances on this server are constructed test data")).toBeVisible();
    const select = page.getByLabel("Index");
    await expect(select.locator("option")).toHaveText([
      "Choose an index",
      "Diversified Equity",
      "Semiconductors Fixed Weight",
      "Large Technology Equal Weight",
    ]);
    await expect(page.getByText("Choose an index and an address")).toBeVisible();
    await select.selectOption(INDEX);
    await page.getByLabel("Address").fill(ON_TARGET);
    await page.getByRole("button", { name: "Compare" }).click();
    await expect(page).toHaveURL(`/portfolio?index=${INDEX}&address=${ON_TARGET}`);
    await expect(page.getByTestId("threshold-status")).toHaveText("Within threshold: the largest drift is 0.00 pp.");
    expect(errors).toEqual([]);
  });

  test("a wallet above the threshold: facts, drift table, holdings outside the index and the plan", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto(`/portfolio?address=${ABOVE}&index=${INDEX}`);
    await expect(
      page.getByRole("heading", { level: 2, name: /0xf39f\.\.\.2266 compared with Diversified Equity/ }),
    ).toBeVisible();
    await expect(page.getByTestId("threshold-status")).toHaveText(
      "Above threshold by 10.00 pp: NVDAc is 15.00 pp above its target weight.",
    );
    const table = driftTable(page);
    await expect(table.getByRole("rowheader")).toHaveText([/^NVDAc/, /^TSLAc/, /^AAPLc/, /^MSTRc/, /^AMZNc/, "Total"]);
    await expect(table.getByRole("row", { name: /NVDAc/ }).getByRole("cell")).toHaveText([
      "25.00%",
      "40.00%",
      "+15.00",
      "",
      "24.6486",
      "129.82",
      "3,200.00",
    ]);
    await expect(table.getByRole("row", { name: /Total/ })).toContainText("8,000.00");
    await expect(table).toContainText("Market closed");
    const outside = page.getByRole("region", { name: "Held outside this index" });
    await expect(outside.getByRole("rowheader")).toHaveText(["METAc", "MSFTc"]);
    await expect(page.getByText("they are not counted", { exact: false })).toBeVisible();
    await expect(legs(page).getByRole("rowheader")).toHaveText(["NVDAc", "TSLAc", "MSTRc", "AAPLc", "AMZNc"]);
    await expect(legs(page).getByRole("row", { name: /NVDAc/ })).toContainText("Sell");
    await expect(page.getByText("it is not an instruction to trade")).toBeVisible();
    await expect(page.getByText("Executing a plan is not available on this site.")).toBeVisible();
    // Nothing on the page offers to trade.
    await expect(page.getByRole("button", { name: /execute|swap|trade|buy|sell|deposit|invest/i })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("buy only with a deposit is kept in the URL and survives a reload", async ({ page }) => {
    await page.goto(`/portfolio?address=${ABOVE}&index=${INDEX}`);
    await page.getByRole("radio", { name: "Buy only: never sells" }).check();
    const deposit = page.getByLabel("Deposit added before the plan (USD)");
    await deposit.fill("12,50");
    await expect(page.getByText("Use digits with an optional decimal point")).toBeVisible();
    await deposit.fill("500");
    await page.getByRole("button", { name: "Calculate" }).click();
    await expect(page).toHaveURL(/plan=buy_only&deposit=500$/);
    await expect(legs(page).getByRole("row", { name: /Sell/ })).toHaveCount(0);
    await expect(legs(page).getByRole("rowheader")).toHaveText(["TSLAc", "MSTRc", "AAPLc", "AMZNc"]);
    await page.reload();
    await expect(page.getByRole("radio", { name: "Buy only: never sells" })).toBeChecked();
    await expect(page.getByLabel("Deposit added before the plan (USD)")).toHaveValue("500");
    await expect(legs(page).getByRole("rowheader")).toHaveText(["TSLAc", "MSTRc", "AAPLc", "AMZNc"]);
  });

  test("an empty wallet lists every constituent at zero, and a small deposit is blocked with the minimum", async ({
    page,
  }) => {
    await page.goto(`/portfolio?address=${EMPTY}&index=${INDEX}&plan=buy_only&deposit=2`);
    await expect(driftTable(page).getByRole("rowheader")).toHaveCount(6);
    await expect(page.getByTestId("threshold-status")).toContainText("No drift: nothing is invested");
    await expect(page.getByText("No plan: the arithmetic is blocked, so no leg is listed.")).toBeVisible();
    await expect(page.getByText(/from 10\.05 USD, each constituent gets a buy/)).toBeVisible();
    await expect(page.getByText("below_minimum_portfolio_value")).toBeVisible();
    await expect(legs(page)).toHaveCount(0);
  });

  test("an older version says that a newer one exists and links to it", async ({ page }) => {
    await page.goto(`/portfolio?address=${ONLY_USDC}&index=${INDEX}&version=1`);
    await expect(page.getByText("Version 2 of this index is published. This comparison uses version 1.")).toBeVisible();
    await page.getByRole("link", { name: "Compare with version 2" }).click();
    await expect(page).toHaveURL(`/portfolio?address=${ONLY_USDC}&index=${INDEX}`);
  });

  test("a version that fails verification is refused with the reason", async ({ page }) => {
    await page.goto(`/portfolio?address=${ABOVE}&index=${MISMATCHED}`);
    const refused = page.getByRole("alert").filter({ hasText: "fails verification" });
    await expect(refused).toContainText("Version 1 of this index fails verification, so it is not compared.");
    await expect(refused).toContainText("It fails check C5.");
  });

  test("a connected wallet fills the address, which the URL then carries", async ({ page }) => {
    await installMockWallet(page, { chainId: 8453 });
    await page.goto(`/portfolio?index=${INDEX}`);
    await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
    await page
      .getByRole("dialog", { name: "Connect a wallet" })
      .getByRole("button", { name: /Test Wallet/ })
      .click();
    await expect(page.getByText("Connected wallet")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`address=${TEST_ACCOUNT}`));
    await expect(page.getByTestId("threshold-status")).toContainText("Above threshold by 10.00 pp");
  });

  test("the index profile links to the comparison with the index filled in", async ({ page }) => {
    await page.goto(`/indexes/${INDEX}`);
    await page.getByRole("link", { name: "Compare a wallet with this index" }).click();
    await expect(page).toHaveURL(`/portfolio?index=${INDEX}`);
    await expect(page.getByLabel("Index")).toHaveValue(INDEX);
  });

  test("the comparison has no horizontal overflow at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/portfolio?address=${ABOVE}&index=${INDEX}`);
    await expect(legs(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("a network without the registry says so, as the explorer does", async ({ page }) => {
    await page.goto(`${NOT_DEPLOYED_ORIGIN}/portfolio?index=${INDEX}&address=${ABOVE}`);
    await expect(page.getByText("The index registry is not deployed on Base yet")).toBeVisible();
    await expect(page.getByLabel("Index")).toHaveCount(0);
  });
});

test.describe("portfolio API on the replay", () => {
  test("compares a constructed wallet and says where each input was read", async ({ request }) => {
    const response = await request.get(`/api/v1/portfolio?address=${ABOVE}&index=${INDEX}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["x-equityos-api-version"]).toBe("1.2.0");
    const { data, meta } = await response.json();
    expect(data.drift).toMatchObject({ maxAbsDriftBps: 1500, thresholdReached: true });
    expect(meta.registry).toMatchObject({ chainId: 31_337, mode: "replay" });
    expect(meta.balances).toEqual({
      chainId: 8453,
      blockNumber: "60489401",
      blockTimestamp: "2026-11-21T19:10:55Z",
      mode: "replay",
    });
  });

  test("the plan states that it is not a quote, and a blocked plan has no legs", async ({ request }) => {
    const ready = await (
      await request.get(`/api/v1/portfolio/plan?address=${ABOVE}&index=${INDEX}&mode=rebalance`)
    ).json();
    expect(ready.data).toMatchObject({ executable: false, priceBasis: "reference", plan: { status: "ready" } });
    const blocked = await (
      await request.get(`/api/v1/portfolio/plan?address=${EMPTY}&index=${INDEX}&mode=buy_only&depositUsdE8=200000000`)
    ).json();
    expect(blocked.data.plan.status).toBe("blocked");
    expect(blocked.data.plan.legs).toBeUndefined();
  });

  test("a chain without the registry answers 409", async ({ request }) => {
    const response = await request.get(`${NOT_DEPLOYED_ORIGIN}/api/v1/portfolio?address=${ABOVE}&index=${INDEX}`);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe("registry_not_deployed");
  });
});
