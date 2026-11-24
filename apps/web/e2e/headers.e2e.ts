import { expect, type Page, test } from "@playwright/test";
import { installMockWallet } from "./wallet-support";

/** Records every Content-Security-Policy violation the page reports, from the first script on. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __cspViolations: seen });
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

// The geolocation header a deployment receives from its platform, as in the wallet tests.
test.use({ extraHTTPHeaders: { "x-vercel-ip-country": "CR" } });

test("every response carries the security headers", async ({ request }) => {
  for (const path of ["/", "/indexes", "/api/v1/status", "/robots.txt"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const headers = response.headers();
    const policy = headers["content-security-policy"] ?? "";
    expect(policy, path).toContain("default-src 'self'");
    expect(policy, path).toContain("frame-ancestors 'none'");
    expect(policy, path).toContain("object-src 'none'");
    expect(policy, path).not.toContain("'unsafe-eval'");
    expect(headers["strict-transport-security"], path).toBe("max-age=63072000; includeSubDomains");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"], path).toContain("camera=()");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["x-powered-by"], path).toBeUndefined();
  }
});

const pages = ["/", "/assets", "/indexes", "/studio", "/portfolio", "/wallet", "/network", "/developers/api"];

for (const path of pages) {
  test(`${path} runs under the policy without a violation`, async ({ page }) => {
    const violations = await watchViolations(page);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The inline theme script ran: it is allowed by the policy.
    await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
    expect(await violations()).toEqual([]);
  });
}

test("the wallet connectors load and connect under the policy", async ({ page }) => {
  const violations = await watchViolations(page);
  await installMockWallet(page, { chainId: 8453 });
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  const dialog = page.getByRole("dialog", { name: "Connect a wallet" });
  await expect(dialog.getByRole("listitem")).toHaveText([/^Test Wallet/, /^Base Account/]);
  await dialog.getByRole("button", { name: /Test Wallet/ }).click();
  await expect(page.getByRole("banner").getByRole("button", { name: /^Account 0x/ })).toBeVisible();
  expect(await violations()).toEqual([]);
});
