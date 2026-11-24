import { expect, type Page, test } from "@playwright/test";
import { EMPTY_REGISTRY_ORIGIN, NOT_DEPLOYED_ORIGIN } from "./servers";

/** The recorded registry of `test/fixtures/registry`: a local chain after the seed. */
const DIVERSIFIED = "diversified-equity-d622e2a5";
const DIVERSIFIED_ID = "0xd622e2a5c14a9c3da33be82cea76e20adeaf4a26ca46413ee21307d2c850d610";
const DIVERSIFIED_V2_HASH = "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6";
const MISMATCHED_ID = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const REGISTRY = "0x4bd4d49a9c88f75fb97674488e23a7fa59f9506c";
const CAPTION =
  "Target weights are published rules. Reference prices are indications of value, not executable prices. Nothing here is advice.";

/** Collects console errors and uncaught exceptions for the lifetime of the page. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("index explorer", () => {
  test("lists the published indexes newest first, verified or not, and says the data is a recording", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/indexes");
    await expect(page.getByRole("heading", { level: 1, name: "Indexes" })).toBeVisible();
    const table = page.getByRole("region", { name: "Published indexes" });
    await expect(table.getByRole("row")).toHaveCount(6);
    await expect(table.getByRole("rowheader")).toHaveText([
      "Diversified Equity",
      "Semiconductors Fixed Weight",
      "Large Technology Equal Weight",
      "Single Asset ExampleDeprecated",
      "Unverified index 0x50f8aacd",
    ]);
    const diversified = table.getByRole("row", { name: /Diversified Equity/ });
    await expect(diversified.getByRole("cell")).toHaveText([
      "0xf39f...2266",
      "Fixed weights",
      "5",
      "25.00%",
      "v2",
      "2026-11-16",
      "5 of 5 checks",
    ]);
    const unverified = table.getByRole("row", { name: /Unverified index/ });
    await expect(unverified.getByRole("cell")).toHaveText([
      "0xf39f...2266",
      "-",
      "-",
      "-",
      "v1",
      "2026-11-16",
      "Fails C5",
    ]);
    await expect(page.getByRole("note").filter({ hasText: "fails verification" })).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "Recorded example data, not a live network" })).toBeVisible();
    await expect(page.getByText(CAPTION)).toBeVisible();
    await expect(page.getByText("Mismatched")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the sort order is a link with the order in the URL, rendered by the server", async ({ page, request }) => {
    await page.goto("/indexes");
    const sort = page.getByRole("navigation", { name: "Sort order" });
    await expect(sort.getByRole("link", { name: "Newest first" })).toHaveAttribute("aria-current", "true");
    await expect(sort.getByRole("link", { name: "Oldest first" })).toHaveAttribute("href", "/indexes?sort=oldest");
    await sort.getByRole("link", { name: "Oldest first" }).click();
    await expect(page).toHaveURL(/\/indexes\?sort=oldest$/);
    const table = page.getByRole("region", { name: "Published indexes" });
    await expect(table.getByRole("rowheader").first()).toHaveText("Unverified index 0x50f8aacd");
    await expect(table.getByRole("rowheader").last()).toHaveText("Diversified Equity");
    await expect(table.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/api/v1/indexes?offset=0&limit=5");
    // The same order without any script: it is in the HTML the server sends.
    const html = await (await request.get("/indexes?sort=oldest")).text();
    expect(html.indexOf("Single Asset Example")).toBeLessThan(html.indexOf("Diversified Equity"));
    expect(html.indexOf("Single Asset Example")).toBeGreaterThan(0);
  });

  test("a page past the last index says so, and without JavaScript the list links to the same data as JSON", async ({
    page,
    browser,
  }) => {
    await page.goto("/indexes?page=7");
    await expect(page.getByText("This page is past the last index")).toBeVisible();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const plain = await context.newPage();
    await plain.goto("/indexes");
    const note = plain.getByRole("note").filter({ hasText: "needs JavaScript" });
    await expect(note.getByRole("link", { name: "published indexes" })).toHaveAttribute("href", "/api/v1/indexes");
    await context.close();
  });

  test("the primary navigation lists Indexes right after Overview, and a row opens the profile", async ({ page }) => {
    await page.goto("/");
    const links = page.getByRole("navigation", { name: "Primary" }).getByRole("link");
    await expect(links.nth(0)).toHaveText("Overview");
    await expect(links.nth(1)).toHaveText("Indexes");
    await links.nth(1).click();
    await page.getByRole("link", { name: "Diversified Equity" }).click();
    await expect(page).toHaveURL(new RegExp(`/indexes/${DIVERSIFIED}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Diversified Equity" })).toBeVisible();
  });
});

test.describe("index profile", () => {
  test("shows the header, the key facts and the composition with reference prices and current status", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto(`/indexes/${DIVERSIFIED}`);
    await expect(page.getByRole("heading", { level: 1, name: "Diversified Equity" })).toBeVisible();
    await expect(page.getByText("v2, latest")).toBeVisible();
    await expect(page.getByText("A published methodology, not a fund.")).toBeVisible();
    await expect(page.getByRole("paragraph").filter({ hasText: "Five companies from different" })).toBeVisible();
    const facts = page.locator("dl").filter({ hasText: "Largest weight" });
    await expect(facts.locator("dd")).toHaveText(["5", "25.00%", "5.00 ppdrift, 7 days min", "2026-11-16UTC"]);

    const table = page.getByRole("region", { name: "Composition of version 2" });
    await expect(table.getByRole("row")).toHaveCount(7);
    await expect(table.getByRole("rowheader")).toHaveText(["TSLAc", "NVDAc", "AAPLc", "AMZNc", "MSTRc", "Total"]);
    const nvda = table.getByRole("row", { name: /NVDAc/ });
    await expect(nvda).toContainText("NVIDIA Corporation");
    await expect(nvda).toContainText("25.00%");
    await expect(nvda).toContainText("129.82");
    await expect(nvda).toContainText("Last close");
    await expect(nvda).toContainText("Eligible");
    await expect(table.getByRole("row", { name: /Total/ })).toContainText("100.00%");
    await expect(table.getByText("Market closed")).toBeVisible();
    await expect(table.getByRole("link", { name: "JSON" })).toHaveAttribute(
      "href",
      `/api/v1/indexes/${DIVERSIFIED_ID}/composition?version=2`,
    );
    await expect(page.getByText("Reference prices: Chainlink feeds, Base mainnet block 60,489,401")).toBeVisible();
    await expect(page.getByRole("note").filter({ hasText: "Reference prices are a recording" })).toBeVisible();
    await expect(page.getByText(CAPTION)).toHaveCount(2);
    await expect(page.locator("canvas, svg[role=img]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Performance" })).toBeVisible();
    await expect(page.getByText("No performance is shown for this index.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the verification panel shows the onchain facts and every check passing", async ({ page }) => {
    await page.goto(`/indexes/${DIVERSIFIED}`);
    const panel = page.getByRole("region", { name: "Verification" });
    await expect(panel.getByTestId("verification-result")).toHaveText("All 5 checks pass");
    await expect(panel.getByText(DIVERSIFIED_V2_HASH).first()).toBeVisible();
    await expect(panel.getByText(DIVERSIFIED_ID).first()).toBeVisible();
    await expect(panel.getByText(REGISTRY, { exact: true })).toBeVisible();
    await expect(panel.getByText("Local development chain, chain id 31337")).toBeVisible();
    await expect(panel.getByText("Block 9, 2026-11-16 14:00 UTC")).toBeVisible();
    await expect(panel.getByText("969 bytes").first()).toBeVisible();
    const checks = panel.locator("[data-check]");
    await expect(checks).toHaveCount(5);
    await expect(panel.locator('[data-check][data-status="pass"]')).toHaveCount(5);
    await expect(checks.first()).toContainText("Hash matches");
    await expect(checks.first()).toContainText(`keccak256 of the 969 bytes is ${DIVERSIFIED_V2_HASH}`);
    await expect(checks.last()).toContainText("5 constituents match the spec in order and weight");
    await expect(panel.getByTestId("current-status")).toContainText(
      "All 5 constituents are index-eligible, transferable and have a usable reference price.",
    );
    await expect(panel.getByTestId("current-status")).toContainText("Not part of the checks above.");
  });

  test("Verify it yourself opens, shows the exact spec and the three commands, and the copy button copies", async ({
    page,
    context,
    request,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`/indexes/${DIVERSIFIED}`);
    const panel = page.getByRole("region", { name: "Verification" });
    const spec = panel.getByRole("textbox", { name: "canonical spec" });
    await expect(spec).toBeHidden();
    await panel.getByText("Verify it yourself").click();
    await expect(spec).toBeVisible();

    const api = await (await request.get(`/api/v1/indexes/${DIVERSIFIED_ID}/versions/2`)).json();
    expect(api.data.specHash).toBe(DIVERSIFIED_V2_HASH);
    await expect(spec).toHaveValue(api.data.specText);
    const read = `cast call ${REGISTRY} "specOf(bytes32,uint32)(bytes)" ${DIVERSIFIED_ID} 2 --rpc-url http://127.0.0.1:8545`;
    await expect(panel.locator("pre")).toHaveText([
      read,
      `${read} | cast keccak`,
      new RegExp(`^curl -s https?://[^ ]+/api/v1/indexes/${DIVERSIFIED_ID}/versions/2$`),
    ]);

    await panel.getByRole("button", { name: "Copy canonical spec" }).click();
    await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(api.data.specText);
    await panel.getByRole("button", { name: "Copy command 2" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${read} | cast keccak`);
    await panel.getByRole("button", { name: "Copy spec hash" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DIVERSIFIED_V2_HASH);
  });

  test("without JavaScript the facts, the checks and the disclosure work, and no dead control is shown", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`/indexes/${DIVERSIFIED}`);
    await expect(page.getByRole("heading", { level: 1, name: "Diversified Equity" })).toBeVisible();
    const panel = page.getByRole("region", { name: "Verification" });
    await expect(panel.locator('[data-check][data-status="pass"]')).toHaveCount(5);
    await panel.getByText("Verify it yourself").click();
    await expect(panel.getByRole("textbox", { name: "canonical spec" })).toHaveValue(/^\{"calc":"equityos\.calc\/1"/);
    await expect(panel.locator("pre").nth(1)).toContainText("| cast keccak");
    await expect(page.getByRole("button", { name: /Copy/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Methodology" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Version history" }).getByRole("link", { name: "v1" })).toBeVisible();
    const note = page.getByRole("note").filter({ hasText: "composition table needs JavaScript" });
    await expect(note.getByRole("link")).toHaveAttribute(
      "href",
      `/api/v1/indexes/${DIVERSIFIED_ID}/composition?version=2`,
    );
    await context.close();
  });

  test("the methodology is read out of the spec in plain language", async ({ page }) => {
    await page.goto(`/indexes/${DIVERSIFIED}`);
    const section = page.getByRole("region", { name: "Methodology" });
    await expect(section.locator("dt")).toHaveText([
      "Universe",
      "Weighting",
      "Maximum weight",
      "Rebalance trigger",
      "Minimum interval",
      "Pricing source",
    ]);
    await expect(section).toContainText("No constituent may have a target weight above 25.00%.");
    await expect(section).toContainText("is 5.00 pp or more away from its target weight");
    await expect(section).toContainText("A rebalance is not due sooner than 7 days after the previous one");
    await expect(section.getByRole("listitem")).toHaveCount(4);
    await expect(section.getByRole("listitem").first()).toContainText("It does not hold assets.");
  });

  test("the version history states what changed and leads to each version and back", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/indexes/${DIVERSIFIED}`);
    const history = page.getByRole("region", { name: "Version history" });
    await expect(history.getByRole("row")).toHaveCount(3);
    const latest = history.getByRole("row", { name: /v2/ });
    await expect(latest).toHaveAttribute("aria-current", "true");
    await expect(latest.getByRole("listitem")).toHaveText([
      "1 constituent added",
      "1 weight changed",
      "Weighting changed from equal to fixed",
      "Maximum weight changed from none to 25.00%",
      "Description changed",
    ]);
    await expect(history.getByRole("row", { name: /v1/ })).toContainText("First version");
    await expect(history.getByRole("row", { name: /v1/ })).toContainText("0xe64cf7b3");

    await history.getByRole("link", { name: "v1" }).click();
    await expect(page).toHaveURL(new RegExp(`/indexes/${DIVERSIFIED}/versions/1$`));
    await expect(page.getByText("v1, superseded by v2")).toBeVisible();
    const notice = page.getByRole("note").filter({ hasText: "You are viewing version 1. Version 2 is the latest." });
    await expect(notice).toBeVisible();
    const table = page.getByRole("region", { name: "Composition of version 1" });
    await expect(table.getByRole("row")).toHaveCount(6);
    await expect(table.getByRole("row", { name: /NVDAc/ })).toContainText("25.00%");
    await expect(page.getByTestId("verification-result")).toHaveText("All 5 checks pass");
    await expect(page.getByRole("region", { name: "Methodology" })).toContainText(
      "Every constituent has the same target weight, 25.00%.",
    );
    await expect(page).toHaveTitle("Diversified Equity, version 1 | EquityOS");
    await notice.getByRole("link", { name: "View the latest version" }).click();
    await expect(page).toHaveURL(new RegExp(`/indexes/${DIVERSIFIED}$`));
    await expect(page.getByText("v2, latest")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("an index id redirects to the canonical URL, and an unknown identifier or version is a 404", async ({
    page,
    request,
  }) => {
    const byId = await request.get(`/indexes/${DIVERSIFIED_ID}`, { maxRedirects: 0 });
    expect(byId.status()).toBe(307);
    expect(byId.headers().location).toBe(`/indexes/${DIVERSIFIED}`);
    const upper = await request.get(`/indexes/0x${DIVERSIFIED_ID.slice(2).toUpperCase()}/versions/1`, {
      maxRedirects: 0,
    });
    expect(upper.headers().location).toBe(`/indexes/${DIVERSIFIED}/versions/1`);
    await page.goto(`/indexes/${DIVERSIFIED_ID}`);
    await expect(page).toHaveURL(new RegExp(`/indexes/${DIVERSIFIED}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Diversified Equity" })).toBeVisible();

    for (const path of [
      "/indexes/another-name-d622e2a5",
      `/indexes/0x${"1".repeat(64)}`,
      `/indexes/${DIVERSIFIED}/versions/3`,
      `/indexes/${DIVERSIFIED}/versions/latest`,
    ]) {
      expect((await request.get(path)).status()).toBe(404);
    }
    await page.goto("/indexes/another-name-d622e2a5");
    await expect(page.getByRole("heading", { level: 1, name: "Index not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "See all indexes" })).toHaveAttribute("href", "/indexes");
  });

  test("the metadata names the index, points to the canonical URL and carries Open Graph tags", async ({ page }) => {
    await page.goto(`/indexes/${DIVERSIFIED}`);
    await expect(page).toHaveTitle("Diversified Equity | EquityOS");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/indexes/${DIVERSIFIED}$`));
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Diversified Equity");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /^Fixed weights, 5 constituents\. Version 2 of a published index methodology, published 2026-11-16/,
    );
  });

  test("a version that fails verification shows the failed check and nothing computed from its spec", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto(`/indexes/${MISMATCHED_ID}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Unverified index 0x50f8aacd");
    await expect(page).toHaveTitle("Unverified index 0x50f8aacd | EquityOS");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /fails verification/);
    const failure = page.getByRole("note").filter({ hasText: "This version fails verification: check C5" });
    await expect(failure).toContainText("is published at 6000 bps, the spec implies 5000 bps");
    await expect(page.getByTestId("verification-result")).toHaveText("Fails check C5: composition matches");
    const panel = page.getByRole("region", { name: "Verification" });
    await expect(panel.locator('[data-check][data-status="pass"]')).toHaveCount(4);
    await expect(panel.locator('[data-check="C5"]')).toHaveAttribute("data-status", "fail");
    await expect(panel.getByText("Not evaluated: this version has no verified composition to check.")).toBeVisible();
    await expect(page.getByRole("region", { name: /Composition of version/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Methodology" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Performance" })).toHaveCount(0);
    // The name the unverified spec carries appears nowhere outside the stored bytes shown for inspection.
    expect((await page.locator("h1, h2, h3, p, dd, td, th, a").allInnerTexts()).join(" ")).not.toContain("Mismatched");
    await expect(page.getByRole("region", { name: "Version history" }).getByRole("row", { name: /v1/ })).toContainText(
      "Fails C5",
    );
    expect(errors).toEqual([]);
  });

  test("a deprecated index says so, and a single constituent reads correctly", async ({ page }) => {
    await page.goto("/indexes/single-asset-fdc98c0f");
    await expect(page.getByText("Deprecated", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("note").filter({ hasText: "The creator deprecated this index on 2026-11-16." }),
    ).toBeVisible();
    await expect(page.getByTestId("current-status")).toContainText(
      "The constituent is index-eligible, transferable and has a usable reference price.",
    );
    await expect(page.getByRole("region", { name: "Composition of version 1" }).getByRole("row")).toHaveCount(3);
  });
});

test.describe("states of the registry", () => {
  test("a network without the registry says so calmly, on the pages and in the API", async ({ page, request }) => {
    const errors = collectErrors(page);
    await page.goto(`${NOT_DEPLOYED_ORIGIN}/indexes`);
    await expect(page.getByRole("heading", { level: 1, name: "Indexes" })).toBeVisible();
    await expect(page.getByText("The index registry is not deployed on Base yet")).toBeVisible();
    await expect(
      page.getByText("This is different from a registry that is deployed and holds no index."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Read the methodology specification" })).toHaveAttribute(
      "href",
      /docs\/architecture\/methodology-spec\.md$/,
    );
    await expect(page.getByRole("region", { name: "Published indexes" })).toHaveCount(0);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await page.goto(`${NOT_DEPLOYED_ORIGIN}/indexes/${DIVERSIFIED}`);
    await expect(page.getByText("The index registry is not deployed on Base yet")).toBeVisible();
    expect(errors).toEqual([]);

    const list = await request.get(`${NOT_DEPLOYED_ORIGIN}/api/v1/indexes`);
    expect(list.status()).toBe(409);
    expect((await list.json()).error).toMatchObject({
      code: "registry_not_deployed",
      details: { chainId: 8453, reason: "not_configured" },
    });
    const status = await (await request.get(`${NOT_DEPLOYED_ORIGIN}/api/v1/status`)).json();
    expect(status.data.registry).toMatchObject({ chainId: 8453, mode: "live", deployed: false, indexCount: null });
  });

  test("a deployed registry without indexes is an empty state, not the not-deployed state", async ({
    page,
    request,
  }) => {
    await page.goto(`${EMPTY_REGISTRY_ORIGIN}/indexes`);
    await expect(page.getByText("No index has been published yet")).toBeVisible();
    await expect(page.getByText("is not deployed")).toHaveCount(0);
    const list = await request.get(`${EMPTY_REGISTRY_ORIGIN}/api/v1/indexes`);
    expect(list.status()).toBe(200);
    expect(await list.json()).toMatchObject({ data: [], meta: { total: 0, registry: { mode: "replay" } } });
  });

  test("the API of the main server serves the recorded registry and says it is a replay", async ({ request }) => {
    const list = await request.get("/api/v1/indexes?limit=2");
    expect(list.status()).toBe(200);
    expect(list.headers()["x-equityos-api-version"]).toBe("1.2.0");
    const { data, meta } = await list.json();
    expect(data).toHaveLength(2);
    expect(meta).toMatchObject({
      total: 5,
      nextOffset: 2,
      registry: { chainId: 31337, address: REGISTRY, mode: "replay" },
    });
    const status = await (await request.get("/api/v1/status")).json();
    expect(status.data.registry).toMatchObject({ mode: "replay", deployed: true, indexCount: 5 });
    const composition = await request.get(`/api/v1/indexes/${DIVERSIFIED}/composition`);
    expect((await composition.json()).data.constituents).toHaveLength(5);
    expect((await request.get(`/api/v1/indexes/${MISMATCHED_ID}/composition`)).status()).toBe(409);
    const paths = Object.keys((await (await request.get("/api/v1/openapi.json")).json()).paths);
    expect(paths).toContain("/indexes/{identifier}/versions/{version}");
    expect(await (await request.get("/sitemap.xml")).text()).toContain("/indexes</loc>");
  });
});

for (const [name, url] of [
  ["explorer", "/indexes"],
  ["profile", `/indexes/${DIVERSIFIED}`],
  ["version page", `/indexes/${DIVERSIFIED}/versions/1`],
  ["unverified profile", `/indexes/${MISMATCHED_ID}`],
  ["not-deployed state", `${NOT_DEPLOYED_ORIGIN}/indexes`],
] as const) {
  test(`the ${name} has no horizontal overflow at 375 px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    if (name === "profile") await page.getByText("Verify it yourself").click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
