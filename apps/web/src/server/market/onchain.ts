import "server-only";
import {
  type Address,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  http,
  type PublicClient,
} from "viem";
import { aggregatorAbi, b20AssetAbi, b20FactoryAbi, multicall3Abi, PAUSABLE_FEATURE_TRANSFER } from "./abis";
import { BASE_CHAIN_ID, resolveBaseRpcUrl } from "./config";
import { MissingConfigurationError, UpstreamError } from "./errors";
import { REFERENCE_FEEDS } from "./feeds";

/** Multicall3, deployed at the same address on every chain. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** B20 factory precompile. `isB20Initialized` tells whether a token address holds an initialized B20. */
export const B20_FACTORY_ADDRESS: Address = "0xB20f000000000000000000000000000000000000";

/** Calls per `aggregate3` request. A full read of the asset list is a handful of requests. */
const CALLS_PER_REQUEST = 500;
const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_COUNT = 2;

/** A multiplier update that is recorded onchain and not yet in effect. */
export interface PendingMultiplier {
  /** Share multiplier after the update, WAD (1e18 is one share per token). */
  readonly multiplierWad: bigint;
  /** Time the update takes effect, Unix seconds. */
  readonly effectiveAt: number;
}

export interface TokenState {
  readonly decimals: number;
  /** Total supply in token base units. */
  readonly totalSupply: bigint;
  /**
   * Shares of the underlying per token, WAD. Informational: the reference price is already the price of one
   * token, so the multiplier must not be applied to it.
   */
  readonly multiplierWad: bigint;
  readonly pendingMultiplier: PendingMultiplier | null;
  /** Whether the issuer has paused the TRANSFER feature. */
  readonly transfersPaused: boolean;
}

/** Outcome of reading one token. A token whose reads did not all succeed has no state: nothing is defaulted. */
export type TokenRead =
  | { readonly status: "ok"; readonly state: TokenState }
  | { readonly status: "not_initialized" }
  | { readonly status: "read_failed" };

export interface FeedRound {
  readonly roundId: bigint;
  /** Feed answer, scaled by the feed decimals. */
  readonly answer: bigint;
  /** Publication time of the round, Unix seconds. Zero for an incomplete round. */
  readonly updatedAt: number;
  readonly answeredInRound: bigint;
}

/** Outcome of reading one feed proxy. */
export type FeedRead =
  | { readonly status: "ok"; readonly decimals: number; readonly description: string; readonly round: FeedRound }
  | { readonly status: "read_failed" };

/** State of every requested token and of every mapped feed, all read at one block. */
export interface OnchainSnapshot {
  readonly blockNumber: bigint;
  /** Timestamp of the block, Unix seconds. */
  readonly blockTimestamp: number;
  /** Keyed by lowercase token address. */
  readonly tokens: ReadonlyMap<Address, TokenRead>;
  /** Keyed by lowercase token address, for tokens that have a mapped feed. */
  readonly feeds: ReadonlyMap<Address, FeedRead>;
}

/** The read-only client surface this module needs. */
export type MarketClient = Pick<PublicClient, "getBlock" | "readContract">;

/**
 * Creates the Base mainnet client from `BASE_RPC_URL`.
 *
 * @throws {MissingConfigurationError} see `resolveBaseRpcUrl`.
 */
export function createMarketClient(): MarketClient {
  return createPublicClient({
    transport: http(resolveBaseRpcUrl(), { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }),
  });
}

export interface Call {
  readonly target: Address;
  readonly callData: Hex;
}

const TOKEN_CALL_DATA = {
  decimals: encodeFunctionData({ abi: b20AssetAbi, functionName: "decimals" }),
  totalSupply: encodeFunctionData({ abi: b20AssetAbi, functionName: "totalSupply" }),
  multiplier: encodeFunctionData({ abi: b20AssetAbi, functionName: "multiplier" }),
  newUIMultiplier: encodeFunctionData({ abi: b20AssetAbi, functionName: "newUIMultiplier" }),
  effectiveAt: encodeFunctionData({ abi: b20AssetAbi, functionName: "effectiveAt" }),
  isPaused: encodeFunctionData({
    abi: b20AssetAbi,
    functionName: "isPaused",
    args: [PAUSABLE_FEATURE_TRANSFER],
  }),
} as const;

const FEED_CALL_DATA = {
  decimals: encodeFunctionData({ abi: aggregatorAbi, functionName: "decimals" }),
  description: encodeFunctionData({ abi: aggregatorAbi, functionName: "description" }),
  latestRoundData: encodeFunctionData({ abi: aggregatorAbi, functionName: "latestRoundData" }),
} as const;

const CHAIN_ID_CALL: Call = {
  target: MULTICALL3_ADDRESS,
  callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getChainId" }),
};

const CALLS_PER_TOKEN = 7;
const CALLS_PER_FEED = 3;

function tokenCalls(token: Address): Call[] {
  return [
    {
      target: B20_FACTORY_ADDRESS,
      callData: encodeFunctionData({ abi: b20FactoryAbi, functionName: "isB20Initialized", args: [token] }),
    },
    { target: token, callData: TOKEN_CALL_DATA.decimals },
    { target: token, callData: TOKEN_CALL_DATA.totalSupply },
    { target: token, callData: TOKEN_CALL_DATA.multiplier },
    { target: token, callData: TOKEN_CALL_DATA.newUIMultiplier },
    { target: token, callData: TOKEN_CALL_DATA.effectiveAt },
    { target: token, callData: TOKEN_CALL_DATA.isPaused },
  ];
}

function feedCalls(proxy: Address): Call[] {
  return [
    { target: proxy, callData: FEED_CALL_DATA.decimals },
    { target: proxy, callData: FEED_CALL_DATA.description },
    { target: proxy, callData: FEED_CALL_DATA.latestRoundData },
  ];
}

/** Return data of each call, or `null` for a call that reverted. */
export type CallResults = readonly (Hex | null)[];

/**
 * Runs the calls through Multicall3 at one block, in requests of `CALLS_PER_REQUEST`. A call that reverts
 * yields `null`. A request that fails rejects the whole read, so a transport failure is never mistaken for a
 * reverting call.
 */
async function aggregate(client: MarketClient, calls: readonly Call[], blockNumber: bigint): Promise<CallResults> {
  const requests: Promise<readonly { success: boolean; returnData: Hex }[]>[] = [];
  for (let start = 0; start < calls.length; start += CALLS_PER_REQUEST) {
    const chunk = calls.slice(start, start + CALLS_PER_REQUEST);
    requests.push(
      client.readContract({
        address: MULTICALL3_ADDRESS,
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [chunk.map(({ target, callData }) => ({ target, callData, allowFailure: true }))],
        blockNumber,
      }),
    );
  }
  const results = (await Promise.all(requests)).flat();
  if (results.length !== calls.length) {
    throw new UpstreamError("base_rpc", `multicall returned ${results.length} results for ${calls.length} calls`);
  }
  return results.map(({ success, returnData }) => (success ? returnData : null));
}

/** Decodes one result, or returns `null` when the call reverted or its return data does not decode. */
export function decode<T>(data: Hex | null | undefined, decoder: (data: Hex) => T): T | null {
  if (data === null || data === undefined) return null;
  try {
    return decoder(data);
  } catch {
    return null;
  }
}

function toSafeNumber(value: bigint): number | null {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function decodeUint(data: Hex | null | undefined, functionName: "totalSupply" | "multiplier" | "newUIMultiplier") {
  return decode(data, (value) => decodeFunctionResult({ abi: b20AssetAbi, functionName, data: value }));
}

function decodeToken(results: CallResults, offset: number, blockTimestamp: number): TokenRead {
  const initialized = decode(results[offset], (data) =>
    decodeFunctionResult({ abi: b20FactoryAbi, functionName: "isB20Initialized", data }),
  );
  if (initialized === null) return { status: "read_failed" };
  if (!initialized) return { status: "not_initialized" };
  const decimals = decode(results[offset + 1], (data) =>
    decodeFunctionResult({ abi: b20AssetAbi, functionName: "decimals", data }),
  );
  const totalSupply = decodeUint(results[offset + 2], "totalSupply");
  const multiplierWad = decodeUint(results[offset + 3], "multiplier");
  const pendingMultiplierWad = decodeUint(results[offset + 4], "newUIMultiplier");
  const effectiveAt = decode(results[offset + 5], (data) =>
    toSafeNumber(decodeFunctionResult({ abi: b20AssetAbi, functionName: "effectiveAt", data })),
  );
  const transfersPaused = decode(results[offset + 6], (data) =>
    decodeFunctionResult({ abi: b20AssetAbi, functionName: "isPaused", data }),
  );
  if (
    decimals === null ||
    totalSupply === null ||
    multiplierWad === null ||
    pendingMultiplierWad === null ||
    effectiveAt === null ||
    transfersPaused === null
  ) {
    return { status: "read_failed" };
  }
  // An update is pending while its effective time is ahead of the block. Once it matures, `multiplier()`
  // returns the new value and no event or storage write marks the change.
  const pendingMultiplier = effectiveAt > blockTimestamp ? { multiplierWad: pendingMultiplierWad, effectiveAt } : null;
  return { status: "ok", state: { decimals, totalSupply, multiplierWad, pendingMultiplier, transfersPaused } };
}

function decodeFeed(results: CallResults, offset: number): FeedRead {
  const decimals = decode(results[offset], (data) =>
    decodeFunctionResult({ abi: aggregatorAbi, functionName: "decimals", data }),
  );
  const description = decode(results[offset + 1], (data) =>
    decodeFunctionResult({ abi: aggregatorAbi, functionName: "description", data }),
  );
  const round = decode(results[offset + 2], (data) => {
    const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
      abi: aggregatorAbi,
      functionName: "latestRoundData",
      data,
    });
    const updatedAtSeconds = toSafeNumber(updatedAt);
    return updatedAtSeconds === null ? null : { roundId, answer, updatedAt: updatedAtSeconds, answeredInRound };
  });
  if (decimals === null || description === null || round === null) return { status: "read_failed" };
  return { status: "ok", decimals, description, round };
}

/** The answers of a set of calls, all made at the latest block of an endpoint verified to be Base mainnet. */
export interface BlockRead {
  readonly blockNumber: bigint;
  /** Timestamp of the block, Unix seconds. */
  readonly blockTimestamp: number;
  /** Return data of each call, in the order given, or `null` for a call that reverted. */
  readonly results: CallResults;
}

/**
 * Runs `calls` through Multicall3 at the latest block, together with a chain id check. Read-only:
 * `eth_getBlockByNumber` and `eth_call` are the only RPC methods used.
 *
 * @throws {UpstreamError} if the RPC endpoint fails. A reverting call is not a failure of the read.
 * @throws {MissingConfigurationError} if the endpoint is not Base mainnet.
 */
export async function readAtLatestBlock(client: MarketClient, calls: readonly Call[]): Promise<BlockRead> {
  let block: { number: bigint; timestamp: bigint };
  let results: CallResults;
  try {
    block = await client.getBlock({ blockTag: "latest" });
    results = await aggregate(client, [CHAIN_ID_CALL, ...calls], block.number);
  } catch (cause) {
    if (cause instanceof UpstreamError) throw cause;
    throw new UpstreamError("base_rpc", "read failed", { cause });
  }
  const chainId = decode(results[0], (data) =>
    decodeFunctionResult({ abi: multicall3Abi, functionName: "getChainId", data }),
  );
  if (chainId !== BigInt(BASE_CHAIN_ID)) {
    throw new MissingConfigurationError("BASE_RPC_URL", `does not point to Base mainnet (chain id ${chainId})`);
  }
  const blockTimestamp = toSafeNumber(block.timestamp);
  if (blockTimestamp === null) throw new UpstreamError("base_rpc", "block timestamp is out of range");
  return { blockNumber: block.number, blockTimestamp, results: results.slice(1) };
}

/**
 * Reads the state of every token and of the reference feed of each token that has one, at a single block.
 *
 * @param tokens lowercase token addresses
 * @throws {UpstreamError} if the RPC endpoint fails. A reverting call is not a failure of the read: it is
 *   reported on the token or feed it belongs to.
 * @throws {MissingConfigurationError} if the endpoint is not Base mainnet.
 */
export async function readOnchain(client: MarketClient, tokens: readonly Address[]): Promise<OnchainSnapshot> {
  const feedTokens = tokens.filter((token) => REFERENCE_FEEDS.has(token));
  const calls: Call[] = [];
  for (const token of tokens) calls.push(...tokenCalls(token));
  for (const token of feedTokens) {
    const feed = REFERENCE_FEEDS.get(token);
    if (feed !== undefined) calls.push(...feedCalls(feed.proxy));
  }
  const { blockNumber, blockTimestamp, results } = await readAtLatestBlock(client, calls);
  const tokenReads = new Map<Address, TokenRead>();
  tokens.forEach((token, index) => {
    tokenReads.set(token, decodeToken(results, index * CALLS_PER_TOKEN, blockTimestamp));
  });
  const feedOffset = tokens.length * CALLS_PER_TOKEN;
  const feedReads = new Map<Address, FeedRead>();
  feedTokens.forEach((token, index) => {
    feedReads.set(token, decodeFeed(results, feedOffset + index * CALLS_PER_FEED));
  });
  return { blockNumber, blockTimestamp, tokens: tokenReads, feeds: feedReads };
}
