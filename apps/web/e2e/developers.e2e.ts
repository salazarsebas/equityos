import { expect, type Page, test } from "@playwright/test";

const DIVERSIFIED = "diversified-equity-d622e2a5";
const DIVERSIFIED_V2_HASH = "0x90d5104e4313a341690a14046df6da168cd3c1924f5ceca79cdc8b3b51fe74f6";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** The text of the clipboard after a click on the copy button named `name`. */
async function copied(page: Page, name: string): Promise<string> {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("button", { name: "Copied" }).first()).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("developer pages", () => {
  test("the overview gives three keyless requests that the deployment answers as recorded", async ({
    page,
    context,
    request,
  }) => {
    const errors = collectErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/developers");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Developers");
    await expect(
      page.getByRole("navigation", { name: "Developer documentation" }).getByRole("link", { name: "Overview" }),
    ).toHaveAttribute("aria-current", "page");
    const conventions = page.getByRole("complementary", { name: "Conventions" });
    await expect(conventions).toContainText("Integer basis points");
    await expect(conventions).toContainText("except the execution plan, a POST");

    const first = await copied(page, "Copy request 1");
    expect(first).toMatch(/^curl "https?:\/\/[^"]+\/api\/v1\/indexes\?limit=2"$/);
    expect(await copied(page, "Copy request 2")).toMatch(new RegExp(`/api/v1/indexes/${DIVERSIFIED}/composition"$`));

    // The first recorded response is open, and it is what this server, which replays the same recording, answers.
    const shown = JSON.parse(await copied(page, "Copy response 1"));
    const path = first.replace(/^curl "https?:\/\/[^/]+/, "").replace(/"$/, "");
    const live = await (await request.get(path)).json();
    expect(shown.data.map((index: { indexId: string }) => index.indexId)).toEqual(
      live.data.map((index: { indexId: string }) => index.indexId),
    );

    expect(await copied(page, "Copy SDK example")).toContain('import { createClient } from "@equityos/sdk";');
    expect(await copied(page, "Copy verification example")).toContain("verifyIndexVersion({");
    expect(errors).toEqual([]);
  });

  test("the API reference lists every operation of the OpenAPI document with its request", async ({
    page,
    context,
    request,
  }) => {
    const errors = collectErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const document = await (await request.get("/api/v1/openapi.json")).json();
    await page.goto("/developers/api");
    for (const [path, item] of Object.entries(
      document.paths as Record<string, Record<string, { operationId: string }>>,
    )) {
      for (const operation of Object.values(item)) {
        await expect(page.locator(`[id="${operation.operationId}"]`)).toContainText(`/api/v1${path}`);
      }
    }
    await expect(page.locator('[id="schema-ReferencePrice"]')).toContainText("priceE8");
    await expect(page.getByRole("list", { name: "Error codes" })).toContainText("registry_not_deployed");

    const section = page.locator('section[aria-labelledby="getIndexComposition"]');
    await section.getByText("The composition of the latest version").click();
    const body = JSON.parse(await copied(page, "Copy getIndexComposition response"));
    expect(body.data.identifier).toBe(DIVERSIFIED);
    expect(await copied(page, "Copy getIndexComposition request")).toMatch(
      new RegExp(`^curl "https?://[^"]+/api/v1/indexes/${DIVERSIFIED}/composition"$`),
    );

    // The one POST: its method, its JSON body field by field, and a curl that sends the body.
    const execution = page.locator('section[aria-labelledby="executionPlan"]');
    await expect(execution.getByRole("heading", { level: 3 })).toContainText("POST");
    await expect(execution.getByRole("list", { name: "Fields of the request body" })).toContainText("slippageBps");
    await expect(execution).toContainText("3 plans per address at once");
    const curl = await copied(page, "Copy executionPlan request");
    expect(curl).toMatch(/^curl -X POST "https?:\/\/[^"]+\/api\/v1\/portfolio\/execution-plan"/);
    expect(curl).toContain('-H "Content-Type: application/json"');
    expect(JSON.parse(curl.slice(curl.indexOf("-d '") + 4, -1))).toMatchObject({ mode: "rebalance" });
    expect(errors).toEqual([]);
  });

  test("the spec reference computes the example hash at build time and copies it", async ({ page, context }) => {
    const errors = collectErrors(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/developers/spec");
    await expect(page.getByRole("list", { name: "Fields of equityos.index/1" })).toContainText("weighting.weightsBps");
    expect(await copied(page, "Copy spec hash")).toBe(DIVERSIFIED_V2_HASH);
    const canonical = await copied(page, "Copy canonical bytes");
    expect(new TextEncoder().encode(canonical).length).toBe(969);
    await expect(page.getByRole("list", { name: "Computed weights" }).getByRole("listitem")).toHaveCount(5);
    expect(errors).toEqual([]);
  });
});
