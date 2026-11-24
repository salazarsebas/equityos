import { DEPLOYMENTS, indexRegistryAbi, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { createPublicClient, decodeFunctionData, type Hex, http, keccak256, stringToHex } from "viem";
import { anvil } from "viem/chains";
import { installMockWallet, setChainSilently, TEST_ACCOUNT } from "../e2e/wallet-support";
import { ANVIL_RPC_URL } from "../playwright.chain.config";

/**
 * The publish flow end to end on a local chain. The wallet is the test provider of `e2e/wallet-support.ts`:
 * it forwards `eth_sendTransaction` to Anvil, which signs for its unlocked development account. Every
 * transaction of this file goes to chain 31337.
 */
const registry = DEPLOYMENTS[LOCAL_CHAIN_ID].registry;
const chain = createPublicClient({ chain: anvil, transport: http(ANVIL_RPC_URL) });
const nonce = () => chain.getTransactionCount({ address: TEST_ACCOUNT });
const indexCount = () => chain.readContract({ address: registry, abi: indexRegistryAbi, functionName: "indexCount" });

/** The text of an element, trimmed. */
async function text(locator: Locator): Promise<string> {
  return ((await locator.textContent()) ?? "").trim();
}

const checklist = (page: Page) => page.getByRole("list", { name: "Preconditions" }).getByRole("listitem");
const publishButton = (page: Page) => page.getByRole("button", { name: "Publish version 1" });
const fact = (page: Page, term: string) =>
  page
    .locator("dl > div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${term}$`) }) })
    .locator("dd");

async function draft(page: Page, name: string, symbols: readonly string[]) {
  await page.goto("/studio");
  await expect(page.getByRole("checkbox", { name: /^NVDAc/ })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (const symbol of symbols) await page.getByRole("checkbox", { name: new RegExp(`^${symbol}`) }).check();
  await page.getByLabel("Network").selectOption({ label: "Anvil" });
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet to publish" }).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
}

async function review(page: Page) {
  await page.getByRole("button", { name: "Review and publish" }).click();
  await connect(page);
  await expect(checklist(page)).toHaveCount(9);
  await expect(page.locator('[data-state="done"]')).toHaveCount(9);
}

test.describe.configure({ mode: "serial" });

test("an index is created, confirmed and verified, and what was sent is what was shown", async ({ page }) => {
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  const [nonceBefore, countBefore] = await Promise.all([nonce(), indexCount()]);
  await draft(page, "Local Chips", ["NVDAc", "INTCc", "AAPLc"]);
  await page.getByRole("radio", { name: /Fixed/ }).check();
  await page.getByLabel("Weight of NVDAc").fill("50");
  await page.getByLabel("Weight of INTCc").fill("20");
  await page.getByLabel("Weight of AAPLc").fill("30");

  // Without a wallet the review shows the call, and the button only connects.
  await page.getByRole("button", { name: "Review and publish" }).click();
  await expect(fact(page, "Registry")).toHaveText(registry);
  await expect(fact(page, "Function")).toHaveText("createIndex(salt, spec, tokens, weightsBps)");
  await expect(publishButton(page)).toHaveCount(0);
  await connect(page);
  await expect(page.locator('[data-state="done"]')).toHaveCount(9);
  await expect(checklist(page).filter({ hasText: "Simulation" })).toContainText("createIndex succeeded");
  await expect(checklist(page).filter({ hasText: "Gas and fee" })).toContainText(
    /[\d,]+ gas, execution fee at most 0\.\d+ ETH, no L1 data fee on this chain/,
  );
  await expect(checklist(page).filter({ hasText: "ETH balance" })).toContainText("at least 2 times the estimated fee");

  const shown = {
    canonical: await text(page.getByRole("region", { name: "Canonical JSON" })),
    specHash: (await text(fact(page, "Spec hash"))) as Hex,
    indexId: (await text(fact(page, "Index id").locator("span").first())) as Hex,
    salt: (await text(fact(page, "Salt"))) as Hex,
    identifier: await text(fact(page, "Identifier")),
  };
  expect(shown.specHash).toBe(keccak256(stringToHex(shown.canonical)));
  expect(shown.identifier).toBe(`local-chips-${shown.indexId.slice(2, 10)}`);
  const sent = page.getByRole("region", { name: "tokens and weightsBps" });
  await expect(sent.getByRole("row", { name: /NVDAc/ })).toContainText("5,000");

  // Nothing was sent by drafting, reviewing, connecting or simulating.
  expect(await nonce()).toBe(nonceBefore);
  await publishButton(page).click();
  await expect(page.getByRole("heading", { name: "Version 1 is published and verified" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conformance checks" }).getByRole("listitem")).toHaveText([
    /^C1 .*: pass$/,
    /^C2 .*: pass$/,
    /^C3 .*: pass$/,
    /^C4 .*: pass$/,
    /^C5 .*: pass$/,
  ]);
  await expect(fact(page, "Identifier")).toHaveText(shown.identifier);
  await expect(fact(page, "Index id")).toHaveText(shown.indexId);

  // Exactly one transaction, and its calldata carries the bytes, the salt and the weights that were shown.
  expect(await nonce()).toBe(nonceBefore + 1);
  expect(await indexCount()).toBe(countBefore + 1n);
  const hash = (await text(fact(page, "Transaction"))) as Hex;
  const transaction = await chain.getTransaction({ hash });
  expect(transaction.to?.toLowerCase()).toBe(registry.toLowerCase());
  const call = decodeFunctionData({ abi: indexRegistryAbi, data: transaction.input });
  if (call.functionName !== "createIndex") throw new Error(`the transaction calls ${call.functionName}`);
  const [salt, spec, tokens, weightsBps] = call.args;
  expect(salt).toBe(shown.salt);
  expect(spec).toBe(stringToHex(shown.canonical));
  // Tokens go in ascending address order: INTCc, NVDAc, AAPLc.
  expect(tokens.map((token) => token.toLowerCase())).toEqual(JSON.parse(shown.canonical).universe.tokens);
  expect(weightsBps).toEqual([2000, 5000, 3000]);

  // And the registry holds that version under the predicted id.
  const stored = { address: registry, abi: indexRegistryAbi, args: [shown.indexId, 1] } as const;
  expect(await chain.readContract({ ...stored, functionName: "specOf" })).toBe(stringToHex(shown.canonical));
  expect((await chain.readContract({ ...stored, functionName: "getVersion" })).specHash).toBe(shown.specHash);
  const index = await chain.readContract({
    address: registry,
    abi: indexRegistryAbi,
    functionName: "getIndex",
    args: [shown.indexId],
  });
  expect(index).toMatchObject({ creator: TEST_ACCOUNT, latestVersion: 1 });

  // The confirmed state links to the profile of the new index, which the server reads from the same chain.
  await page.getByRole("link", { name: "Open the index page" }).click();
  await expect(page).toHaveURL(new RegExp(`/indexes/${shown.identifier}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Local Chips" })).toBeVisible();
});

test("publishing the same draft again is refused with the decoded error, until the salt is changed on purpose", async ({
  page,
}) => {
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  await draft(page, "Published Twice", ["MSFTc", "GOOGLc"]);
  await review(page);
  await publishButton(page).click();
  await expect(page.getByRole("heading", { name: "Version 1 is published and verified" })).toBeVisible();
  const indexId = await text(fact(page, "Index id"));
  const nonceAfter = await nonce();

  // The draft and its salt are still in the browser: a retry targets the same index id.
  await page.reload();
  await page.getByRole("button", { name: "Review and publish" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "already created an index" });
  await expect(alert).toContainText(`IndexAlreadyExists(${indexId})`);
  await expect(alert).toContainText("Nothing was sent.");
  await expect(checklist(page).filter({ hasText: "Simulation" })).toHaveAttribute("data-state", "blocked");
  await expect(publishButton(page)).toHaveAttribute("aria-disabled", "true");
  await publishButton(page).click({ force: true });
  await expect(fact(page, "Index id").locator("span").first()).toHaveText(indexId);

  await alert.getByRole("button", { name: "Use a new salt" }).click();
  await expect(page.locator('[data-state="done"]')).toHaveCount(9);
  await expect(fact(page, "Index id").locator("span").first()).not.toHaveText(indexId);
  await expect(publishButton(page)).not.toHaveAttribute("aria-disabled", "true");
  expect(await nonce()).toBe(nonceAfter);
});

test("declining in the wallet is a calm state: nothing is sent and publishing stays possible", async ({ page }) => {
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL, rejectSend: true });
  const [nonceBefore, countBefore] = await Promise.all([nonce(), indexCount()]);
  await draft(page, "Declined", ["TSLAc", "METAc"]);
  await review(page);
  await publishButton(page).click();
  const status = page.getByRole("status").filter({ hasText: "You declined the request in the wallet." });
  await expect(status).toContainText("Nothing was sent and the draft is unchanged.");
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(publishButton(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("heading", { name: /published and verified/ })).toHaveCount(0);
  expect(await nonce()).toBe(nonceBefore);
  expect(await indexCount()).toBe(countBefore);
});

test("a wallet on another network is asked to switch before anything can be published", async ({ page }) => {
  await installMockWallet(page, { chainId: 8453, signer: ANVIL_RPC_URL });
  await draft(page, "Wrong Network", ["TSLAc", "METAc"]);
  await page.getByRole("button", { name: "Review and publish" }).click();
  await connect(page);
  await expect(checklist(page).filter({ hasText: "Wallet network" })).toHaveAttribute("data-state", "todo");
  await expect(publishButton(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Switch wallet to Anvil" }).click();
  await expect(page.locator('[data-state="done"]')).toHaveCount(9);
  await expect(publishButton(page)).toBeVisible();
});

test("a wallet that changed network after the review was shown is refused at the click, and nothing is sent", async ({
  page,
}) => {
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  const [nonceBefore, countBefore] = await Promise.all([nonce(), indexCount()]);
  await draft(page, "Switched Away", ["NVDAc", "TSLAc"]);
  await review(page);
  await expect(publishButton(page)).not.toHaveAttribute("aria-disabled", "true");

  // The page still shows the wallet on Anvil, ready to publish, while the wallet is now on Base.
  await setChainSilently(page, 8453);
  await publishButton(page).click();
  const alert = page.getByRole("alert").filter({ hasText: "another network" });
  await expect(alert).toContainText("The wallet is on another network than this transaction is for. Nothing was sent.");
  await expect(page.getByRole("heading", { name: /published and verified/ })).toHaveCount(0);
  expect(await nonce()).toBe(nonceBefore);
  expect(await indexCount()).toBe(countBefore);
});
