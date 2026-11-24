import { expect, type Page, test } from "@playwright/test";

/**
 * A new version of an existing index, in the production build, with no chain: the main server replays the
 * recorded registry of `test/fixtures/registry`, a local chain that this build has no connection to. The
 * editor opens prefilled and compares, and publishing is stated as not available.
 */
const DIVERSIFIED = "diversified-equity-d622e2a5";
const MISMATCHED_ID = "0x50f8aacd30bddc6f9e0fbca1501526b2ac01106e626678eab50a7867eb94d759";

const changes = (page: Page) => page.getByRole("list", { name: "Changes from version 2" });
const footerAction = (page: Page, label: string | RegExp) => page.getByRole("button", { name: label });

test("the latest version opens prefilled and verified, and an unchanged spec cannot be reviewed", async ({ page }) => {
  await page.goto(`/studio?index=${DIVERSIFIED}`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Diversified Equity");
  await expect(page.getByLabel("Slug")).toHaveValue("diversified-equity");
  await expect(page.getByLabel("Weight of AMZNc")).toHaveValue("15.00");
  await expect(page.getByText("based on version 2, its latest, verified in this browser")).toBeVisible();
  // The network of an index is fixed, and this build cannot reach it.
  await expect(page.getByLabel("Network")).toBeDisabled();
  await expect(page.getByLabel("Network")).toHaveValue("31337");
  await expect(page.getByLabel("Network").locator("option")).toHaveText(["Local development chain"]);
  await expect(page.getByRole("note")).toContainText("Publishing is not available on Local development chain.");

  await expect(page.getByTestId("unchanged")).toHaveText(
    "Nothing changed: this spec is version 2, byte for byte. A new version must change something.",
  );
  await expect(footerAction(page, "No change from version 2")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Edits to version 3 stay in this page.")).toBeVisible();
});

test("edits are compared with the latest version in the words of the version history", async ({ page }) => {
  await page.goto(`/studio?index=${DIVERSIFIED}`);
  await page.getByLabel("Weight of AAPLc").fill("20");
  await page.getByLabel("Weight of AMZNc").fill("20");
  await expect(changes(page).getByRole("listitem")).toHaveText(["2 weights changed"]);
  await page.getByLabel("Name", { exact: true }).fill("Diversified Equity Plus");
  await expect(changes(page).getByRole("listitem")).toHaveText([
    "2 weights changed",
    'Name changed from "Diversified Equity" to "Diversified Equity Plus"',
  ]);
  // A new name keeps the slug: only a typed slug changes the identifier, and the field says how.
  await expect(page.getByLabel("Slug")).toHaveValue("diversified-equity");
  await page.getByLabel("Slug").fill("diversified-plus");
  await expect(page.getByText(`from ${DIVERSIFIED} to diversified-plus-d622e2a5`)).toBeVisible();
  await expect(changes(page).getByRole("listitem").last()).toHaveText(
    "Slug changed from diversified-equity to diversified-plus",
  );
  await expect(footerAction(page, "Publishing is not available")).toHaveAttribute("aria-disabled", "true");

  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Diversified Equity");
  await expect(page.getByTestId("unchanged")).toBeVisible();
});

test("an index that fails verification, a deprecated one and an unknown one cannot be edited", async ({ page }) => {
  await page.goto(`/studio?index=${MISMATCHED_ID}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Version 1 fails check C5, composition matches, so it cannot be edited.",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);

  await page.goto("/studio?index=single-asset-fdc98c0f");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This index is deprecated. No new version can be published.",
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);

  await page.goto("/studio?index=nothing-0000000000");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "No index has the identifier nothing-0000000000.",
  );
});

test("the profile offers a new version to the creator only, so without a wallet it offers none", async ({ page }) => {
  await page.goto(`/indexes/${DIVERSIFIED}`);
  await expect(page.getByRole("link", { name: "Compare a wallet with this index" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Publish a new version" })).toHaveCount(0);
});
