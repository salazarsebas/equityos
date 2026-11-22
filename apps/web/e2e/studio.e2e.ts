import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { keccak256, stringToHex } from "viem";

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
    if (!url.startsWith(baseURL ?? "") && !/^(data|blob):/.test(url)) external.push(url);
  });
  return { errors, external };
}

/** The text of an element, trimmed. */
async function text(locator: Locator): Promise<string> {
  return ((await locator.textContent()) ?? "").trim();
}

const name = (page: Page) => page.getByLabel("Name", { exact: true });
const asset = (page: Page, symbol: string) => page.getByRole("checkbox", { name: new RegExp(`^${symbol}`) });
const hash = (page: Page) => page.getByTestId("spec-hash");
const json = (page: Page) => page.getByRole("region", { name: "Canonical JSON" });
const footerAction = (page: Page, label: string | RegExp) => page.getByRole("button", { name: label });

async function open(page: Page) {
  await page.goto("/studio");
  await expect(asset(page, "NVDAc")).toBeVisible();
}

async function buildDraft(page: Page) {
  await name(page).fill("Chips and Platforms");
  for (const symbol of ["NVDAc", "INTCc", "MSFTc"]) await asset(page, symbol).check();
}

test("an empty draft says what is left, without a wallet and without leaving the origin", async ({ page, baseURL }) => {
  const { errors, external } = watch(page, baseURL);
  await open(page);
  const todo = page.getByRole("list", { name: "What is left before the spec is valid" });
  await expect(todo.getByRole("listitem")).toHaveText([
    "Give the index a name.",
    "Give the index a slug.",
    "Select at least one constituent.",
  ]);
  await expect(footerAction(page, "3 steps to do")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("note")).toContainText("Publishing is not available on Base.");
  await expect(page.getByRole("note")).toContainText("The registry is not deployed on this network.");
  // Ineligible assets are listed with the reason and cannot be selected.
  await expect(asset(page, "RKTc")).toBeDisabled();
  await expect(page.getByRole("list", { name: "Listed assets" })).toContainText(
    "Not eligible: not minted, no reference feed",
  );
  await expect(page.getByText("Chainlink feeds, Base mainnet block 60,489,401")).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("building a draft shows the composition, the canonical JSON and a hash that follows every edit", async ({
  page,
  baseURL,
}) => {
  const { errors, external } = watch(page, baseURL);
  await open(page);
  await buildDraft(page);
  await expect(page.getByLabel("Slug")).toHaveValue("chips-and-platforms");
  const composition = page.getByRole("region", { name: "Composition" });
  await expect(composition.getByRole("row")).toHaveCount(5);
  await expect(composition.getByRole("row", { name: /Total/ })).toContainText("100.00%");
  await expect(page.getByText("Equal weight across 3 tokenized stocks: from 33.33% to 33.34%.")).toBeVisible();

  const canonical = await text(json(page));
  expect(canonical.startsWith('{"calc":"equityos.calc/1","chainId":8453,')).toBe(true);
  expect(canonical).toContain('"name":"Chips and Platforms"');
  const first = await text(hash(page));
  expect(first).toBe(keccak256(stringToHex(canonical)));
  await expect(page.getByText(`${new TextEncoder().encode(canonical).length} of 8,192 bytes`)).toBeVisible();

  await page.getByLabel("Description").fill("Three large technology names.");
  await expect(hash(page)).not.toHaveText(first);
  await page.getByLabel("Network").selectOption({ label: "Base Sepolia" });
  await expect(json(page)).toContainText('"chainId":84532');
  await expect(page.getByRole("note")).toContainText("Publishing is not available on Base Sepolia.");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("fixed weights cannot leave 100.00% unnoticed, and the remainder is one click away", async ({ page }) => {
  await open(page);
  await buildDraft(page);
  await page.getByRole("radio", { name: /Fixed/ }).check();
  const weights = page.getByRole("list", { name: "Fixed weights" });
  // Switching starts from the equal split, so the total is already exact.
  await expect(page.getByText("The weights total exactly 100.00%, which is 10,000 basis points.")).toBeVisible();

  await page.getByLabel("Weight of NVDAc").fill("50");
  await page.getByLabel("Weight of INTCc").fill("12.5");
  await page.getByLabel("Weight of INTCc").blur();
  await expect(page.getByLabel("Weight of INTCc")).toHaveValue("12.50");
  await expect(page.getByText("4.17% not assigned")).toBeVisible();
  await expect(page.getByRole("button", { name: "Weights add up to 95.83%. 4.17% is not assigned." })).toBeVisible();
  await expect(footerAction(page, "Fix 1 issue")).toHaveAttribute("aria-disabled", "true");

  await page.getByRole("button", { name: "Distribute remaining 4.17%" }).click();
  // 417 bps over three constituents: 139 each, nothing left over.
  await expect(page.getByLabel("Weight of NVDAc")).toHaveValue("51.39");
  await expect(page.getByLabel("Weight of INTCc")).toHaveValue("13.89");
  await expect(page.getByLabel("Weight of MSFTc")).toHaveValue("34.72");
  await expect(hash(page)).toBeVisible();

  await page.getByLabel("Weight of MSFTc").fill("34.725");
  await expect(weights).toContainText("MSFTc: Write a percentage with at most two decimals, for example 12.50.");
  await expect(page.getByText("Total not known")).toBeVisible();
  await page.getByLabel("Weight of MSFTc").fill("40");
  await page.getByRole("button", { name: "Remove excess 5.28%" }).click();
  await expect(page.getByLabel("Weight of MSFTc")).toHaveValue("38.24");

  await page.getByLabel("Maximum weight").fill("40");
  await expect(weights).toContainText("NVDAc is at 49.63%, above the maximum weight of 40%.");
  await page.getByRole("radio", { name: /Equal/ }).check();
  await page.getByLabel("Maximum weight").fill("15");
  await expect(
    page
      .getByText(
        "3 equal weights cannot all stay at or under 15.00%. Raise it to at least 33.34% or select at least 7 constituents.",
      )
      .first(),
  ).toBeVisible();
});

test("an issue in the preview moves focus to the field it is about", async ({ page }) => {
  await open(page);
  await buildDraft(page);
  await name(page).fill("Índice");
  const issue = page.getByRole("button", { name: /^Use 1 to 64 characters/ });
  await issue.click();
  await expect(name(page)).toBeFocused();
  await expect(name(page)).toHaveAttribute("aria-invalid", "true");
});

test("the exported file holds exactly the canonical bytes that are shown and hashed", async ({ page }) => {
  await open(page);
  await buildDraft(page);
  const shown = await text(json(page));
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export spec JSON" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("chips-and-platforms.equityos-index.json");
  const bytes = await readFile(await download.path());
  expect(bytes.toString("utf8")).toBe(shown);
  expect(keccak256(bytes)).toBe(await text(hash(page)));
});

test("a reload restores the draft with its salt, and discarding it starts an empty one", async ({ page }) => {
  await open(page);
  await buildDraft(page);
  await page.getByLabel("Description").fill("Kept across reloads.");
  const before = await text(hash(page));
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("equityos.studio.draft.v1") ?? "{}"));
  const { salt } = (await stored()).draft;
  expect(salt).toMatch(/^0x[0-9a-f]{64}$/);

  await page.reload();
  await expect(name(page)).toHaveValue("Chips and Platforms");
  await expect(asset(page, "INTCc")).toBeChecked();
  await expect(hash(page)).toHaveText(before);
  await expect(page.getByText(/Draft restored and saved in this browser/)).toBeVisible();
  expect((await stored()).draft.salt).toBe(salt);

  await page.getByRole("button", { name: "Discard draft" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard this draft?" });
  await dialog.getByRole("button", { name: "Discard draft" }).click();
  await expect(name(page)).toHaveValue("");
  await expect(asset(page, "INTCc")).not.toBeChecked();
  expect((await stored()).draft.salt).not.toBe(salt);
});

test("a corrupt stored draft does not break the Studio", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("equityos.studio.draft.v1", '{"draft":{"tokens":"x","name":[1]'));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page);
  await expect(name(page)).toHaveValue("");
  expect(errors).toEqual([]);
});

test("the review shows the call and says that publishing is unavailable where the registry is not deployed", async ({
  page,
  baseURL,
}) => {
  const { errors, external } = watch(page, baseURL);
  await open(page);
  await buildDraft(page);
  const shown = await text(json(page));
  await footerAction(page, "Review and publish").click();
  await expect(page.getByRole("heading", { name: "Review and publish" })).toBeVisible();
  await expect(page.getByText("createIndex(salt, spec, tokens, weightsBps)")).toBeVisible();
  await expect(page.getByText("0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c")).toHaveCount(0);
  expect(await text(json(page))).toBe(shown);
  const sent = page.getByRole("region", { name: "tokens and weightsBps" });
  await expect(sent.getByRole("row")).toHaveCount(4);
  await expect(sent).toContainText("3,334");
  await expect(page.getByRole("note").filter({ hasText: "Publishing is not available on Base." })).toBeVisible();
  await expect(page.getByRole("button", { name: /Publish version/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Connect wallet to publish/ })).toHaveCount(0);
  const registry = page
    .getByRole("list", { name: "Preconditions" })
    .getByRole("listitem")
    .filter({ hasText: "Registry on Base" });
  await expect(registry).toHaveAttribute("data-state", "blocked");
  await page.getByRole("button", { name: "Back to the editor" }).click();
  await expect(name(page)).toHaveValue("Chips and Platforms");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("the editor and the review fit a 375 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page);
  await buildDraft(page);
  await page.getByRole("radio", { name: /Fixed/ }).check();
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await footerAction(page, "Review and publish").click();
  await expect(page.getByRole("heading", { name: "Review and publish" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});
