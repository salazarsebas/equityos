import { readFileSync } from "node:fs";
import { DEPLOYMENTS, LOCAL_CHAIN_ID, rebalanceLogAbi } from "@equityos/contracts-abi";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  http,
  isHex,
  keccak256,
  parseAbi,
} from "viem";
import { anvil } from "viem/chains";
import { REFERENCE_FEEDS } from "../../src/server/market/feeds";
import { buildSeedIndexes } from "./indexes";

/**
 * Example usage on a local chain: one attestation of each kind the network metrics tell apart. The tokens and
 * feeds are mocks from `contracts/test/mocks/UsageMocks.sol`, installed with `anvil_setCode` at the Base
 * mainnet addresses the seeded indexes name, so that the attested constituents have `Transfer` logs and
 * reference prices on this chain. Every mock feed answers 100.00 USD. None of it exists on a public network.
 */

const mockAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function configure(string description, int256 answer)",
  "function execute(address[] targets, bytes[] data)",
]);

/** Answer of every mock feed: 100.00 USD, scaled by 1e8. */
export const MOCK_PRICE_E8 = 10_000_000_000n;
const TOKEN = 10n ** 18n;

/** Smart accounts installed by the seed. Addresses chosen to be recognizable, holding the mock account code. */
export const SEED_ACCOUNTS = {
  /** Buys the semiconductors index at its weights and attests in the same transaction: tier A, within tolerance. */
  matched: "0x5eed00000000000000000000000000000000000a",
  /** Buys two of five equal-weight constituents and attests in the same transaction: tier A, outside. */
  partial: "0x5eed00000000000000000000000000000000000b",
  /** Moves 0.50 USD of a constituent and attests: unmatched, below the minimum notional. */
  dust: "0x5eed00000000000000000000000000000000000d",
  /** Same as `matched`, from an account to exclude: `EQUITYOS_EXCLUDED_ACCOUNTS`. */
  excluded: "0x5eed00000000000000000000000000000000000e",
} as const satisfies Record<string, Address>;

function deployedBytecode(contract: string): Hex {
  const path = new URL(`../../../../contracts/out/UsageMocks.sol/${contract}.json`, import.meta.url);
  let artifact: unknown;
  try {
    artifact = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`no artifact for ${contract}: run "bun run contracts:build" first`);
  }
  const deployed =
    typeof artifact === "object" && artifact !== null && "deployedBytecode" in artifact
      ? artifact.deployedBytecode
      : undefined;
  const code = typeof deployed === "object" && deployed !== null && "object" in deployed ? deployed.object : undefined;
  if (!isHex(code) || code === "0x") throw new Error(`unusable artifact for ${contract}`);
  return code;
}

function call(target: Address, data: Hex) {
  return { target, data };
}

export interface SeededUsage {
  /** False when the accounts were already there and nothing was sent. */
  readonly sent: boolean;
  readonly transactions: readonly Hex[];
}

/**
 * Installs the mocks and sends the example attestations, after `seedLocal` published the indexes. Skipped when
 * the seed accounts already hold code.
 *
 * @throws {Error} if the endpoint is not chain 31337, before anything is changed.
 */
export async function seedUsage(rpcUrl: string): Promise<SeededUsage> {
  const transport = http(rpcUrl);
  const client = createPublicClient({ chain: anvil, transport });
  const chainId = await client.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`refusing to seed usage on chain ${chainId}`);
  if ((await client.getCode({ address: SEED_ACCOUNTS.matched })) !== undefined)
    return { sent: false, transactions: [] };

  const wallet = createWalletClient({ chain: anvil, transport });
  const [creator, linkedSender, idleSender] = await wallet.getAddresses();
  if (creator === undefined || linkedSender === undefined || idleSender === undefined) {
    throw new Error("the node exposes fewer than three unlocked accounts");
  }
  const tokenCode = deployedBytecode("MockStockToken");
  const feedCode = deployedBytecode("MockReferenceFeed");
  const accountCode = deployedBytecode("MockSmartAccount");
  const transactions: Hex[] = [];
  async function send(from: Address, to: Address, data: Hex): Promise<void> {
    const hash = await wallet.sendTransaction({ account: from, to, data });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    transactions.push(hash);
  }

  const node = createTestClient({ chain: anvil, mode: "anvil", transport });
  const setCode = (address: Address, bytecode: Hex) => node.setCode({ address, bytecode });
  for (const [token, feed] of REFERENCE_FEEDS) {
    await setCode(token, tokenCode);
    await setCode(feed.proxy, feedCode);
    await send(
      creator,
      feed.proxy,
      encodeFunctionData({ abi: mockAbi, functionName: "configure", args: [feed.description, MOCK_PRICE_E8] }),
    );
  }
  for (const account of Object.values(SEED_ACCOUNTS)) await setCode(account, accountCode);

  const indexId = (salt: Hex) =>
    keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [creator, salt]));
  const [, , largeTechnology, semiconductors, diversified] = buildSeedIndexes(chainId).map(({ salt, versions }) => ({
    indexId: indexId(salt),
    versions,
  }));
  if (largeTechnology === undefined || semiconductors === undefined || diversified === undefined) {
    throw new Error("the seed has fewer indexes than expected");
  }
  const tokenOf = (index: typeof semiconductors, position: number, version = 1): Address => {
    const token = index.versions[version - 1]?.tokens[position];
    if (token === undefined) throw new Error("a seeded index has fewer constituents than expected");
    return token;
  };
  const mint = (token: Address, to: Address, amount: bigint) =>
    call(token, encodeFunctionData({ abi: mockAbi, functionName: "mint", args: [to, amount] }));
  const attest = (index: typeof semiconductors, version: number) =>
    call(
      DEPLOYMENTS[LOCAL_CHAIN_ID].rebalanceLog,
      encodeFunctionData({ abi: rebalanceLogAbi, functionName: "recordRebalance", args: [index.indexId, version] }),
    );
  const execute = (account: Address, calls: readonly { target: Address; data: Hex }[]) =>
    send(
      creator,
      account,
      encodeFunctionData({
        abi: mockAbi,
        functionName: "execute",
        args: [calls.map(({ target }) => target), calls.map(({ data }) => data)],
      }),
    );

  // Semiconductors: 50%, 30% and 20% of 1,000.00 USD at 100.00 USD a token, in the ascending order of the tokens.
  const semiconductorsFor = (account: Address) =>
    (semiconductors.versions[0]?.weightsBps ?? []).map((weightBps, position) =>
      mint(tokenOf(semiconductors, position), account, (BigInt(weightBps) * TOKEN) / 1_000n),
    );
  await execute(SEED_ACCOUNTS.matched, [...semiconductorsFor(SEED_ACCOUNTS.matched), attest(semiconductors, 1)]);
  await execute(SEED_ACCOUNTS.partial, [
    mint(tokenOf(largeTechnology, 0), SEED_ACCOUNTS.partial, 2n * TOKEN),
    mint(tokenOf(largeTechnology, 1), SEED_ACCOUNTS.partial, TOKEN),
    attest(largeTechnology, 1),
  ]);
  // An account that cannot batch: the flows first, then the attestation in a transaction of its own (tier B).
  await send(linkedSender, tokenOf(largeTechnology, 0), mint(tokenOf(largeTechnology, 0), linkedSender, TOKEN).data);
  await send(linkedSender, attest(largeTechnology, 1).target, attest(largeTechnology, 1).data);
  await execute(SEED_ACCOUNTS.dust, [
    mint(tokenOf(diversified, 0, 2), SEED_ACCOUNTS.dust, TOKEN / 200n),
    attest(diversified, 2),
  ]);
  await send(idleSender, attest(semiconductors, 1).target, attest(semiconductors, 1).data);
  await execute(SEED_ACCOUNTS.excluded, [...semiconductorsFor(SEED_ACCOUNTS.excluded), attest(semiconductors, 1)]);
  return { sent: true, transactions };
}
