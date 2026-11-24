import "server-only";
import { type Address, decodeFunctionResult, encodeFunctionData } from "viem";
import { erc20BalanceAbi } from "./abis";
import { decode, type MarketClient, readAtLatestBlock } from "./onchain";

/**
 * USDC on Base mainnet, the quote asset of every plan, lowercase. It is the address Circle publishes for its
 * native USDC on Base, with 6 decimals.
 */
export const USDC_ADDRESS: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** The balances of one account, all read at one Base mainnet block. */
export interface BalanceRead {
  readonly account: Address;
  readonly blockNumber: bigint;
  /** Timestamp of the block, Unix seconds. */
  readonly blockTimestamp: number;
  /**
   * Token base units, keyed by lowercase token address. `null` when `balanceOf` reverted or answered something
   * that is not a uint256: a failed read is never reported as a zero balance.
   */
  readonly balances: ReadonlyMap<Address, bigint | null>;
}

/**
 * Reads `balanceOf(account)` of every token in one Multicall3 request at the latest block. Read-only.
 *
 * @param account lowercase account address
 * @param tokens lowercase token addresses
 * @throws {UpstreamError} if the RPC endpoint fails.
 * @throws {MissingConfigurationError} if the endpoint is not Base mainnet.
 */
export async function readBalances(
  client: MarketClient,
  account: Address,
  tokens: readonly Address[],
): Promise<BalanceRead> {
  const callData = encodeFunctionData({ abi: erc20BalanceAbi, functionName: "balanceOf", args: [account] });
  const { blockNumber, blockTimestamp, results } = await readAtLatestBlock(
    client,
    tokens.map((target) => ({ target, callData })),
  );
  const balances = new Map<Address, bigint | null>();
  tokens.forEach((token, index) => {
    balances.set(
      token,
      decode(results[index], (data) => decodeFunctionResult({ abi: erc20BalanceAbi, functionName: "balanceOf", data })),
    );
  });
  return { account, blockNumber, blockTimestamp, balances };
}
