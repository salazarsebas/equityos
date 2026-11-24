import { DEPLOYMENTS, LOCAL_CHAIN_ID, rebalanceLogAbi } from "@equityos/contracts-abi";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type Address, createPublicClient, erc20Abi, type Hex, http } from "viem";
import { anvil } from "viem/chains";
import { builderCodeSuffix } from "../src/lib/execution/builder-code";
import { KYBERSWAP_ROUTER } from "../src/lib/execution/calldata";
import { formatTokenQuantity } from "../src/lib/format";
import { AMZN, buildReadyPlan, DIVERSIFIED, NVDA, type TestLeg, TSLA, USDC } from "../e2e/execution-plans";
import { installMockWallet, releaseHeldSend, setChainSilently, TEST_ACCOUNT } from "../e2e/wallet-support";
import { ANVIL_RPC_URL, BUILDER_CODE } from "../playwright.chain.config";

/**
 * Execution end to end on a local chain. The chain starts in an open session, and the seed's mock reference feeds
 * answer 100.00 USD a token, so the plans below are quoted at that price. The server of this suite reads the local registry and replays the
 * recorded market data, so it builds no executable plan: each test answers the plan request with a plan built
 * for the local node's state, in exactly the server's shape (`e2e/execution-plans.ts`). Everything after that
 * is the app: the verification in the browser, the send decision, the wallet requests, the receipts, the
 * balances read again. The wallet forwards to Anvil, which signs for its unlocked development account. Every
 * transaction of this file goes to chain 31337, to the mocks `e2e-chain/execution-chain.ts` installs.
 *
 * Files run in name order on one worker, so this one runs after `publish.e2e.ts`, whose first test opens the
 * page of the index it just created and relies on the server not having read the registry in the ten seconds
 * before. The portfolio pages here read it.
 */
const INDEX = DIVERSIFIED.identifier;
const chain = createPublicClient({ chain: anvil, transport: http(ANVIL_RPC_URL) });
const LOG = DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog;
const balanceOf = (token: Address) =>
  chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [TEST_ACCOUNT] });
const nonce = () => chain.getTransactionCount({ address: TEST_ACCOUNT });

/** The transaction hashes a region of the page shows. */
async function shownHashes(region: Locator): Promise<Hex[]> {
  const texts = await region.locator("span.font-mono").allTextContents();
  return texts.filter((text): text is Hex => /^0x[0-9a-f]{64}$/.test(text));
}

async function balances(): Promise<Record<string, bigint>> {
  const tokens = [USDC, NVDA, TSLA, AMZN];
  const values = await Promise.all(tokens.map(balanceOf));
  return Object.fromEntries(tokens.map((token, index) => [token, values[index] ?? 0n]));
}

/** Answers the plan request with a plan for `legs`, expiring two minutes after the latest block. */
async function answerPlan(page: Page, legs: readonly TestLeg[]) {
  await page.route("**/api/v1/portfolio/execution-plan", async (route) => {
    const block = await chain.getBlock({ blockTag: "latest" });
    const plan = buildReadyPlan({
      account: TEST_ACCOUNT,
      chainId: LOCAL_CHAIN_ID,
      expiresAt: Number(block.timestamp) + 120,
      legs,
      balances: await balances(),
      warnings: [["reference_freshness", "delayed", 1]],
    });
    await route.fulfill({ json: plan });
  });
}

async function review(page: Page) {
  await page.goto(`/portfolio?address=${TEST_ACCOUNT}&index=${INDEX}`);
  const panel = page.getByRole("region", { name: "Execute from your wallet" });
  await panel.getByRole("button", { name: "Connect wallet" }).click();
  await page
    .getByRole("dialog", { name: "Connect a wallet" })
    .getByRole("button", { name: /Test Wallet/ })
    .click();
  await page.getByRole("button", { name: "Prepare to execute" }).click();
  const shown = page.getByRole("region", { name: "Review the executable plan" });
  await shown.getByRole("checkbox", { name: /^I acknowledge this warning\. Reference price \(TSLAc\)/ }).check();
  return shown;
}

const suffix = builderCodeSuffix(BUILDER_CODE);

test.describe.configure({ mode: "serial" });

test("an atomic wallet executes the plan and the attestation in one batch, and the drift after is read from the chain", async ({
  page,
}) => {
  await installMockWallet(page, {
    chainId: LOCAL_CHAIN_ID,
    signer: ANVIL_RPC_URL,
    capabilities: { "0x7a69": { atomic: { status: "supported" } } },
  });
  await answerPlan(page, [
    { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 400_000_000n },
    { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 300_000_000n },
    { side: "buy", token: AMZN, symbol: "AMZNc", amountIn: 200_000_000n, quotedAmountOut: 200_000_000n },
  ]);
  const before = await balances();
  const nonceBefore = await nonce();
  const shown = await review(page);
  const calls = shown.getByRole("region", { name: "Calls you would sign" });
  await expect(calls.getByRole("rowheader")).toHaveText([
    "Approve NVDAc",
    "Approve USDC",
    "Sell NVDAc",
    "Buy TSLAc",
    "Buy AMZNc",
    "Record the rebalance",
  ]);
  // Nothing was sent by preparing, reviewing or acknowledging.
  expect(await nonce()).toBe(nonceBefore);
  const blockBefore = await chain.getBlockNumber({ cacheTime: 0 });
  await page.getByRole("button", { name: "Sign 6 calls in your wallet" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "Executed: every call of the batch confirmed" }),
  ).toBeVisible();
  const event = page.getByTestId("attestation-event");
  await expect(event).toContainText(
    `RebalanceRecorded(account ${TEST_ACCOUNT}, indexId ${DIVERSIFIED.indexId}, version ${DIVERSIFIED.version})`,
  );

  // The wallet was asked for one atomic batch, with the Builder Code as a capability.
  const batches = await page.evaluate(() => JSON.parse(sessionStorage.getItem("mock-wallet-batches") ?? "[]"));
  expect(batches).toHaveLength(1);
  expect(batches[0]).toMatchObject({
    atomicRequired: true,
    chainId: "0x7a69",
    capabilities: { dataSuffix: { value: suffix, optional: true } },
  });
  expect(batches[0].calls).toHaveLength(6);

  // On the chain: the swaps took effect within their bounds, and the attestation names the account.
  const after = await balances();
  expect(after[NVDA]).toBe((before[NVDA] ?? 0n) - 400_000_000n);
  expect(after[TSLA]).toBe((before[TSLA] ?? 0n) + 300_000_000n);
  expect(after[AMZN]).toBe((before[AMZN] ?? 0n) + 200_000_000n);
  expect(after[USDC]).toBe((before[USDC] ?? 0n) + 400_000_000n - 500_000_000n);
  expect(
    await chain.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [TEST_ACCOUNT, KYBERSWAP_ROUTER],
    }),
  ).toBe(0n);
  const logs = await chain.getContractEvents({
    address: LOG,
    abi: rebalanceLogAbi,
    eventName: "RebalanceRecorded",
    args: { account: TEST_ACCOUNT },
    fromBlock: blockBefore + 1n,
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]?.args).toEqual({ account: TEST_ACCOUNT, indexId: DIVERSIFIED.indexId, version: DIVERSIFIED.version });
  // Every transaction of the batch, as the page lists them, carries the Builder Code suffix the wallet appended.
  const batchHashes = await shownHashes(page.getByRole("status").filter({ hasText: "Executed:" }));
  expect(batchHashes).toHaveLength(6);
  for (const hash of batchHashes) {
    expect((await chain.getTransaction({ hash })).input.endsWith((suffix ?? "0x").slice(2))).toBe(true);
  }

  // The balances read again and the drift after, against the same index.
  const table = page.getByRole("region", { name: "Balances before and after" });
  await expect(table.getByRole("row", { name: /NVDAc/ }).getByRole("cell").nth(1)).toHaveText(
    formatTokenQuantity(after[NVDA] ?? 0n, 8),
  );
  await expect(page.getByTestId("drift-after")).toHaveText(/^\d+\.\d{2} pp$/);
  await expect(page.getByRole("list", { name: "Executions from this browser" })).toContainText("atomic, complete");
});

test("a sequential wallet stops at a swap that reverts and reports exactly what happened", async ({ page }) => {
  await installMockWallet(page, {
    chainId: LOCAL_CHAIN_ID,
    signer: ANVIL_RPC_URL,
    capabilities: null,
    sendGas: "0x2dc6c0",
  });
  await answerPlan(page, [
    { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 100_000_000n, quotedAmountOut: 100_000_000n },
    // The executor pays half the quote: the router reverts this swap below its minimum.
    {
      side: "buy",
      token: TSLA,
      symbol: "TSLAc",
      amountIn: 100_000_000n,
      quotedAmountOut: 100_000_000n,
      payout: 50_000_000n,
    },
    { side: "buy", token: AMZN, symbol: "AMZNc", amountIn: 50_000_000n, quotedAmountOut: 50_000_000n },
  ]);
  const before = await balances();
  const nonceBefore = await nonce();
  await review(page);
  await page.getByRole("button", { name: "Sign 5 transactions in your wallet, one at a time" }).click();

  const summary = page.getByTestId("execution-summary");
  await expect(summary).toHaveText(
    "3 confirmed: Approve NVDAc, Approve USDC, Sell NVDAc. Failed: Buy TSLAc. 1 not sent: Buy AMZNc.",
  );
  await expect(page.getByRole("alert").filter({ hasText: "Partially executed." })).toContainText(
    "Approvals that confirmed stay in place for their exact amounts toward the router",
  );
  const steps = page.getByRole("list", { name: "Transactions" }).getByRole("listitem");
  await expect(steps).toHaveCount(5);
  await expect(steps.nth(3)).toHaveAttribute("data-status", "reverted");
  await expect(steps.nth(4)).toHaveAttribute("data-status", "idle");
  // No attestation is offered after a partial execution.
  await expect(page.getByRole("button", { name: /record the rebalance/ })).toHaveCount(0);

  // On the chain: three confirmed, one mined and reverted, one never sent.
  expect(await nonce()).toBe(nonceBefore + 4);
  const after = await balances();
  expect(after[NVDA]).toBe((before[NVDA] ?? 0n) - 100_000_000n);
  expect(after[TSLA]).toBe(before[TSLA]);
  expect(after[AMZN]).toBe(before[AMZN]);
  expect(after[USDC]).toBe((before[USDC] ?? 0n) + 100_000_000n);
  // The exact USDC approval stays, for the two buys that did not take effect.
  expect(
    await chain.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [TEST_ACCOUNT, KYBERSWAP_ROUTER],
    }),
  ).toBe(150_000_000n);
  // The app appended the Builder Code suffix to every transaction it sent, as the page lists them.
  const sentHashes = await shownHashes(page.getByRole("list", { name: "Transactions" }));
  expect(sentHashes).toHaveLength(4);
  for (const hash of sentHashes) {
    const transaction = await chain.getTransaction({ hash });
    expect(transaction.from.toLowerCase()).toBe(TEST_ACCOUNT.toLowerCase());
    expect(transaction.input.endsWith((suffix ?? "0x").slice(2))).toBe(true);
  }

  const table = page.getByRole("region", { name: "Balances before and after" });
  await expect(table.getByRole("row", { name: /NVDAc/ }).getByRole("cell").nth(1)).toHaveText(
    formatTokenQuantity(after[NVDA] ?? 0n, 8),
  );
  await expect(page.getByRole("list", { name: "Executions from this browser" })).toContainText("sequential, partial");
});

/** The legs of a plan that confirms whole one transaction at a time. */
const SMALL_PLAN: readonly TestLeg[] = [
  { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 10_000_000n, quotedAmountOut: 10_000_000n },
  { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 5_000_000n, quotedAmountOut: 5_000_000n },
];

test("after every swap confirmed one at a time, the attestation is offered once, and two clicks send it once", async ({
  page,
}) => {
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL, capabilities: null });
  await answerPlan(page, SMALL_PLAN);
  const blockBefore = await chain.getBlockNumber({ cacheTime: 0 });
  await review(page);
  await page.getByRole("button", { name: "Sign 4 transactions in your wallet, one at a time" }).click();
  await expect(page.getByTestId("execution-summary")).toHaveText(
    "4 confirmed: Approve NVDAc, Approve USDC, Sell NVDAc, Buy TSLAc. 0 not sent: none.",
  );
  const record = page.getByRole("button", { name: "Sign 1 more transaction to record the rebalance" });
  // The click decides again with the wallet's network of that moment: moved away silently, nothing is sent.
  const nonceBefore = await nonce();
  await setChainSilently(page, 8453);
  await record.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "The wallet is on another network than the plan." }),
  ).toBeVisible();
  expect(await nonce()).toBe(nonceBefore);
  await setChainSilently(page, LOCAL_CHAIN_ID);
  // Two clicks in the same task: the second arrives before anything of the first has been awaited.
  await record.evaluate((button) => {
    if (!(button instanceof HTMLElement)) throw new Error("not a button");
    button.click();
    button.click();
  });
  await expect(page.getByTestId("attestation-event")).toContainText(`RebalanceRecorded(account ${TEST_ACCOUNT}`);
  // Long enough for a second transaction, had one been sent, to be mined: the node mines each one at once.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await nonce()).toBe(nonceBefore + 1);
  const logs = await chain.getContractEvents({
    address: LOG,
    abi: rebalanceLogAbi,
    eventName: "RebalanceRecorded",
    args: { account: TEST_ACCOUNT },
    fromBlock: blockBefore + 1n,
  });
  expect(logs).toHaveLength(1);
  await expect(record).toHaveCount(0);
});

test("leaving the page during a run stops it before the next transaction, and the history says where", async ({
  page,
}) => {
  // The wallet holds the second transaction (Approve USDC) until the test confirms it, after leaving the page.
  await installMockWallet(page, { chainId: LOCAL_CHAIN_ID, signer: ANVIL_RPC_URL, capabilities: null, holdSendAt: 1 });
  await answerPlan(page, SMALL_PLAN);
  const nonceBefore = await nonce();
  await review(page);
  await page.getByRole("button", { name: "Sign 4 transactions in your wallet, one at a time" }).click();
  const steps = page.getByRole("list", { name: "Transactions" }).getByRole("listitem");
  await expect(steps.nth(0)).toHaveAttribute("data-status", "confirmed");
  await expect(steps.nth(1)).toHaveAttribute("data-status", "awaiting_signature");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("mock-wallet-holding"))).toBe("1");
  expect(await nonce()).toBe(nonceBefore + 1);
  // A link of the site: the page changes without reloading, so the run in flight sees that it was left.
  await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Indexes" }).click();
  await expect(page).toHaveURL(/\/indexes$/);
  // The transaction confirmed in the wallet after the page was left still lands; none after it is asked for.
  await releaseHeldSend(page);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("equityos.execution.history.v1") ?? ""), { timeout: 15_000 })
    .toMatch(/"stoppedBefore":2/);
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("equityos.execution.history.v1") ?? "{}"));
  expect(history.entries[0]).toMatchObject({ mode: "sequential", result: "partial", stoppedBefore: 2 });
  expect(history.entries[0].transactions).toHaveLength(2);
  expect(await nonce()).toBe(nonceBefore + 2);
  // Nothing more is sent later either: the node mines each transaction at once.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await nonce()).toBe(nonceBefore + 2);
});
