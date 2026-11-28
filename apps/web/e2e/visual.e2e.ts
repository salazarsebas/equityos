import { expect, test } from "@playwright/test";

/**
 * Screenshot baselines of the main pages at phone, tablet and desktop widths in both themes, on the production
 * build with the replayed data, whose clock is fixed, so nothing on these pages changes between runs. A change
 * that alters a page fails until its baseline is updated on purpose.
 *
 * Baselines are rendered on Linux, as the CI runner renders them, so the test is skipped elsewhere: text
 * rasterizes differently on each operating system. Update them with `bun run test:visual:update`, which renders
 * them in the Playwright image for Linux (see docs/development/testing.md).
 */
const pages = [
  { name: "landing", path: "/" },
  { name: "explorer", path: "/indexes" },
  { name: "index", path: "/indexes/diversified-equity-d622e2a5" },
  { name: "studio", path: "/studio" },
  {
    name: "portfolio",
    path: "/portfolio?address=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266&index=diversified-equity-d622e2a5",
  },
  { name: "network", path: "/network" },
] as const;
const widths = [375, 768, 1440] as const;
const themes = ["light", "dark"] as const;

test.skip(process.platform !== "linux", "baselines are rendered on Linux");
// A full-page capture is taken until two in a row are identical, which takes several seconds on a tall page.
test.describe.configure({ timeout: 60_000 });

/** The client parts mount after the first paint; on a loaded machine that can take longer than the default. */
const READY = { timeout: 20_000 };

for (const { name, path } of pages) {
  for (const width of widths) {
    for (const theme of themes) {
      test(`${name} at ${width} px in the ${theme} theme`, async ({ browser }) => {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
          reducedMotion: "reduce",
          extraHTTPHeaders: { "x-vercel-ip-country": "CR" },
        });
        const page = await context.newPage();
        await page.goto(path, { waitUntil: "networkidle" });
        // Ready when the client parts have mounted: the wallet control is resolved and no region is loading.
        await expect(page.getByRole("banner").getByRole("button", { name: "Connect wallet" })).toBeVisible(READY);
        await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, READY);
        await page.evaluate(() => document.fonts.ready);
        await expect(page).toHaveScreenshot(`${name}-${width}-${theme}.png`, {
          fullPage: true,
          animations: "disabled",
          caret: "hide",
          maxDiffPixelRatio: 0.001,
        });
        await context.close();
      });
    }
  }
}
