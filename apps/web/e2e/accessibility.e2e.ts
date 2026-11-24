import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type { Address } from "viem";
import { buildReadyPlan, fairPriceE8, NVDA, OPEN_MARKET_TIME, TSLA, USDC } from "./execution-plans";
import { EMPTY_REGISTRY_ORIGIN, NOT_DEPLOYED_ORIGIN } from "./servers";
import { installMockWallet, mockBaseRpc, TEST_ACCOUNT } from "./wallet-support";

/**
 * Automated accessibility check with axe-core: every route of the site, in the light and the dark theme, fails on
 * a serious or critical violation of WCAG 2.2 A and AA or of the axe best practices. The failure message lists every
 * finding of the page, of any impact. The states of the recorded registry (a verified index, a version that fails verification, a deprecated
 * index), the registry that is not deployed, the empty registry, a comparison, a plan and the execution review
 * are all checked, because each renders different components.
 */
const DIVERSIFIED = "diversified-equity-d622e2a5";
const MISMATCHED_ID = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";
const HOLDER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const routes: readonly string[] = [
  "/",
  "/indexes",
  `/indexes/${DIVERSIFIED}`,
  `/indexes/${DIVERSIFIED}/versions/1`,
  `/indexes/${MISMATCHED_ID}`,
  "/indexes/single-asset-fdc98c0f",
  "/assets",
  "/assets?view=all",
  "/studio",
  `/studio?index=${DIVERSIFIED}`,
  "/portfolio",
  `/portfolio?address=${HOLDER}&index=${DIVERSIFIED}`,
  `/portfolio?address=${HOLDER}&index=${DIVERSIFIED}&plan=buy_only&deposit=50`,
  "/wallet",
  "/network",
  "/developers",
  "/developers/api",
  "/developers/spec",
  "/this-page-does-not-exist",
  `${NOT_DEPLOYED_ORIGIN}/indexes`,
  `${NOT_DEPLOYED_ORIGIN}/portfolio`,
  `${EMPTY_REGISTRY_ORIGIN}/indexes`,
];

const themes = ["light", "dark"] as const;
type Theme = (typeof themes)[number];

const BLOCKING = new Set(["serious", "critical"]);

/** Opens the page in a theme the way a returning visitor would: the stored choice, matching the system. */
async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((stored) => {
    try {
      localStorage.setItem("equityos-theme", stored);
    } catch {
      // Storage can be unavailable; the system preference set above gives the same theme.
    }
  }, theme);
}

/** Runs axe on the page as it is now and fails on any serious or critical violation, listing every finding. */
async function expectNoBlockingViolations(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const summary = violations.map(
    ({ id, impact, nodes }) => `${impact ?? "unknown"} ${id}: ${nodes.map((node) => node.target.join(" ")).join(", ")}`,
  );
  expect(
    violations.filter(({ impact }) => BLOCKING.has(impact ?? "")),
    summary.join("\n"),
  ).toEqual([]);
}

for (const route of routes) {
  for (const theme of themes) {
    test(`${route} has no serious accessibility violation in the ${theme} theme`, async ({ page }) => {
      await useTheme(page, theme);
      await page.goto(route, { waitUntil: "networkidle" });
      await expectNoBlockingViolations(page);
    });
  }
}

for (const theme of themes) {
  test(`the connect dialog has no serious accessibility violation in the ${theme} theme`, async ({ page }) => {
    await useTheme(page, theme);
    await page.goto("/wallet", { waitUntil: "networkidle" });
    await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByRole("dialog", { name: "Connect a wallet" })).toBeVisible();
    await expectNoBlockingViolations(page);
  });

  test(`the execution review has no serious accessibility violation in the ${theme} theme`, async ({ page }) => {
    await page.setExtraHTTPHeaders({ "x-vercel-ip-country": "CR" });
    await useTheme(page, theme);
    const account = TEST_ACCOUNT.toLowerCase() as Address;
    const plan = buildReadyPlan({
      account,
      chainId: 8453,
      expiresAt: OPEN_MARKET_TIME + 100,
      legs: [
        { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
        { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_000_000n },
      ],
      balances: { [USDC]: 250_500_000n, [NVDA]: 2_464_860_328n, [TSLA]: 456_555_856n },
      warnings: [["reference_freshness", "delayed", 1]],
    });
    await page.route("**/api/v1/portfolio/execution-plan", (route) => route.fulfill({ json: plan }));
    await installMockWallet(page, { chainId: 8453, rejectSend: true });
    const prices = Object.fromEntries(plan.data.legs.map((leg) => [leg.token, fairPriceE8(leg)]));
    await mockBaseRpc(page, {}, { blockTimestamp: OPEN_MARKET_TIME, prices });
    await page.goto(`/portfolio?address=${TEST_ACCOUNT}&index=${DIVERSIFIED}`);
    const panel = page.getByRole("region", { name: "Execute from your wallet" });
    await panel.getByRole("button", { name: "Connect wallet" }).click();
    await page
      .getByRole("dialog", { name: "Connect a wallet" })
      .getByRole("button", { name: /Test Wallet/ })
      .click();
    await page.getByRole("button", { name: "Prepare to execute" }).click();
    const calls = page.getByRole("region", { name: "Calls you would sign" });
    await expect(calls).toBeVisible();
    // With the detail of every call open: full addresses, exact amounts, calldata and their copy controls.
    for (const summary of await calls.locator("summary").all()) await summary.click();
    await expectNoBlockingViolations(page);
  });
}
