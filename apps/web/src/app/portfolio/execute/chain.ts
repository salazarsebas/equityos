"use client";

import type { Address, Chain, Hex } from "viem";
import type { Config } from "wagmi";
import { getPublicClient } from "wagmi/actions";
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
