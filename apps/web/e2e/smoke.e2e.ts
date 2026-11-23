import { expect, type Page, test } from "@playwright/test";

const routes = ["/", "/assets", "/assets?view=all", "/wallet", "/dev/components"];

/** Collects console errors and uncaught exceptions for the lifetime of the page. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

for (const route of routes) {
  test(`${route} renders its landmarks with no console errors`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(route);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(errors).toEqual([]);
  });

  test(`${route} has no horizontal overflow at 375 px`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

// A layout that reads the request (cookies, headers) stops every page under it from being prerendered. This
// fails when that happens to a static page, or when a page that must render on request becomes static.
for (const [route, prerendered] of [
  ["/", true],
  ["/dev/components", true],
  ["/assets", false],
  ["/wallet", false],
] as const) {
  test(`${route} is ${prerendered ? "prerendered at build time" : "rendered on request"}`, async ({ request }) => {
    const response = await request.get(route);
    expect(response.status()).toBe(200);
    expect("x-nextjs-prerender" in response.headers()).toBe(prerendered);
  });
}

test("no font is requested from another origin", async ({ page, baseURL }) => {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(request.url());
  });
  await page.goto("/dev/components", { waitUntil: "networkidle" });
  expect(fonts.length).toBeGreaterThan(0);
  expect(fonts.filter((url) => !url.startsWith(baseURL ?? ""))).toEqual([]);
});

test("the theme toggle switches the theme and the choice survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  const html = page.locator("html");
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(html).toHaveAttribute("data-theme", "light");
  const light = await background();

  await page.getByRole("button", { name: "Switch color theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await background()).not.toBe(light);

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.getByRole("button", { name: "Switch color theme" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe(light);
});

test("the system preference applies when no theme was chosen", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("the skip link is the first tab stop and targets the main landmark", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute("href", "#main");
});

test("tabs follow the arrow keys and the dialog opens and closes", async ({ page }) => {
  await page.goto("/dev/components");
  await page.getByRole("tab", { name: "Overview" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Methodology" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("caps each weight");

  await page.getByRole("button", { name: "Open dialog" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop replicating SCI6?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Open dialog" })).toBeFocused();
});

test.describe("assets page on the recorded block", () => {
  test("lists the index-eligible assets with their reference prices and says the data is a recording", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/assets");
    const table = page.getByRole("region", { name: "Index-eligible assets" });
    await expect(table.getByRole("row")).toHaveCount(14);
    await expect(table.getByText("Market closed")).toBeVisible();
    const nvda = table.getByRole("row", { name: /NVDAc/ });
    await expect(nvda).toContainText("NVIDIA Corporation");
    await expect(nvda).toContainText("129.82");
    await expect(nvda).toContainText("Last close");
    await expect(nvda).toContainText("2026-11-20 23:42");
    await expect(nvda).toContainText("1.0005");
    await expect(table.getByRole("row", { name: /SNDKc/ })).toContainText("8.0000");
    await expect(page.getByRole("note")).toContainText("recording, not current data");
    await expect(page.getByText("as of 2026-11-20 21:15 UTC")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the view switch shows every listed asset with the reason it is not eligible, and switches back", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto("/assets");
    const views = page.getByRole("navigation", { name: "Asset view" });
    await expect(views.getByRole("link", { name: /Index-eligible/ })).toHaveAttribute("aria-current", "page");
    await views.getByRole("link", { name: /All listed/ }).click();
    await expect(page).toHaveURL(/\/assets\?view=all$/);
    const table = page.getByRole("region", { name: "All listed assets" });
    await expect(table.getByRole("row")).toHaveCount(18);
    await expect(table.getByRole("columnheader", { name: "Eligibility" })).toBeVisible();
    await expect(table.getByRole("row", { name: /RKTc/ })).toContainText("Not minted · No feed");
    await expect(table.getByRole("row", { name: /NVDAc/ })).toContainText("Eligible");
    await views.getByRole("link", { name: /Index-eligible/ }).click();
    await expect(page).toHaveURL(/\/assets$/);
    await expect(page.getByRole("region", { name: "Index-eligible assets" }).getByRole("row")).toHaveCount(14);
    expect(errors).toEqual([]);
  });

  test("without JavaScript the page says so and links to the same data as JSON", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/assets");
    const note = page.getByRole("note").filter({ hasText: "needs JavaScript" });
    await expect(note.getByRole("link", { name: "eligible assets" })).toHaveAttribute(
      "href",
      "/api/v1/assets?eligible=true",
    );
    await context.close();
  });

  test("the table scrolls inside its frame at 375 px and keeps the symbol column in view", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/assets");
    const table = page.getByRole("region", { name: "Index-eligible assets" });
    const last = table.getByRole("columnheader", { name: "Token", exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(table.getByRole("columnheader", { name: "Asset" })).toBeInViewport();
    expect(await table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  });

  test("the API serves the same block as the page, and the primary navigation links to it", async ({
    page,
    request,
  }) => {
    const response = await request.get("/api/v1/assets?eligible=true");
    expect(response.status()).toBe(200);
    expect(response.headers()["x-equityos-api-version"]).toBe("1.2.0");
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
    const { data, meta } = await response.json();
    expect(data).toHaveLength(13);
    expect(meta.datasets.onchain.blockNumber).toBe("60489401");
    const status = await (await request.get("/api/v1/status")).json();
    expect(status.data.marketData).toMatchObject({ mode: "replay", available: true });
    expect(Object.keys((await (await request.get("/api/v1/openapi.json")).json()).paths)).toContain("/assets");

    await page.goto("/");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Assets" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Assets" })).toBeVisible();
  });
});
