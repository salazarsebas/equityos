import "server-only";
import { MAX_TOKEN_DECIMALS } from "@equityos/core";
import { type Address, decodeEventLog, type Hex, parseAbi } from "viem";
import { aggregatorAbi, erc20BalanceAbi } from "../market/abis";
import { REFERENCE_FEEDS } from "../market/feeds";
import { buildReferencePrice } from "../market/reference-price";
import type { RegistryClient } from "../registry/chain";
import type { BlockPrice, ChainPosition, TokenTransfer } from "./classify";

/** The read-only client of the registry chain. */
export type NetworkClient = RegistryClient;

/** Where batched reads go, as in the registry configuration. */
export type MulticallTarget = Address | "deployless";

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const readAbi = [...erc20BalanceAbi, ...aggregatorAbi] as const;

/** Most block ranges scanned backwards for the tier B window of one attestation. */
const MAX_WINDOW_CHUNKS = 10n;

function lowercase(address: Address): Address {
  return `0x${address.slice(2).toLowerCase()}`;
}

export interface TransactionFlows extends ChainPosition {
  readonly hash: Hex;
  /** `from` of the transaction, lowercase. */
  readonly sender: Address;
  /** Every ERC-20 `Transfer` log of the transaction, whatever token emitted it. */
  readonly transfers: readonly TokenTransfer[];
}

/** The sender, the position and the `Transfer` logs of a mined transaction, from its receipt. */
export async function readTransaction(client: NetworkClient, hash: Hex): Promise<TransactionFlows> {
  const receipt = await client.getTransactionReceipt({ hash });
  const transfers: TokenTransfer[] = [];
  for (const log of receipt.logs) {
    // An ERC-721 Transfer has the same signature with the id indexed: four topics, never decoded here.
    if (log.topics.length !== 3) continue;
    try {
      const { eventName, args } = decodeEventLog({
        abi: transferAbi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (eventName !== "Transfer") continue;
      transfers.push({
        token: lowercase(log.address),
        from: lowercase(args.from),
        to: lowercase(args.to),
        amount: args.value,
      });
    } catch {
      // Another event: not a transfer.
    }
  }
  return {
    hash,
    sender: lowercase(receipt.from),
    blockNumber: receipt.blockNumber,
    transactionIndex: receipt.transactionIndex,
    transfers,
  };
}

export interface BlockRead {
  readonly prices: ReadonlyMap<Address, BlockPrice>;
  /** Balances of the account at the end of the block. `null` for a read that failed. */
  readonly balances: ReadonlyMap<Address, bigint | null>;
}

type Read =
  | { readonly address: Address; readonly abi: typeof readAbi; readonly functionName: "decimals" | "description" }
  | { readonly address: Address; readonly abi: typeof readAbi; readonly functionName: "latestRoundData" }
  | {
      readonly address: Address;
      readonly abi: typeof readAbi;
      readonly functionName: "balanceOf";
      readonly args: readonly [Address];
    };

function isRound(value: unknown): value is readonly [bigint, bigint, bigint, bigint, bigint] {
  return Array.isArray(value) && value.length === 5 && value.every((item) => typeof item === "bigint");
}

/**
 * Reads, at the end of one block, the decimals and the balance of `account` of each token, and the reference
 * feed of each token that has one. The price of a token is its feed's latest answer at that block, with the
 * staleness class it had at the block's time. A feed that is missing, fails, or answers with another identity
 * gives `unavailable`, never a price from elsewhere.
 */
export async function readAtBlock(
  client: NetworkClient,
  multicall: MulticallTarget,
  block: { readonly number: bigint; readonly timestamp: bigint },
  account: Address,
  tokens: readonly Address[],
): Promise<BlockRead> {
  const contracts: Read[] = [];
  for (const token of tokens) {
    contracts.push({ address: token, abi: readAbi, functionName: "decimals" });
    contracts.push({ address: token, abi: readAbi, functionName: "balanceOf", args: [account] });
    const feed = REFERENCE_FEEDS.get(token);
    if (feed === undefined) continue;
    contracts.push({ address: feed.proxy, abi: readAbi, functionName: "decimals" });
    contracts.push({ address: feed.proxy, abi: readAbi, functionName: "description" });
    contracts.push({ address: feed.proxy, abi: readAbi, functionName: "latestRoundData" });
  }
  const destination = multicall === "deployless" ? { deployless: true } : { multicallAddress: multicall };
  const results = await client.multicall({ contracts, allowFailure: true, blockNumber: block.number, ...destination });
  const value = (index: number): unknown => {
    const result = results[index];
    return result?.status === "success" ? result.result : undefined;
  };
  const prices = new Map<Address, BlockPrice>();
  const balances = new Map<Address, bigint | null>();
  let index = 0;
  for (const token of tokens) {
    const decimals = value(index);
    const balance = value(index + 1);
    balances.set(token, typeof balance === "bigint" ? balance : null);
    index += 2;
    const feed = REFERENCE_FEEDS.get(token);
    if (feed === undefined) {
      prices.set(token, { status: "unavailable" });
      continue;
    }
    const [feedDecimals, description, round] = [value(index), value(index + 1), value(index + 2)];
    index += 3;
    const usable =
      typeof decimals === "number" &&
      decimals <= MAX_TOKEN_DECIMALS &&
      typeof feedDecimals === "number" &&
      typeof description === "string" &&
      isRound(round) &&
      round[3] <= BigInt(Number.MAX_SAFE_INTEGER);
    if (!usable) {
      prices.set(token, { status: "unavailable" });
      continue;
    }
    const [roundId, answer, , updatedAt, answeredInRound] = round;
    const price = buildReferencePrice({
      feed,
      read: {
        status: "ok",
        decimals: feedDecimals,
        description,
        round: { roundId, answer, updatedAt: Number(updatedAt), answeredInRound },
      },
      now: Number(block.timestamp),
      servedStale: false,
    });
    prices.set(
      token,
      price.status === "unavailable"
        ? { status: "unavailable" }
        : { status: "ok", priceE8: price.priceE8, decimals, staleness: price.status },
    );
  }
  return { prices, balances };
}

export interface WindowScan {
  readonly tokens: readonly Address[];
  readonly account: Address;
  /** Block of the attestation: the scan goes backwards from it. */
  readonly toBlock: bigint;
  /** First block that may be scanned: the deploy block. */
  readonly floorBlock: bigint;
  readonly chunkBlocks: bigint;
  /** Unix seconds: blocks older than this are outside the window. */
  readonly notBefore: bigint;
}

/**
 * The transactions with a `Transfer` of one of `tokens` from or to `account`, in the blocks of the tier B
 * window before an attestation. Ranges of at most `chunkBlocks` are read backwards until a range starts before
 * the window, at the floor block, or after `MAX_WINDOW_CHUNKS` ranges.
 */
export async function readWindowTransactions(client: NetworkClient, scan: WindowScan): Promise<Set<Hex>> {
  const hashes = new Set<Hex>();
  if (scan.tokens.length === 0) return hashes;
  let end = scan.toBlock;
  for (let chunk = 0n; chunk < MAX_WINDOW_CHUNKS; chunk += 1n) {
    const start = end - scan.chunkBlocks + 1n > scan.floorBlock ? end - scan.chunkBlocks + 1n : scan.floorBlock;
    const range = { address: [...scan.tokens], event: transferAbi[0], fromBlock: start, toBlock: end, strict: true };
    const [sent, received] = await Promise.all([
      client.getLogs({ ...range, args: { from: scan.account } }),
      client.getLogs({ ...range, args: { to: scan.account } }),
    ]);
    for (const log of [...sent, ...received]) hashes.add(log.transactionHash);
    if (start === scan.floorBlock) break;
    const { timestamp } = await client.getBlock({ blockNumber: start });
    if (timestamp < scan.notBefore) break;
    end = start - 1n;
  }
  return hashes;
}
