import { expect, type Page, test } from "@playwright/test";

const routes = ["/", "/dev/components"];

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
