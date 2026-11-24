import { existsSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { NOT_DEPLOYED_ORIGIN } from "./servers";

const SECTIONS = [
  "An index is a rule set, not a fund",
  "Verify it yourself",
  "Current state, with its sources",
  "Compare a wallet with an index",
  "Build on it",
  "What it is not",
];

/** Index id of the newest index of the recorded registry, Diversified Equity. */
const NEWEST_INDEX_ID = "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The value of the stat with this label. */
function stat(region: Locator, label: string): Locator {
  return region
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator("xpath=following-sibling::dd");
}

test("renders the headline and every section in order, with one h1 and no console errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Open, verifiable indexes for tokenized stocks on Base",
  );
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();
  expect(headings).toEqual(SECTIONS);
  for (const name of SECTIONS) await expect(page.getByRole("region", { name })).toBeVisible();
  // Heading levels never skip: every h3 follows an h2.
  const levels = await page
    .locator("main :is(h1, h2, h3, h4)")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.tagName.slice(1))));
  for (const [index, level] of levels.entries()) {
    expect(level - (levels[index - 1] ?? 0)).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test("has a description, Open Graph and Twitter metadata, and alt text on every image", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("EquityOS: open, verifiable indexes for tokenized stocks on Base");
  const meta = (selector: string) => page.locator(selector).getAttribute("content");
  expect(await meta('meta[name="description"]')).toContain("published rule set");
  expect(await meta('meta[property="og:title"]')).toContain("open, verifiable indexes");
  expect(await meta('meta[name="twitter:card"]')).toBe("summary_large_image");
  const image = await meta('meta[property="og:image"]');
  expect(image).toContain("/opengraph-image");
  expect(await meta('meta[property="og:image:alt"]')).toContain("EquityOS");
  const response = await request.get(new URL(image ?? "", "http://placeholder").pathname);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  const images = page.locator("img");
  for (const img of await images.all()) expect(await img.getAttribute("alt")).toBeTruthy();
});

test("the example document is a core test vector with its computed hash and weights", async ({ page }) => {
  await page.goto("/");
  const section = page.getByRole("region", { name: "An index is a rule set, not a fund" });
  await expect(section.locator("pre")).toContainText('{"calc":"equityos.calc/1","chainId":8453');
  await expect(section).toContainText("0x0303f9e547c0c4b543d9c661f47bb6867f9048fbbd4bd66b8c37a88e4b3680e3");
  await expect(section).toContainText("33.34%, 33.33%, 33.33%");
  await expect(section).toContainText("Test vector equal-3 of @equityos/core, 642 bytes");
});

test("the live data strip shows the recorded numbers with their sources and times", async ({ page }) => {
  await page.goto("/");
  const live = page.getByRole("region", { name: "Current state, with its sources" });
  await expect(live.getByRole("note")).toContainText("recorded data, not current data");
  await expect(stat(live, "Tokenized stocks listed")).toHaveText("17");
  await expect(stat(live, "Minted onchain")).toHaveText("14");
  await expect(stat(live, "Index-eligible")).toHaveText("13");
  await expect(stat(live, "US equity market")).toHaveText("Closed");
  await expect(live).toContainText("Coinbase tokenized stocks API and Base mainnet block 60,489,401");
  await expect(live.getByText("as of 2026-11-21 19:10 UTC").first()).toBeVisible();
  await expect(stat(live, "Published indexes")).toHaveText("5");
  await expect(stat(live, "Newest index")).toHaveText("Diversified Equity");
  await expect(live).toContainText(
    "IndexRegistry 0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c on Local development chain",
  );
  await expect(live.getByText("as of 2026-11-16 14:00 UTC")).toBeVisible();
});

test("the verification commands name the newest index, and the compare command works on this origin", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const verify = page.getByRole("region", { name: "Verify it yourself" });
  const commands = await verify.locator("pre").allTextContents();
  expect(commands).toHaveLength(3);
  expect(commands[0]).toContain(`"specOf(bytes32,uint32)(bytes)" ${NEWEST_INDEX_ID} 2 --rpc-url http://127.0.0.1:8545`);
  expect(commands[1]).toMatch(/\| cast keccak$/);
  const path = new URL((commands[2] ?? "").replace(/^curl -s /, "")).pathname;
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  expect((await response.json()).data.specHash).toBe(
    "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6",
  );
  await verify.getByRole("link", { name: "Diversified Equity" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Diversified Equity");
});

test("the API example and every link on the page resolve", async ({ page, request }) => {
  await page.goto("/");
  const developers = page.getByRole("region", { name: "Build on it" });
  const curl = (await developers.locator("pre").textContent()) ?? "";
  const api = new URL(curl.replace(/^curl -s "|"$/g, ""));
  const assets = await request.get(`${api.pathname}${api.search}`);
  expect(assets.status()).toBe(200);
  expect((await assets.json()).data).toHaveLength(13);

  const hrefs = await page
    .locator("main a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(5);
  for (const href of new Set(hrefs)) {
    if (href === null) continue;
    const repository = "https://github.com/salazarsebas/equityos/blob/main/";
    if (href.startsWith(repository)) {
      // Documentation links point into this repository: the file must exist at that path.
      expect(existsSync(new URL(`../../../${href.slice(repository.length)}`, import.meta.url)), href).toBe(true);
      continue;
    }
    expect(href.startsWith("/"), href).toBe(true);
    expect((await request.get(href)).status(), href).toBe(200);
  }
});

test("the secondary action and the API reference link lead to the developer pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Read the API docs" })).toHaveAttribute("href", "/developers");
  await expect(page.getByRole("link", { name: "API reference" })).toHaveAttribute("href", "/developers/api");
});

test("execution is stated as not available, from the status of this release", async ({ page, request }) => {
  const status = await (await request.get("/api/v1/status")).json();
  await page.goto("/");
  const holder = page.getByRole("region", { name: "Compare a wallet with an index" });
  if (status.data.executionUnavailableReason === "not_released") {
    await expect(holder).toContainText("Executing trades is not available on this site yet.");
  }
  await expect(page.getByRole("region", { name: "What it is not" })).toContainText("Not on Base mainnet yet");
});

test("where the registry is not deployed, the page says so and the commands use shell variables", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`${NOT_DEPLOYED_ORIGIN}/`);
  const live = page.getByRole("region", { name: "Current state, with its sources" });
  await expect(live).toContainText("The index registry is not deployed on Base yet, so no index is published there.");
  await expect(live).toContainText("deployment map of @equityos/contracts-abi for Base (chain id 8453)");
  await expect(stat(live, "Published indexes")).toHaveCount(0);
  const verify = page.getByRole("region", { name: "Verify it yourself" });
  await expect(verify.locator("pre").first()).toContainText("$INDEX_ID $VERSION --rpc-url https://mainnet.base.org");
  expect(errors).toEqual([]);
});

test("has no horizontal overflow at 375 px and keeps code inside the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const pre of await page.locator("pre").all()) {
    expect(await pre.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test("nothing on the page animates", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const animated = await page.locator("main *").evaluateAll(
    (nodes) =>
      nodes.filter((node) => {
        const style = getComputedStyle(node);
        return style.animationName !== "none" || style.transitionProperty.includes("transform");
      }).length,
  );
  expect(animated).toBe(0);
});
