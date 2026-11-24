"use client";

import { type Address, type Chain, type Hex, parseAbi } from "viem";
import type { Config } from "wagmi";
import { getConnection, getPublicClient } from "wagmi/actions";
import type { ChainReads, FeedReading } from "@/lib/execution/market";
import { REFERENCE_FEEDS } from "@/lib/market/feeds";
import { BALANCE_OF_ABI } from "@/lib/wallet/balances";

/**
 * Reads on the chain of a plan, through the endpoint the app is configured with for that chain. They never go
 * through the wallet and never send anything.
 */
function client(config: Config, chainId: number) {
  const found = getPublicClient(config, { chainId });
  if (found === undefined) throw new Error(`chain ${chainId} is not configured`);
  return found;
}

const marketAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/**
 * Calls one view function of `marketAbi` on each address at one block: in one Multicall3 request where the chain
 * has it, else one request per address. A call that fails is `null`.
 */
async function readEach(
  reader: ReturnType<typeof client>,
  addresses: readonly Address[],
  functionName: "decimals" | "description" | "latestRoundData",
  blockNumber: bigint,
): Promise<unknown[]> {
  if (addresses.length === 0) return [];
  if (reader.chain?.contracts?.multicall3 !== undefined) {
    const results = await reader.multicall({
      contracts: addresses.map((address) => ({ address, abi: marketAbi, functionName })),
      allowFailure: true,
      blockNumber,
    });
    return results.map((entry): unknown => (entry.status === "success" ? entry.result : null));
  }
  const settled = await Promise.allSettled(
    addresses.map((address) => reader.readContract({ address, abi: marketAbi, functionName, blockNumber })),
  );
  return settled.map((entry): unknown => (entry.status === "fulfilled" ? entry.value : null));
}

/**
 * What the browser reads itself to check a plan, at the latest block of the plan's chain: `decimals()` of every
 * token, and `decimals()`, `description()` and `latestRoundData()` of the pinned feed of every token that has
 * one. Independent of the API: the addresses are pinned in the app and the reads go to the chain's endpoint.
 *
 * @throws {Error} if the chain is not configured or its latest block cannot be read
 */
export async function readMarket(config: Config, chainId: number, tokens: readonly Address[]): Promise<ChainReads> {
  const reader = client(config, chainId);
  const block = await reader.getBlock({ blockTag: "latest" });
  const lower = tokens.map((token) => token.toLowerCase() as Address);
  const covered = lower.flatMap((token) => {
    const feed = REFERENCE_FEEDS.get(token);
    return feed === undefined ? [] : [{ token, proxy: feed.proxy }];
  });
  const proxies = covered.map(({ proxy }) => proxy);
  const [tokenDecimals, feedDecimals, descriptions, rounds] = await Promise.all([
    readEach(reader, lower, "decimals", block.number),
    readEach(reader, proxies, "decimals", block.number),
    readEach(reader, proxies, "description", block.number),
    readEach(reader, proxies, "latestRoundData", block.number),
  ]);
  const integer = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? value : null);
  const roundOf = (value: unknown): FeedReading["round"] => {
    if (!Array.isArray(value)) return null;
    const [roundId, answer, , updatedAt, answeredInRound] = value;
    return typeof roundId === "bigint" &&
      typeof answer === "bigint" &&
      typeof updatedAt === "bigint" &&
      typeof answeredInRound === "bigint"
      ? { roundId, answer, updatedAt, answeredInRound }
      : null;
  };
  const feeds = new Map<string, FeedReading>(
    covered.map(({ token }, index) => {
      const description = descriptions[index];
      return [
        token,
        {
          decimals: integer(feedDecimals[index]),
          description: typeof description === "string" ? description : null,
          round: roundOf(rounds[index]),
        },
      ];
    }),
  );
  return {
    chainTime: Number(block.timestamp),
    decimals: new Map(lower.map((token, index) => [token, integer(tokenDecimals[index])])),
    feeds,
  };
}

/**
 * The account and the chain the wallet reports now, asked of the wallet itself rather than read from the app's
 * last known state, which a network changed elsewhere may not have reached yet. `null` when it cannot answer.
 */
export async function readWallet(config: Config): Promise<{ address: Address | null; chainId: number | null }> {
  const { connector, address } = getConnection(config);
  if (connector === undefined) return { address: null, chainId: null };
  const [accounts, chainId] = await Promise.all([
    connector.getAccounts().catch(() => null),
    connector.getChainId().catch(() => null),
  ]);
  const current = accounts?.find((account) => address !== undefined && account.toLowerCase() === address.toLowerCase());
  return { address: current ?? null, chainId };
}

/** Timestamp of the latest block, Unix seconds: the clock a plan's expiry is measured by. */
export async function readChainTime(config: Config, chainId: number): Promise<number> {
  const block = await client(config, chainId).getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

/** The code at an address, `null` when it cannot be read. */
export async function readCode(config: Config, chainId: number, address: Address): Promise<Hex | undefined | null> {
  try {
    return await client(config, chainId).getCode({ address });
  } catch {
    return null;
  }
}

/**
 * Balances of `account` at `blockNumber`, or at the latest block when it is `null`. Each read that fails is
 * `null`, never zero.
 */
export async function readBalances(
  config: Config,
  chainId: number,
  account: Address,
  tokens: readonly Address[],
  blockNumber: bigint | null,
): Promise<Map<string, bigint | null>> {
  const reader = client(config, chainId);
  const results = await Promise.allSettled(
    tokens.map((address) =>
      reader.readContract({
        address,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [account],
        ...(blockNumber === null ? {} : { blockNumber }),
      }),
    ),
  );
  return new Map(
    tokens.map((token, index) => {
      const result = results[index];
      return [token.toLowerCase(), result?.status === "fulfilled" ? result.value : null];
    }),
  );
}

/** The chain of the app's configuration with this id, for its name and explorer. */
export function chainOf(config: Config, chainId: number): Chain | undefined {
  return config.chains.find((chain) => chain.id === chainId);
}

/** Page of a transaction on the chain's explorer, or `null` for a chain without one (a local node). */
export function transactionUrl(chain: Chain | undefined, hash: Hex): string | null {
  const explorer = chain?.blockExplorers?.default;
  return explorer === undefined ? null : `${explorer.url}/tx/${hash}`;
}
