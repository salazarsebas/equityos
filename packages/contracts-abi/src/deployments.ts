/** A `0x`-prefixed hexadecimal string. */
export type Hex = `0x${string}`;

/** Chain id of Base mainnet. */
export const BASE_MAINNET_CHAIN_ID = 8453;
/** Chain id of Base Sepolia. */
export const BASE_SEPOLIA_CHAIN_ID = 84_532;
/** Chain id of a local development node (Anvil). Never a live network. */
export const LOCAL_CHAIN_ID = 31_337;

/**
 * Address of `IndexRegistry`. Both contracts are deployed with CREATE2 through the deterministic deployment
 * proxy, so the address is the same on every chain. It equals `EXPECTED_REGISTRY` in
 * `contracts/script/Deploy.s.sol`; a test compares the two.
 */
export const INDEX_REGISTRY_ADDRESS = "0x4BD4D49A9C88f75FB97674488E23A7Fa59F9506c";
/** Address of `RebalanceLog`, equal to `EXPECTED_REBALANCE_LOG` in `contracts/script/Deploy.s.sol`. */
export const REBALANCE_LOG_ADDRESS = "0x593449aeF0Efc05528D3BC7bE9eb8d99e39AA41c";

export interface Deployment {
  readonly registry: Hex;
  readonly rebalanceLog: Hex;
  /**
   * Block the contracts were deployed at, the first block an event scan has to cover. `null` means the
   * contracts are not deployed on the chain: the address is known in advance, but there is no code behind it.
   */
  readonly deployBlock: bigint | null;
}

export type SupportedChainId = typeof BASE_MAINNET_CHAIN_ID | typeof BASE_SEPOLIA_CHAIN_ID | typeof LOCAL_CHAIN_ID;

/**
 * The deployment of the contracts on each supported chain.
 *
 * Neither contract is deployed on Base mainnet or Base Sepolia, so both carry `deployBlock: null`. A local
 * chain starts empty on every run: its entry scans from genesis, and whether the contracts are there is
 * established by reading the code at the address.
 */
export const DEPLOYMENTS: Readonly<Record<SupportedChainId, Deployment>> = {
  [BASE_MAINNET_CHAIN_ID]: {
    registry: INDEX_REGISTRY_ADDRESS,
    rebalanceLog: REBALANCE_LOG_ADDRESS,
    deployBlock: null,
  },
  [BASE_SEPOLIA_CHAIN_ID]: {
    registry: INDEX_REGISTRY_ADDRESS,
    rebalanceLog: REBALANCE_LOG_ADDRESS,
    deployBlock: null,
  },
  [LOCAL_CHAIN_ID]: { registry: INDEX_REGISTRY_ADDRESS, rebalanceLog: REBALANCE_LOG_ADDRESS, deployBlock: 0n },
};

/** True if `chainId` is a chain the contracts can be deployed on. */
export function isSupportedChainId(chainId: number): chainId is SupportedChainId {
  return Object.hasOwn(DEPLOYMENTS, chainId);
}
