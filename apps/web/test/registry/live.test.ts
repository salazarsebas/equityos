/**
 * Live check of the deployment map against Base mainnet and Base Sepolia. Read-only: `eth_chainId` and
 * `eth_getCode` only. Skipped unless `LIVE_TESTS=1`, so it never runs in CI:
 *
 *   LIVE_TESTS=1 bun test test/registry/live.test.ts
 *
 * It fails when the map and a chain disagree, in either direction: a chain marked as not deployed that has
 * code at the registry address, or a chain with a deploy block that has none. On a deployed chain the code must
 * be the build of this commit, by runtime code hash, and the head must be at or past the deploy block.
 */
import { describe, expect, test } from "bun:test";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  INDEX_REGISTRY_CODE_HASH,
  REBALANCE_LOG_CODE_HASH,
} from "@equityos/contracts-abi";
import { createPublicClient, http, keccak256 } from "viem";
import { resolveRegistryConfig, resolveRegistryRpcUrl } from "../../src/server/registry";
import { MULTICALL3_ADDRESS } from "../../src/server/registry/config";

const live = process.env.LIVE_TESTS === "1";

describe.skipIf(!live)("live: deployment map", () => {
  test.each([BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID])("chain %d matches its entry", async (chainId) => {
    const config = resolveRegistryConfig({ EQUITYOS_CHAIN_ID: String(chainId) });
    const client = createPublicClient({ transport: http(resolveRegistryRpcUrl(chainId)) });
    expect(await client.getChainId()).toBe(chainId);
    const hasCode = async (address: `0x${string}`) => ((await client.getCode({ address })) ?? "0x") !== "0x";
    const deployed = config.deployment.deployBlock !== null;
    expect(await hasCode(config.deployment.registry)).toBe(deployed);
    expect(await hasCode(config.deployment.rebalanceLog)).toBe(deployed);
    if (config.deployment.deployBlock !== null) {
      const codeHash = async (address: `0x${string}`) => keccak256((await client.getCode({ address })) ?? "0x");
      expect(await codeHash(config.deployment.registry)).toBe(INDEX_REGISTRY_CODE_HASH);
      expect(await codeHash(config.deployment.rebalanceLog)).toBe(REBALANCE_LOG_CODE_HASH);
      expect(await client.getBlockNumber()).toBeGreaterThanOrEqual(config.deployment.deployBlock);
    }
    expect(config.multicall).toBe(MULTICALL3_ADDRESS);
    expect(await hasCode(MULTICALL3_ADDRESS)).toBe(true);
  });
});
