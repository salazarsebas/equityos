import { DEPLOYMENTS, isSupportedChainId, LOCAL_CHAIN_ID } from "@equityos/contracts-abi";
import type { Address } from "viem";
import { EXECUTION_CHAIN_ID, KYBERSWAP_EXECUTOR, KYBERSWAP_ROUTER } from "./calldata";

/**
 * USDC on Base mainnet, lowercase: the quote asset of every plan. Circle publishes this address, and the server
 * builds every leg against it.
 */
export const EXECUTION_USDC: Address = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** What a client accepts on a chain where it may send an execution plan. Addresses are lowercase. */
export interface ExecutionNetwork {
  readonly chainId: number;
  /** The only contract a swap may be addressed to, and the only spender an approval may name. */
  readonly router: Address;
  /** The only executor the router may hand tokens to. */
  readonly executor: Address;
  readonly usdc: Address;
  /**
   * `RebalanceLog` where the deployment map records a deployment, with the registry it validates against, or
   * `null` where it does not: there the attestation call is never built.
   */
  readonly rebalanceLog: { readonly address: Address; readonly registry: Address } | null;
}

/** Variables that decide the networks. Public: they are compiled into the browser bundle. */
export interface ExecutionEnvironment {
  readonly NODE_ENV?: string | undefined;
}

function rebalanceLogOf(chainId: number): ExecutionNetwork["rebalanceLog"] {
  if (!isSupportedChainId(chainId)) return null;
  const deployment = DEPLOYMENTS[chainId];
  return deployment.deployBlock === null
    ? null
    : {
        address: deployment.rebalanceLog.toLowerCase() as Address,
        registry: deployment.registry.toLowerCase() as Address,
      };
}

/**
 * The networks on which this build may send an execution plan.
 *
 * Production builds have exactly one: Base mainnet, with the router, the executor and USDC that the calldata
 * verification pins. Development builds add the local Anvil chain (31337), the chain of the browser tests, with
 * the same three addresses: the tests install contracts at those addresses on the local node, so the allowlist
 * is not widened by a single address, and a production build never accepts a plan for any other chain.
 */
export function executionNetworks(env: ExecutionEnvironment = { NODE_ENV: process.env.NODE_ENV }) {
  const pinned = { router: KYBERSWAP_ROUTER, executor: KYBERSWAP_EXECUTOR, usdc: EXECUTION_USDC };
  const networks: ExecutionNetwork[] = [
    { chainId: EXECUTION_CHAIN_ID, ...pinned, rebalanceLog: rebalanceLogOf(EXECUTION_CHAIN_ID) },
  ];
  if (env.NODE_ENV === "development") {
    networks.push({ chainId: LOCAL_CHAIN_ID, ...pinned, rebalanceLog: rebalanceLogOf(LOCAL_CHAIN_ID) });
  }
  return networks;
}

/** The execution network of `chainId`, or `null` when this build does not send plans on that chain. */
export function executionNetwork(
  chainId: number,
  env: ExecutionEnvironment = { NODE_ENV: process.env.NODE_ENV },
): ExecutionNetwork | null {
  return executionNetworks(env).find((network) => network.chainId === chainId) ?? null;
}
