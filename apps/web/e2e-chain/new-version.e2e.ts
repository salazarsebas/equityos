import { DEPLOYMENTS, indexRegistryAbi, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import { computeConstituents, validateSpec } from "@equityos/core";
import { type APIRequestContext, type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import {
  type Address,
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  type Hex,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { anvil } from "viem/chains";
import { installMockWallet, TEST_ACCOUNT } from "../e2e/wallet-support";
import { ANVIL_RPC_URL } from "../playwright.chain.config";

/**
 * A new version of an index, end to end on a local chain. Each test first creates its own index directly on
 * Anvil, from one of the node's unlocked development accounts, as the seed does. The browser wallet is the
 * test provider of `e2e/wallet-support.ts`, connected as the first of those accounts. Every transaction of this
 * file goes to chain 31337.
 */
const registry = DEPLOYMENTS[LOCAL_CHAIN_ID].registry;
/** The second unlocked development account of Anvil: a creator that the browser wallet is not. */
const SECOND_ACCOUNT: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const transport = http(ANVIL_RPC_URL);
const chain = createPublicClient({ chain: anvil, transport });
const nodeWallet = createWalletClient({ chain: anvil, transport });
const nonce = () => chain.getTransactionCount({ address: TEST_ACCOUNT });
const indexHead = (indexId: Hex) =>
  chain.readContract({ address: registry, abi: indexRegistryAbi, functionName: "getIndex", args: [indexId] });

async function text(locator: Locator): Promise<string> {
  return ((await locator.textContent()) ?? "").trim();
}

const checklist = (page: Page) => page.getByRole("list", { name: "Preconditions" }).getByRole("listitem");
const fact = (page: Page, term: string) =>
  page
    .locator("dl > div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${term}$`) }) })
    .locator("dd");

/** Creates an equal-weight index of `symbols` from `creator`, with the feeds of the asset list, and returns its id. */
async function seedIndex(request: APIRequestContext, creator: Address, name: string, symbols: string[]) {
  const body: { data: { symbol: string; address: Address; referencePrice: { feedProxy: Address } }[] } = await (
    await request.get("/api/v1/assets")
  ).json();
  const assets = symbols
    .map((symbol) => body.data.find((asset) => asset.symbol === symbol))
    .flatMap((asset) => (asset === undefined ? [] : [asset]))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
  const validation = validateSpec({
    schema: "equityos.index/1",
    calc: "equityos.calc/1",
    chainId: LOCAL_CHAIN_ID,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    description: "Created on the local chain for a browser test.",
    universe: { type: "static", tokens: assets.map(({ address }) => address) },
    weighting: { type: "equal" },
    pricing: { source: "chainlink-aggregator-v3", feeds: assets.map(({ referencePrice }) => referencePrice.feedProxy) },
    rebalance: { trigger: "drift", driftThresholdBps: 500, minIntervalSeconds: 604_800 },
  });
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  const constituents = computeConstituents(validation.spec);
  const salt = keccak256(stringToHex(`${name} ${Date.now()}`));
  const hash = await nodeWallet.writeContract({
    account: creator,
    address: registry,
    abi: indexRegistryAbi,
    functionName: "createIndex",
    args: [
      salt,
      bytesToHex(validation.specBytes),
      constituents.map(({ token }) => token),
      constituents.map(({ weightBps }) => weightBps),
    ],
  });
  expect((await chain.waitForTransactionReceipt({ hash })).status).toBe("success");
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
}

/** Opens the Studio on the index. The site lists an index it has not read yet within ten seconds. */
async function open(page: Page, indexId: Hex, name: string) {
  await expect(async () => {
    await page.goto(`/studio?index=${indexId}`);
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet to publish" }).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
}

async function review(page: Page, connected = false) {
  await page.getByRole("button", { name: "Review and publish" }).click();
  if (!connected) await connect(page);
  await expect(checklist(page)).toHaveCount(11);
  await expect(page.locator('[data-state="done"]')).toHaveCount(11);
}

async function newTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  return page;
}

test.describe.configure({ mode: "serial" });

test("the creator publishes version 2, which is verified and listed on the profile", async ({ page, request }) => {
  const indexId = await seedIndex(request, TEST_ACCOUNT, "Local Pair", ["NVDAc", "INTCc"]);
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  await open(page, indexId, "Local Pair");
  await expect(page.getByRole("button", { name: "No change from version 1" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("checkbox", { name: /^AAPLc/ }).check();
  await expect(page.getByRole("list", { name: "Changes from version 1" }).getByRole("listitem")).toHaveText([
    "1 constituent added",
    "2 weights changed",
  ]);

  await review(page);
  await expect(fact(page, "Function")).toHaveText("publishVersion(indexId, expectedVersion, spec, tokens, weightsBps)");
  await expect(checklist(page).filter({ hasText: "Creator" })).toContainText(
    "The connected account created this index",
  );
  await expect(checklist(page).filter({ hasText: "Simulation" })).toContainText("publishVersion succeeded");
  const canonical = await text(page.getByRole("region", { name: "Canonical JSON" }));
  const nonceBefore = await nonce();
  await page.getByRole("button", { name: "Publish version 2" }).click();
  await expect(page.getByRole("heading", { name: "Version 2 is published and verified" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Conformance checks" }).getByRole("listitem")).toHaveCount(5);

  // One transaction: publishVersion with the index, the expected version and the bytes that were shown.
  expect(await nonce()).toBe(nonceBefore + 1);
  const transaction = await chain.getTransaction({ hash: (await text(fact(page, "Transaction"))) as Hex });
  const call = decodeFunctionData({ abi: indexRegistryAbi, data: transaction.input });
  if (call.functionName !== "publishVersion") throw new Error(`the transaction calls ${call.functionName}`);
  expect(call.args.slice(0, 3)).toEqual([indexId, 2, stringToHex(canonical)]);
  expect(await indexHead(indexId)).toMatchObject({ creator: TEST_ACCOUNT, latestVersion: 2 });

  // The profile reads the registry again within ten seconds, then lists version 2 as the latest.
  const identifier = await text(fact(page, "Identifier"));
  await expect(async () => {
    await page.goto(`/indexes/${identifier}`);
    await expect(page.getByText("v2, latest")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  const history = page.getByRole("region", { name: "Version history" }).getByRole("row", { name: /^v2/ });
  await expect(history.getByRole("listitem")).toHaveText(["1 constituent added", "2 weights changed"]);
  // The creator is connected, so the profile offers the next version.
  await expect(page.getByRole("link", { name: "Publish a new version" })).toBeVisible();
});

test("an account that is not the creator is refused with the registry's decoded error", async ({ page, request }) => {
  const indexId = await seedIndex(request, SECOND_ACCOUNT, "Other Creator", ["MSFTc", "GOOGLc"]);
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  await open(page, indexId, "Other Creator");
  await page.getByLabel("Name", { exact: true }).fill("Other Creator Two");
  const nonceBefore = await nonce();
  await page.getByRole("button", { name: "Review and publish" }).click();
  await connect(page);

  const alert = page.getByRole("main").getByRole("alert").filter({ hasText: "Only the creator" });
  await expect(alert).toContainText("Only the creator of this index can publish a new version.");
  await expect(alert).toContainText(`NotCreator(${indexId}, ${TEST_ACCOUNT})`);
  await expect(checklist(page).filter({ hasText: "Creator" })).toHaveAttribute("data-state", "blocked");
  await expect(checklist(page).filter({ hasText: "Simulation" })).toHaveAttribute("data-state", "blocked");
  const publish = page.getByRole("button", { name: "Publish version 2" });
  await expect(publish).toHaveAttribute("aria-disabled", "true");
  await publish.click({ force: true });
  expect(await nonce()).toBe(nonceBefore);
  expect(await indexHead(indexId)).toMatchObject({ latestVersion: 1 });

  // Back in the editor, the page says so before any review.
  await page.getByRole("button", { name: "Back to the editor" }).click();
  await expect(page.getByText("The connected account did not create this index.")).toBeVisible();
});

test("a version published from another tab first is refused at the click, and the draft is rebased", async ({
  page,
  context,
  request,
}) => {
  const indexId = await seedIndex(request, TEST_ACCOUNT, "Race Pair", ["TSLAc", "METAc"]);
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL });
  await open(page, indexId, "Race Pair");
  await page.getByLabel("Name", { exact: true }).fill("Race Pair A");
  await review(page);

  // Another tab publishes version 2 while this one shows a review that is ready.
  const other = await newTab(context);
  await open(other, indexId, "Race Pair");
  await other.getByLabel("Description").fill("Published from the other tab.");
  await review(other);
  await other.getByRole("button", { name: "Publish version 2" }).click();
  await expect(other.getByRole("heading", { name: "Version 2 is published and verified" })).toBeVisible();
  await other.close();

  const nonceBefore = await nonce();
  await page.getByRole("button", { name: "Publish version 2" }).click();
  const alert = page.getByRole("main").getByRole("alert").filter({ hasText: "while this draft was open" });
  await expect(alert).toContainText("Version 2 was published while this draft was open.");
  await expect(alert).toContainText("Nothing was sent.");
  expect(await nonce()).toBe(nonceBefore);

  await alert.getByRole("button", { name: "Load the latest version" }).click();
  await expect(page.getByText("The draft is now based on version 2.")).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Race Pair A");
  await expect(page.getByRole("list", { name: "Changes from version 2" }).getByRole("listitem")).toHaveText([
    'Name changed from "Race Pair" to "Race Pair A"',
    "Description changed",
  ]);
  await review(page, true);
  await page.getByRole("button", { name: "Publish version 3" }).click();
  await expect(page.getByRole("heading", { name: "Version 3 is published and verified" })).toBeVisible();
  expect(await nonce()).toBe(nonceBefore + 1);
  expect(await indexHead(indexId)).toMatchObject({ latestVersion: 3 });
});
