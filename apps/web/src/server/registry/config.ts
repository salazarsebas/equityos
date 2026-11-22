import "server-only";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  DEPLOYMENTS,
  type Deployment,
  isSupportedChainId,
  LOCAL_CHAIN_ID,
  type SupportedChainId,
} from "@equityos/contracts-abi";
import type { Address } from "viem";
import { type MarketEnvironment, resolveBaseRpcUrl } from "../market/config";
import { MissingConfigurationError } from "../market/errors";
import { RegistryConfigurationError } from "./errors";

/** Multicall3, deployed at the same address on Base mainnet and Base Sepolia. A fresh local chain has none. */
export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Public Base Sepolia endpoint: rate limited and best effort, never used when `NODE_ENV` is "production". */
const DEVELOPMENT_SEPOLIA_RPC_URL = "https://sepolia.base.org";
/** Default endpoint of a local Anvil node. */
const LOCAL_RPC_URL = "http://127.0.0.1:8545";

/**
 * Blocks requested per `eth_getLogs` call. Public endpoints reject wide ranges; 2,000 is accepted by the
 * public Base endpoints. A provider with a lower limit needs `EQUITYOS_LOG_CHUNK_BLOCKS`.
 */
export const DEFAULT_LOG_CHUNK_BLOCKS = 2_000n;

/**
 * Blocks an event must be buried under before it is scanned on a live chain. A scanned range is never read
 * again, so the scan stays behind the head by more than a reorganization of the unsafe head can reach.
 */
const LIVE_CONFIRMATIONS = 12n;

export interface RegistryEnvironment extends MarketEnvironment {
  readonly EQUITYOS_CHAIN_ID?: string | undefined;
  readonly EQUITYOS_RPC_URL?: string | undefined;
  readonly EQUITYOS_LOG_CHUNK_BLOCKS?: string | undefined;
}

export interface RegistryConfig {
  readonly chainId: number;
  readonly deployment: Deployment;
  /** Where batched reads go: the Multicall3 address, or "deployless" on a chain that does not have one. */
  readonly multicall: Address | "deployless";
  /** Maximum number of blocks of one `eth_getLogs` request. */
  readonly logChunkBlocks: bigint;
  /** Blocks the event scan stays behind the head. */
  readonly confirmations: bigint;
}

/**
 * Resolves the active chain from `EQUITYOS_CHAIN_ID`. Unset means Base mainnet.
 *
 * @throws {RegistryConfigurationError} if the value is not one of the supported chain ids.
 */
export function resolveChainId(env: RegistryEnvironment = process.env): SupportedChainId {
  const configured = env.EQUITYOS_CHAIN_ID?.trim() ?? "";
  if (configured === "") return BASE_MAINNET_CHAIN_ID;
  const chainId = /^[1-9][0-9]*$/.test(configured) ? Number(configured) : Number.NaN;
  if (!isSupportedChainId(chainId)) {
    const supported = Object.keys(DEPLOYMENTS).join(", ");
    throw new RegistryConfigurationError("EQUITYOS_CHAIN_ID", `is not a supported chain id (${supported})`);
  }
  return chainId;
}

/**
 * Resolves the RPC endpoint of the registry chain.
 *
 * - Base mainnet (8453) is read through `BASE_RPC_URL`, with the rules of the market data layer.
 * - Any other chain is read through `EQUITYOS_RPC_URL`. A local chain (31337) defaults to
 *   `http://127.0.0.1:8545`, Base Sepolia (84532) to its public endpoint outside production.
 *
 * It is resolved when the first request is about to be made, not with the rest of the configuration: a chain
 * without a deployment is never read, so it needs no endpoint.
 *
 * @throws {RegistryConfigurationError} if the variable is unusable, or required and unset.
 */
export function resolveRegistryRpcUrl(chainId: number, env: RegistryEnvironment = process.env): string {
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    try {
      return resolveBaseRpcUrl(env);
    } catch (cause) {
      if (!(cause instanceof MissingConfigurationError)) throw cause;
      throw new RegistryConfigurationError(cause.variable, "is unset in production or is not an http(s) URL", {
        cause,
      });
    }
  }
  const configured = env.EQUITYOS_RPC_URL?.trim() ?? "";
  if (configured === "") {
    if (chainId === LOCAL_CHAIN_ID) return LOCAL_RPC_URL;
    if (chainId === BASE_SEPOLIA_CHAIN_ID && env.NODE_ENV !== "production") return DEVELOPMENT_SEPOLIA_RPC_URL;
    throw new RegistryConfigurationError("EQUITYOS_RPC_URL", "is not set");
  }
  if (!URL.canParse(configured) || !/^https?:$/.test(new URL(configured).protocol)) {
    throw new RegistryConfigurationError("EQUITYOS_RPC_URL", "is not an http or https URL");
  }
  return configured;
}

function resolveLogChunkBlocks(env: RegistryEnvironment): bigint {
  const configured = env.EQUITYOS_LOG_CHUNK_BLOCKS?.trim() ?? "";
  if (configured === "") return DEFAULT_LOG_CHUNK_BLOCKS;
  if (!/^[1-9][0-9]{0,8}$/.test(configured)) {
    throw new RegistryConfigurationError("EQUITYOS_LOG_CHUNK_BLOCKS", "is not a positive integer");
  }
  return BigInt(configured);
}

/**
 * Resolves the chain the registry is read from, its deployment and how it is read.
 *
 * @throws {RegistryConfigurationError} if a variable is unusable.
 */
export function resolveRegistryConfig(env: RegistryEnvironment = process.env): RegistryConfig {
  const chainId = resolveChainId(env);
  const local = chainId === LOCAL_CHAIN_ID;
  return {
    chainId,
    deployment: DEPLOYMENTS[chainId],
    multicall: local ? "deployless" : MULTICALL3_ADDRESS,
    logChunkBlocks: resolveLogChunkBlocks(env),
    confirmations: local ? 0n : LIVE_CONFIRMATIONS,
  };
}

export { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID };
