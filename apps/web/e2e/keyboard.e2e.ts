import { expect, type Locator, type Page, test } from "@playwright/test";
import { answerPlan, CHAIN_TIME, fairPrices, readyPlan } from "./execution-support";
import { installMockWallet, mockBaseRpc, TEST_ACCOUNT } from "./wallet-support";

/**
 * Keyboard-only runs of the publish and execute journeys: after the first page load, every step is a key press,
 * with no click and no pointer. At every focus stop the focused element must show the focus indicator (the 2 px
 * outline of `:focus-visible`), and Tab must keep moving: an element that keeps the focus is a trap.
 */

/** Tab presses allowed to reach one control. */
const MAX_TABS = 120;

interface FocusStop {
  readonly description: string;
  readonly visible: boolean;
  /** Whether it is the same element as at the previous stop. */
  readonly same: boolean;
}

/** The focused element, and whether it shows the focus indicator. */
function focusStop(page: Page): Promise<FocusStop | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return null;
    const style = getComputedStyle(element);
    const outlined = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
    const labels = "labels" in element ? (element.labels as NodeListOf<HTMLLabelElement> | null) : null;
    const label =
      element.getAttribute("aria-label") ?? labels?.[0]?.textContent?.trim() ?? (element.textContent ?? "").trim();
    const scope = window as unknown as { lastFocusStop?: Element };
    const same = scope.lastFocusStop === element;
    scope.lastFocusStop = element;
    return {
      description: `${element.tagName.toLowerCase()} "${label.slice(0, 60)}"`,
      visible: element.matches(":focus-visible") && outlined,
      same,
    };
  });
}

/**
 * Presses Tab until `target` has the focus, checking every stop on the way. Fails on a stop without a visible
 * indicator, on focus that does not move, and when the target is not reached.
 */
async function tabTo(page: Page, target: Locator): Promise<void> {
  const handle = await target.elementHandle();
  let repeated = 0;
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Tab");
    const stop = await focusStop(page);
    if (stop === null) continue;
    expect(stop.visible, `focus indicator on ${stop.description}`).toBe(true);
    repeated = stop.same ? repeated + 1 : 0;
    expect(repeated, `focus stays on ${stop.description}`).toBeLessThan(2);
    if (await page.evaluate((element) => element === document.activeElement, handle)) return;
  }
  throw new Error(`${MAX_TABS} Tab presses did not reach the control`);
}

/** Moves the focus to `target` with Tab and activates it with `key`. */
async function press(page: Page, target: Locator, key: "Enter" | "Space"): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

test("publish: from the landing page to the review and back, with the keyboard only", async ({ page }) => {
  await page.goto("/");
  await press(page, page.getByRole("banner").getByRole("link", { name: "Studio" }), "Enter");
  await expect(page).toHaveURL(/\/studio$/);

  const name = page.getByLabel("Name", { exact: true });
  await tabTo(page, name);
  await page.keyboard.type("Chips and Platforms");
  await expect(page.getByLabel("Slug")).toHaveValue("chips-and-platforms");
  for (const symbol of ["NVDAc", "INTCc", "MSFTc"]) {
    const asset = page.getByRole("checkbox", { name: new RegExp(`^${symbol}`) });
    await press(page, asset, "Space");
    await expect(asset).toBeChecked();
  }

  await press(page, page.getByRole("button", { name: "Review and publish" }), "Enter");
  await expect(page.getByRole("heading", { name: "Review and publish" })).toBeVisible();
  await expect(page.getByText("createIndex(salt, spec, tokens, weightsBps)")).toBeVisible();
  await press(page, page.getByRole("button", { name: "Back to the editor" }), "Enter");
  await expect(name).toHaveValue("Chips and Platforms");
});

test("execute: connect, review, acknowledge, sign and decline in the wallet, with the keyboard only", async ({
  page,
}) => {
  await answerPlan(page, readyPlan(CHAIN_TIME + 100));
  await installMockWallet(page, { chainId: 8453, rejectSend: true });
  await mockBaseRpc(page, {}, { blockTimestamp: CHAIN_TIME, prices: fairPrices() });
  await page.goto("/portfolio");

  // A focused select changes its value as its option names are typed.
  const index = page.getByRole("combobox", { name: "Index" });
  await tabTo(page, index);
  await page.keyboard.type("Diversified");
  await expect(index).toHaveValue(/diversified-equity-d622e2a5/);
  await tabTo(page, page.getByRole("textbox", { name: "Address" }));
  await page.keyboard.type(TEST_ACCOUNT);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("threshold-status")).toContainText("Above threshold");

  const panel = page.getByRole("region", { name: "Execute from your wallet" });
  await press(page, panel.getByRole("button", { name: "Connect wallet" }), "Enter");
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  await press(page, dialog.getByRole("button", { name: /Test Wallet/ }), "Enter");
  await expect(dialog).toHaveCount(0);

  await press(page, page.getByRole("button", { name: "Prepare to execute" }), "Enter");
  const review = page.getByRole("region", { name: "Review the executable plan" });
  await expect(review).toBeVisible();
  const acknowledge = review.getByRole("checkbox", { name: /^I acknowledge this warning\./ });
  await press(page, acknowledge, "Space");
  await expect(acknowledge).toBeChecked();
  await press(page, page.getByRole("button", { name: /^Sign \d+ (calls|transactions) in your wallet/ }), "Enter");
  const declined = page.getByRole("status").filter({ hasText: "You declined the request in the wallet." });
  await expect(declined).toContainText("Nothing was sent");
  await press(page, declined.getByRole("button", { name: "Back to the review" }), "Enter");
  await expect(page.getByRole("button", { name: /^Sign \d+ (calls|transactions) in your wallet/ })).toBeVisible();
});
