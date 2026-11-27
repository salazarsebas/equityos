import { expect, test } from "@playwright/test";
import { PUBLIC_PAGES } from "../src/lib/public-routes";
import budgets from "./bundle-budgets.json" with { type: "json" };

/**
 * First-load JavaScript per route: the compressed bytes of every script the browser downloads to load the page
 * until the network is idle, measured on the production build. Each route has a budget in `bundle-budgets.json`,
 * in kilobytes (1,000 bytes). A route over its budget fails; raise a budget only on purpose, in the same change
 * that adds the code. See docs/development/performance.md.
 */
const routes: readonly string[] = [...PUBLIC_PAGES, "/indexes/diversified-equity-d622e2a5"];
const budgetsKb: Readonly<Record<string, number>> = budgets.routesKb;

test("every measured route has a budget, and every budget a route", () => {
  expect(Object.keys(budgetsKb).sort()).toEqual([...routes].sort());
});

for (const route of routes) {
  test(`${route} stays within its first-load JavaScript budget`, async ({ page }) => {
    const sizes: Promise<number>[] = [];
    page.on("requestfinished", (request) => {
      if (request.resourceType() === "script") sizes.push(request.sizes().then((size) => size.responseBodySize));
    });
    await page.goto(route, { waitUntil: "networkidle" });
    const totalKb = (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0) / 1000;
    test.info().annotations.push({ type: "first-load JS", description: `${totalKb.toFixed(1)} kB` });
    expect(totalKb).toBeGreaterThan(0);
    expect(totalKb, `${route}: ${totalKb.toFixed(1)} kB of JavaScript`).toBeLessThanOrEqual(budgetsKb[route] ?? 0);
  });
}
