import { expect, type Page, test } from "@playwright/test";
import { installMockWallet, mockBaseRpc, TEST_ACCOUNT } from "./wallet-support";

const SHORT_ACCOUNT = "0xf39F...2266";

/** Base units held by the test account. Every other token has a zero balance. */
const BALANCES = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 1_250_500_000n, // 1,250.5 USDC
  "0xb20000000000000000000078ee7ce2fe4908108c": 412_500_000n, // 4.125 NVDAc
  "0xb200000000000000000000c2e324d24d7eecd1fb": 150_000_000n, // 1.5 AAPLc
};

/** Console errors, uncaught exceptions and every request that leaves the app's origin. */
function watch(page: Page, baseURL: string | undefined) {
  const errors: string[] = [];
  const external: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith(baseURL ?? "") && !url.startsWith("data:")) external.push(url);
  });
  return { errors, external };
}

const connectButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: "Connect wallet" });
const accountButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: /^Account 0x/ });
const accountMenu = (page: Page) => page.getByRole("dialog", { name: "Wallet account" });

async function connect(page: Page) {
  await connectButton(page).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
  await expect(accountButton(page)).toContainText(SHORT_ACCOUNT);
}

// The geolocation header a deployment receives from its platform. Without it production fails closed.
test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

test("the connect dialog lists the options, closes with Escape and returns focus", async ({ page, baseURL }) => {
  const { errors, external } = watch(page, baseURL);
  await installMockWallet(page, { chainId: 8453 });
  await page.goto("/");
  await connectButton(page).click();

  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog).toBeVisible();
  // Exactly these two: no WalletConnect project id is configured, so that option is absent, not disabled.
  await expect(dialog.getByRole("listitem")).toHaveText([/^Test Wallet/, /^Base Account/]);
  await expect(dialog.getByRole("button", { name: /Test Wallet/ })).toBeFocused();
  await expect(dialog).toContainText("It does not sign or send anything.");
  // Execution is available to this request, so the dialog carries no note about it.
  await expect(dialog).not.toContainText("Execution is");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(connectButton(page)).toBeFocused();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("without a wallet in the browser the dialog still offers Base Account", async ({ page }) => {
  await page.goto("/");
  await connectButton(page).click();
  await expect(page.getByRole("dialog", { name: "Connect a wallet" }).getByRole("listitem")).toHaveText([
    /^Base Account/,
  ]);
});

/** Holds back the chunks that are not in the first HTML, which are the wallet code, for a second. */
async function delayWalletCode(page: Page) {
  const html = await (await page.request.get("/")).text();
  await page.route("**/_next/static/chunks/*.js", async (route) => {
    const name = route.request().url().split("/").pop() ?? "";
    if (!html.includes(name)) await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
}

test("a connected visitor never sees a disconnected control, and nothing moves when it resolves", async ({ page }) => {
  await installMockWallet(page, { chainId: 8453 });
  await page.goto("/");
  await connect(page);

  // Records every text the account control shows from the first paint of the next load.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { accountTexts: seen });
    new MutationObserver(() => {
      const text = document.querySelector("header button:not([aria-label='Switch color theme'])")?.textContent;
      if (text && seen.at(-1) !== text) seen.push(text);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await delayWalletCode(page);
  await page.reload();

  const toggle = page.getByRole("button", { name: "Switch color theme" });
  const before = await toggle.boundingBox();
  await expect(accountButton(page)).toHaveCount(0);
  await expect(accountButton(page)).toContainText(SHORT_ACCOUNT);
  expect(await toggle.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => (window as unknown as { accountTexts: string[] }).accountTexts)).toEqual([
    SHORT_ACCOUNT,
  ]);
});

test("connect, wrong network, switch to Base, reload and disconnect", async ({ page, baseURL }) => {
  const { errors, external } = watch(page, baseURL);
  await installMockWallet(page, { chainId: 1 });
  await page.goto("/");
  await connect(page);

  // Connected on Ethereum mainnet, which the app does not use.
  await expect(accountButton(page)).toHaveAccessibleName(`Account ${TEST_ACCOUNT}, unsupported network`);
  await accountButton(page).click();
  const menu = accountMenu(page);
  await expect(menu).toContainText(TEST_ACCOUNT);
  await expect(menu).toContainText("Test Wallet");
  await expect(menu).toContainText("Unsupported (chain 1)");
  await expect(menu.getByRole("button", { name: "Copy address" })).toBeFocused();
  await expect(menu.getByRole("link", { name: "View on Basescan" })).toHaveAttribute(
    "href",
    `https://basescan.org/address/${TEST_ACCOUNT}`,
  );

  await menu.getByRole("button", { name: "Switch to Base" }).click();
  await expect(menu).not.toContainText("Unsupported");
  await expect(menu.getByRole("button", { name: "Switch to Base" })).toHaveCount(0);
  await expect(accountButton(page)).toHaveAccessibleName(`Account ${TEST_ACCOUNT}`);

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(accountButton(page)).toBeFocused();

  // The connection survives a reload.
  await page.reload();
  await expect(accountButton(page)).toContainText(SHORT_ACCOUNT);

  await accountButton(page).click();
  await accountMenu(page).getByRole("button", { name: "Disconnect" }).click();
  await expect(connectButton(page)).toBeFocused();
  await page.reload();
  await expect(connectButton(page)).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("a declined network switch is explained and changes nothing", async ({ page }) => {
  await installMockWallet(page, { chainId: 1, rejectSwitch: true });
  await page.goto("/");
  await connect(page);
  await page.getByRole("banner").getByRole("button", { name: "Switch to Base" }).click();
  const menu = accountMenu(page);
  await expect(menu.getByRole("alert")).toHaveText(
    "The request was declined in the wallet. The network was not changed.",
  );
  await expect(menu).toContainText("Unsupported (chain 1)");
});

test("the account control fits at 375 px, connected with its menu open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await installMockWallet(page, { chainId: 1 });
  await page.goto("/");
  await connect(page);
  await accountButton(page).click();
  await expect(accountMenu(page)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await accountMenu(page).boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
});

test.describe("wallet page", () => {
  test("looks up any address without a wallet, from the mocked chain and the replayed prices", async ({
    page,
    baseURL,
  }) => {
    const { errors, external } = watch(page, baseURL);
    const methods = await mockBaseRpc(page, BALANCES);
    await page.goto(`/wallet?address=${TEST_ACCOUNT.toLowerCase()}`);

    await expect(page.getByRole("main")).toContainText(TEST_ACCOUNT);
    await expect(page.getByRole("main")).toContainText("Read-only lookup.");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");

    const table = page.getByRole("region", { name: "Balances on Base" });
    await expect(table.getByText("Reference", { exact: true })).toBeVisible();
    await expect(table.getByText("Market closed")).toBeVisible();
    // Header, three held balances and the total. Zero balances are collapsed.
    await expect(table.getByRole("row")).toHaveCount(5);
    // USDC is valued at an assumed 1.00 USD per unit, and the row says so.
    const usdc = table.getByRole("row", { name: /^USDC/ });
    await expect(usdc).toContainText("assumed1.00");
    await expect(usdc).toContainText("1,250.50");
    const nvda = table.getByRole("row", { name: /NVDAc/ });
    await expect(nvda).toContainText("4.125");
    await expect(nvda).toContainText("129.82");
    await expect(nvda).toContainText("535.53");
    await expect(table.getByRole("row", { name: /AAPLc/ })).toContainText("517.95");
    // 1,250.5 + 535.5273014 + 517.94654527 is 2,303.97384667.
    const total = table.getByRole("row", { name: /^Total/ });
    await expect(total).toContainText("USDC at an assumed 1.00 USD, the rest at reference prices");
    await expect(total).toContainText("2,303.97");
    await expect(page.getByRole("main")).toContainText("not at a reference feed price");
    await expect(page.getByRole("main")).toContainText("Reference price, not executable.");

    const toggle = page.getByRole("button", { name: "Show 11 zero balances" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(table.getByRole("row")).toHaveCount(16);
    await expect(page.getByRole("button", { name: "Hide 11 zero balances" })).toHaveAttribute("aria-expanded", "true");

    // One multicall for all fourteen tokens, nothing else, and nothing sent to a network.
    expect(methods).toEqual(["eth_call"]);
    expect(errors).toEqual([]);
    expect(external.every((url) => url.startsWith("https://mainnet.base.org"))).toBe(true);
  });

  test("an invalid address is rejected with a reason and nothing is read", async ({ page }) => {
    const methods = await mockBaseRpc(page, BALANCES);
    await page.goto("/wallet?address=0x1234");
    const input = page.getByRole("textbox", { name: "Look up an address" });
    await expect(input).toHaveValue("0x1234");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Not an address.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Balances on Base" })).toHaveCount(0);
    expect(methods).toEqual([]);
  });

  test("disconnected, it offers the connection and the lookup form works", async ({ page }) => {
    await mockBaseRpc(page, BALANCES);
    await page.goto("/wallet");
    await expect(page.getByText("No wallet is connected")).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
    await page.getByRole("textbox", { name: "Look up an address" }).fill(TEST_ACCOUNT);
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page).toHaveURL(new RegExp(`/wallet\\?address=${TEST_ACCOUNT}$`));
    await expect(page.getByRole("region", { name: "Balances on Base" })).toBeVisible();
  });

  test("connected, it shows the wallet, the network and what batching means", async ({ page }) => {
    await mockBaseRpc(page, BALANCES);
    await installMockWallet(page, { chainId: 8453 });
    await page.goto("/wallet");
    await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
    await page
      .getByRole("dialog", { name: "Connect a wallet" })
      .getByRole("button", { name: /Test Wallet/ })
      .click();

    const main = page.getByRole("main");
    await expect(main).toContainText(TEST_ACCOUNT);
    await expect(main.getByText("Test Wallet")).toBeVisible();
    await expect(main.getByText("One confirmation", { exact: true })).toBeVisible();
    await expect(main.getByRole("region", { name: "Balances on Base" }).getByRole("row")).toHaveCount(5);
  });

  test("a wallet without the capabilities method is reported as confirming each step", async ({ page }) => {
    await mockBaseRpc(page, {});
    await installMockWallet(page, { chainId: 8453, capabilities: null });
    await page.goto("/wallet");
    await connect(page);
    await expect(page.getByRole("main").getByText("One confirmation per step")).toBeVisible();
    await expect(page.getByRole("main")).toContainText("This address holds no USDC");
  });
});

test.describe("from a restricted region", () => {
  test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "US" } });

  test("connecting still works and the dialog says execution is unavailable", async ({ page }) => {
    await installMockWallet(page, { chainId: 8453 });
    await page.goto("/");
    await connectButton(page).click();
    await expect(page.getByRole("dialog", { name: "Connect a wallet" })).toContainText(
      "Execution is not available in your region.",
    );
    await page.getByRole("button", { name: /Test Wallet/ }).click();
    await expect(accountButton(page)).toContainText(SHORT_ACCOUNT);
  });
});
