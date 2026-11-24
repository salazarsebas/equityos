import { expect, type Page, test } from "@playwright/test";
import { EMPTY_REGISTRY_ORIGIN, NOT_DEPLOYED_ORIGIN } from "./servers";

/** Collects console errors and uncaught exceptions for the lifetime of the page. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The value of the headline figure whose label links to its definition. */
function stat(page: Page, label: string) {
  return page
    .locator("dl > div")
    .filter({ has: page.getByRole("link", { name: label, exact: true }) })
    .locator("dd");
}

async function expectNoOverflow(page: Page, url: string): Promise<void> {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(url);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Every definition the API returns is rendered on the page under its id, with its title. */
async function expectEveryDefinition(page: Page, origin: string): Promise<void> {
  const api = await page.request.get(`${origin}/api/v1/network`);
  const definitions: { id: string; title: string }[] =
    api.status() === 200
      ? (await api.json()).data.definitions
      : // Without a registry the API answers 409: the page still lists the rules it would apply.
        await page
          .locator("dl > div[id]")
          .evaluateAll((items) =>
            items.map((item) => ({ id: item.id, title: item.querySelector("dt")?.textContent ?? "" })),
          );
  expect(definitions.length).toBe(15);
  for (const { id, title } of definitions) {
    await expect(page.locator(`[id="${id}"] dt`)).toHaveText(title);
  }
}

test.describe("network page on the recorded local chain", () => {
  test("shows the headline figures from chain events, says the data is a recording, and lists each attestation", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/network");
    await expect(page.getByRole("heading", { level: 1, name: "Network" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "Recorded example data, not a live network" })).toBeVisible();
    await expect(page.getByText("blocks 0 to 29").first()).toBeVisible();

    await expect(stat(page, "Published indexes")).toHaveText("5");
    await expect(stat(page, "Index versions")).toHaveText("6");
    await expect(stat(page, "Attestations with matching flows (tier A)")).toHaveText("2");
    await expect(stat(page, "Distinct accounts (tier A)")).toHaveText("2");
    await expect(stat(page, "Accounts within tolerance")).toHaveText("1");
    await expect(stat(page, "Reference value moved (tier A)")).toHaveText("1,300.00USD");
    await expect(page.getByText("Not in the figures above: 1 linked (tier B) and 2 unmatched")).toBeVisible();
    await expect(page.getByText("every feed answers 100.00 USD")).toBeVisible();
    await expect(page.getByText("A daily series is drawn once they span at least 7 days.").first()).toBeVisible();

    const indexes = page.getByRole("region", { name: "Indexes by distinct accounts" });
    await expect(indexes.locator("tbody tr")).toHaveCount(3);
    await expect(indexes.locator("tbody tr").first()).toContainText("Semiconductors Fixed Weight");
    const attestations = page.getByRole("region", { name: "Most recent attestations" });
    await expect(attestations.locator("tbody tr")).toHaveCount(5);
    await expect(attestations).toContainText("A, within tolerance");
    await expect(attestations).toContainText("Unmatched, below 1.00 USD");

    await expect(page.getByText("0x5eed00000000000000000000000000000000000e")).toBeVisible();
    await expect(page.getByText("Local seed test account")).toBeVisible();
    await expect(page.getByText(/attestations of tier A 1, tier B 0, unmatched 0/)).toBeVisible();
    await expect(
      page.getByText("Connected wallets, page views and API requests are never counted.", { exact: false }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("every figure opens its definition, and every definition is on the page", async ({ page, baseURL }) => {
    await page.goto("/network");
    await page.getByRole("link", { name: "Distinct accounts (tier A)" }).click();
    await expect(page).toHaveURL(/#usage\.accounts_tier_a$/);
    await expect(page.locator('[id="usage.accounts_tier_a"]')).toBeInViewport();
    await expectEveryDefinition(page, baseURL ?? "");
  });

  test("has no horizontal overflow at 375 px", async ({ page }) => {
    await expectNoOverflow(page, "/network");
  });

  test("the current state on the landing page links to it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Network activity, from chain events" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Network" })).toBeVisible();
  });

  test("the API serves the same figures and says it is a replay", async ({ request }) => {
    const response = await request.get("/api/v1/network");
    expect(response.status()).toBe(200);
    const { data, meta } = await response.json();
    expect(meta.registry.mode).toBe("replay");
    expect(data.metrics.attestationsTierA.value).toBe(2);
    expect(data.metrics.tierAReferenceValueUsdE8.value).toBe("130000000000");
    expect(data.exclusions).toEqual([
      { address: "0x5eed00000000000000000000000000000000000e", label: "Local seed test account" },
    ]);
  });
});

test.describe("network page without usage or without a registry", () => {
  test("a deployed registry without attestations says so instead of showing usage zeros", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`${EMPTY_REGISTRY_ORIGIN}/network`);
    await expect(stat(page, "Published indexes")).toHaveText("0");
    await expect(page.getByText("No rebalance attestation has been recorded in blocks 0 to 2.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Most recent attestations" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("where the registry is not deployed, the page says so and shows no figure", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`${NOT_DEPLOYED_ORIGIN}/network`);
    await expect(page.getByText("The index registry is not deployed on Base yet")).toBeVisible();
    await expect(page.locator("dd.num")).toHaveCount(0);
    await expectEveryDefinition(page, NOT_DEPLOYED_ORIGIN);
    const api = await page.request.get(`${NOT_DEPLOYED_ORIGIN}/api/v1/network`);
    expect(api.status()).toBe(409);
    expect((await api.json()).error.code).toBe("registry_not_deployed");
    expect(errors).toEqual([]);
  });

  test("has no horizontal overflow at 375 px", async ({ page }) => {
    await expectNoOverflow(page, `${NOT_DEPLOYED_ORIGIN}/network`);
  });
});
