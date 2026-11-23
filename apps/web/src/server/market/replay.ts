import "server-only";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  type PublicClient,
} from "viem";
import { erc20BalanceAbi, multicall3Abi } from "./abis";
import { type AssetList, type ListedAsset, parseAssetListPage } from "./asset-list";
import { MissingConfigurationError } from "./errors";
import { type OnchainSnapshot, readOnchain } from "./onchain";

/**
 * Replay of a recording: the pages of the asset list API and the Multicall3 calls of one Base mainnet block,
 * in the format of `apps/web/test/fixtures/market`. It lets the browser tests run the real pages and routes
 * with no network and a fixed clock. A replayed snapshot is real data of a past block, never current data, so
 * every surface that shows it must say so: see `marketDataMode`.
 *
 * An optional `balances.json` adds token balances for a few fixed accounts. They are constructed for the
 * tests, not read from any chain, and every surface that shows them says so.
 */
export const REPLAY_VARIABLE = "MARKET_REPLAY_DIR";

interface RecordedAnswer {
  readonly success: boolean;
  readonly returnData: Hex;
}

function invalid(file: string, problem: string): MissingConfigurationError {
  return new MissingConfigurationError(REPLAY_VARIABLE, `holds an unusable ${file}: ${problem}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(directory: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, file), "utf8"));
  } catch {
    throw invalid(file, "it cannot be read as JSON");
  }
  if (!isRecord(parsed)) throw invalid(file, "it is not an object");
  return parsed;
}

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function callKey(target: string, callData: string): string {
  return `${target}:${callData}`.toLowerCase();
}

function readAssetList(directory: string): AssetList {
  const file = "asset-list.json";
  const { pages } = readRecord(directory, file);
  if (!Array.isArray(pages)) throw invalid(file, "pages is not an array");
  const assets = new Map<Address, ListedAsset>();
  for (const page of pages as readonly unknown[]) {
    for (const token of parseAssetListPage(page).tokens) assets.set(token.address, token);
  }
  if (assets.size === 0) throw invalid(file, "it lists no token");
  return assets;
}

/** Constructed balances: base units per token, per account, all lowercase. A token not listed is held at zero. */
type ConstructedBalances = ReadonlyMap<string, ReadonlyMap<string, bigint>>;

function readBalanceFixture(directory: string): ConstructedBalances {
  const file = "balances.json";
  if (!existsSync(join(directory, file))) return new Map();
  const { accounts } = readRecord(directory, file);
  if (!isRecord(accounts)) throw invalid(file, "accounts is not an object");
  const result = new Map<string, Map<string, bigint>>();
  for (const [account, entry] of Object.entries(accounts)) {
    const tokens = isRecord(entry) ? entry.tokens : undefined;
    if (!isRecord(tokens)) throw invalid(file, `account ${account} has no tokens object`);
    const held = new Map<string, bigint>();
    for (const [token, amount] of Object.entries(tokens)) {
      if (typeof amount !== "string" || !/^\d+$/.test(amount)) throw invalid(file, `${token} is not an integer`);
      held.set(token.toLowerCase(), BigInt(amount));
    }
    result.set(account.toLowerCase(), held);
  }
  return result;
}

/** The answer of a `balanceOf` call from the constructed balances, or `undefined` for any other call. */
function balanceAnswer(balances: ConstructedBalances, target: string, callData: Hex): RecordedAnswer | undefined {
  let account: string;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20BalanceAbi, data: callData });
    if (functionName !== "balanceOf") return undefined;
    account = args[0].toLowerCase();
  } catch {
    return undefined;
  }
  const held = balances.get(account);
  if (held === undefined) throw new Error(`the recording holds no balances for ${account}`);
  const result = held.get(target.toLowerCase()) ?? 0n;
  return {
    success: true,
    returnData: encodeFunctionResult({ abi: erc20BalanceAbi, functionName: "balanceOf", result }),
  };
}

/** A client that answers the block request and every Multicall3 request from the recording, and nothing else. */
function recordedClient(directory: string): PublicClient {
  const file = "onchain.json";
  const { blockNumber, blockTimestamp, calls } = readRecord(directory, file);
  if (typeof blockNumber !== "string" || !/^\d+$/.test(blockNumber))
    throw invalid(file, "blockNumber is not an integer");
  if (typeof blockTimestamp !== "number" || !Number.isSafeInteger(blockTimestamp)) {
    throw invalid(file, "blockTimestamp is not an integer");
  }
  if (!Array.isArray(calls)) throw invalid(file, "calls is not an array");
  const recorded = new Map<string, RecordedAnswer>();
  for (const call of calls as readonly unknown[]) {
    const { target, callData, success, returnData } = isRecord(call) ? call : {};
    if (!isHex(target) || !isHex(callData) || typeof success !== "boolean" || !isHex(returnData)) {
      throw invalid(file, "a call does not have target, callData, success and returnData");
    }
    recorded.set(callKey(target, callData), { success, returnData });
  }
  const balances = readBalanceFixture(directory);
  const block = { number: `0x${BigInt(blockNumber).toString(16)}`, timestamp: `0x${blockTimestamp.toString(16)}` };
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
        if (method === "eth_getBlockByNumber") return { ...block, transactions: [] };
        const call: unknown = Array.isArray(params) ? params[0] : undefined;
        const data = isRecord(call) ? call.data : undefined;
        if (method !== "eth_call" || !isHex(data)) throw new Error(`the recording has no answer for ${method}`);
        const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
        if (functionName !== "aggregate3") throw new Error(`the recording has no answer for ${functionName}`);
        const result = args[0].map(({ target, callData }) => {
          const answer = recorded.get(callKey(target, callData)) ?? balanceAnswer(balances, target, callData);
          if (answer === undefined) throw new Error(`call to ${target} was not recorded`);
          return answer;
        });
        return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result });
      },
    },
    { retryCount: 0 },
  );
  return createPublicClient({ transport });
}

/**
 * Loads the recording in `directory`: `asset-list.json`, `onchain.json` and, when present, `balances.json`.
 * The client keeps answering from the recording, for the balance reads made later.
 *
 * @throws {MissingConfigurationError} if a file is missing or does not have the recorded shape.
 * @throws {UpstreamError} if the recording does not answer a call the read makes.
 */
export async function loadReplay(
  directory: string,
): Promise<{ assetList: AssetList; onchain: OnchainSnapshot; client: PublicClient }> {
  const assetList = readAssetList(directory);
  const client = recordedClient(directory);
  const onchain = await readOnchain(client, [...assetList.keys()]);
  return { assetList, onchain, client };
}
