"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Address } from "viem";
import { useCapabilities, useConnection, useReadContracts, useWatchBlockNumber } from "wagmi";
import {
  BALANCE_OF_ABI,
  type TokenBalance,
  type TokenRef,
  toTokenBalances,
  type USDC,
  withUsdc,
} from "@/lib/wallet/balances";
import {
  BATCHING_PENDING,
  type Batching,
  classifyCapabilities,
  classifyCapabilitiesError,
} from "@/lib/wallet/capabilities";
import { HOME_CHAIN } from "@/lib/wallet/chains";
import {
  EXECUTION_CHECKING,
  EXECUTION_STATUS_UNAVAILABLE,
  type ExecutionAvailability,
  parseExecutionAvailability,
} from "@/lib/wallet/execution";

/**
 * Whether the connected wallet can execute several calls as one atomic batch (`wallet_sendCalls`, EIP-5792) for
 * the connected account on the connected chain. `unknown` until the wallet has answered, and whenever nothing
 * is connected. The decision itself is in `classifyCapabilities`.
 */
export function useWalletCapabilities(): Batching {
  const { address, chainId, status } = useConnection();
  const query = useCapabilities({
    ...(address ? { account: address } : {}),
    query: { enabled: status === "connected", retry: false, staleTime: 60_000 },
  });
  if (status !== "connected" || chainId === undefined) return BATCHING_PENDING;
  if (query.isSuccess) return classifyCapabilities(query.data, chainId);
  return query.isError ? classifyCapabilitiesError(query.error) : BATCHING_PENDING;
}

/**
 * Whether execution is available to this visitor, from `GET /api/v1/status`, with the reason when it is not.
 * Every action that would send a transaction is disabled with that reason. It never gates connecting or reading.
 *
 * @param enabled set to `false` to defer the request until the region that shows the answer is open
 */
export function useExecutionAvailability(enabled = true): ExecutionAvailability {
  const query = useQuery({
    queryKey: ["api", "v1", "status", "execution"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/v1/status", { signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`GET /api/v1/status answered ${response.status}`);
      return parseExecutionAvailability(await response.json());
    },
    enabled,
    staleTime: 5 * 60_000,
  });
  if (query.isSuccess) return query.data;
  return query.isError ? EXECUTION_STATUS_UNAVAILABLE : EXECUTION_CHECKING;
}

/** How long a balance read is served without asking the chain again. */
const BALANCE_STALE_MS = 30_000;

export type TokenBalancesState<token extends TokenRef> =
  /** No account was given. */
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  /** The read failed and there is no earlier one to show. */
  | { readonly status: "error"; readonly refetch: () => void }
  | {
      readonly status: "ready";
      readonly balances: readonly TokenBalance<token | typeof USDC>[];
      /** Time of the read the balances come from, Unix seconds. */
      readonly readAt: number;
      /** The read is older than the stale time. */
      readonly stale: boolean;
      /** The latest refresh failed, so the balances are those of an earlier read. */
      readonly refreshFailed: boolean;
      readonly refreshing: boolean;
      readonly refetch: () => void;
    };

/**
 * Balances of an account on Base mainnet: USDC first, then the given tokens, read in one multicall. Amounts are
 * `bigint` base units, to be read with the decimals of each token. A token whose read fails has a `null`
 * balance, never zero.
 *
 * A read is reused for 30 seconds and is not repeated on focus. There is no polling unless `refetchOnBlock` is
 * set, which re-reads when a new block is seen: opt in only where balances must follow the chain.
 */
export function useTokenBalances<token extends TokenRef>({
  account,
  tokens,
  refetchOnBlock = false,
}: {
  account: Address | undefined;
  tokens: readonly token[];
  refetchOnBlock?: boolean;
}): TokenBalancesState<token> {
  const tracked = useMemo(() => withUsdc(tokens), [tokens]);
  const query = useReadContracts({
    allowFailure: true,
    contracts: account
      ? tracked.map(({ address }) => ({
          chainId: HOME_CHAIN.id,
          address,
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf" as const,
          args: [account] as const,
        }))
      : [],
    query: { enabled: account !== undefined, staleTime: BALANCE_STALE_MS },
  });
  const { refetch } = query;
  useWatchBlockNumber({
    chainId: HOME_CHAIN.id,
    enabled: refetchOnBlock && account !== undefined,
    onBlockNumber: () => void refetch(),
  });

  if (account === undefined) return { status: "idle" };
  if (query.data === undefined) {
    return query.isError ? { status: "error", refetch: () => void refetch() } : { status: "loading" };
  }
  return {
    status: "ready",
    balances: toTokenBalances(tracked, query.data),
    readAt: Math.floor(query.dataUpdatedAt / 1000),
    stale: query.isStale,
    refreshFailed: query.isRefetchError,
    refreshing: query.isRefetching,
    refetch: () => void refetch(),
  };
}
