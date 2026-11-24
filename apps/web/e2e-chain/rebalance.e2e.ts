import { DEPLOYMENTS, LOCAL_CHAIN_ID, rebalanceLogAbi } from "@equityos/contracts-abi";
import { expect, type Page, test } from "@playwright/test";
import { type Address, createPublicClient, erc20Abi, http } from "viem";
import { anvil } from "viem/chains";
import { builderCodeSuffix } from "../src/lib/execution/builder-code";
import { KYBERSWAP_ROUTER } from "../src/lib/execution/calldata";
import { formatTokenQuantity } from "../src/lib/format";
import { AMZN, buildReadyPlan, DIVERSIFIED, NVDA, type TestLeg, TSLA, USDC } from "../e2e/execution-plans";
import { installMockWallet, TEST_ACCOUNT } from "../e2e/wallet-support";
import { ANVIL_RPC_URL, BUILDER_CODE } from "../playwright.chain.config";

/**
 * Execution end to end on a local chain. The server of this suite reads the local registry and replays the
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
  await shown.getByRole("checkbox", { name: /reference_freshness: delayed for TSLAc/ }).check();
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
    { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 400_000_000n, quotedAmountOut: 519_000_000n },
    { side: "buy", token: TSLA, symbol: "TSLAc", amountIn: 300_000_000n, quotedAmountOut: 77_500_000n },
    { side: "buy", token: AMZN, symbol: "AMZNc", amountIn: 200_000_000n, quotedAmountOut: 90_000_000n },
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
  expect(after[TSLA]).toBe((before[TSLA] ?? 0n) + 77_500_000n);
  expect(after[AMZN]).toBe((before[AMZN] ?? 0n) + 90_000_000n);
  expect(after[USDC]).toBe((before[USDC] ?? 0n) + 519_000_000n - 500_000_000n);
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
    fromBlock: 0n,
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]?.args).toEqual({ account: TEST_ACCOUNT, indexId: DIVERSIFIED.indexId, version: DIVERSIFIED.version });
  // Every transaction of the batch carries the Builder Code suffix the wallet appended.
  const transactions = await Promise.all(
    Array.from({ length: 6 }, (_, offset) =>
      chain.getTransaction({ blockNumber: (logs[0]?.blockNumber ?? 0n) - 5n + BigInt(offset), index: 0 }),
    ),
  );
  for (const transaction of transactions) expect(transaction.input.endsWith((suffix ?? "0x").slice(2))).toBe(true);

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
    { side: "sell", token: NVDA, symbol: "NVDAc", amountIn: 100_000_000n, quotedAmountOut: 129_000_000n },
    // The executor pays half the quote: the router reverts this swap below its minimum.
    {
      side: "buy",
      token: TSLA,
      symbol: "TSLAc",
      amountIn: 100_000_000n,
      quotedAmountOut: 25_800_000n,
      payout: 12_900_000n,
    },
    { side: "buy", token: AMZN, symbol: "AMZNc", amountIn: 50_000_000n, quotedAmountOut: 22_500_000n },
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
  expect(after[USDC]).toBe((before[USDC] ?? 0n) + 129_000_000n);
  // The exact USDC approval stays, for the two buys that did not take effect.
  expect(
    await chain.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [TEST_ACCOUNT, KYBERSWAP_ROUTER],
    }),
  ).toBe(150_000_000n);
  // The app appended the Builder Code suffix to every transaction it sent.
  const latest = await chain.getBlockNumber();
  for (let offset = 0n; offset < 4n; offset += 1n) {
    const transaction = await chain.getTransaction({ blockNumber: latest - offset, index: 0 });
    expect(transaction.input.endsWith((suffix ?? "0x").slice(2))).toBe(true);
  }

  const table = page.getByRole("region", { name: "Balances before and after" });
  await expect(table.getByRole("row", { name: /NVDAc/ }).getByRole("cell").nth(1)).toHaveText(
    formatTokenQuantity(after[NVDA] ?? 0n, 8),
  );
  await expect(page.getByRole("list", { name: "Executions from this browser" })).toContainText("sequential, partial");
});
