import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  DEPLOYMENTS,
  INDEX_REGISTRY_ADDRESS,
  isSupportedChainId,
  LOCAL_CHAIN_ID,
  REBALANCE_LOG_ADDRESS,
} from "../src/index.ts";

const deployScript = readFileSync(new URL("../../../contracts/script/Deploy.s.sol", import.meta.url), "utf8");

/** The literal assigned to a `constant` of the deployment script. */
function scriptConstant(name: string): string {
  const match = new RegExp(`constant ${name} =\\s*([0-9a-fA-Fx_]+);`).exec(deployScript);
  if (match?.[1] === undefined) throw new Error(`Deploy.s.sol has no constant ${name}`);
  return match[1];
}

test("the addresses are the ones the deployment script expects", () => {
  expect<string>(INDEX_REGISTRY_ADDRESS).toBe(scriptConstant("EXPECTED_REGISTRY"));
  expect<string>(REBALANCE_LOG_ADDRESS).toBe(scriptConstant("EXPECTED_REBALANCE_LOG"));
});

test("the chain ids are the ones the deployment script accepts", () => {
  const chainId = (name: string) => Number(scriptConstant(name).replaceAll("_", ""));
  expect(BASE_MAINNET_CHAIN_ID).toBe(chainId("BASE_MAINNET_CHAIN_ID"));
  expect(BASE_SEPOLIA_CHAIN_ID).toBe(chainId("BASE_SEPOLIA_CHAIN_ID"));
  expect(LOCAL_CHAIN_ID).toBe(chainId("LOCAL_CHAIN_ID"));
  expect(Object.keys(DEPLOYMENTS).map(Number).sort()).toEqual(
    [BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID].sort(),
  );
});

test("every chain uses the deterministic addresses", () => {
  for (const deployment of Object.values(DEPLOYMENTS)) {
    expect(deployment.registry).toBe(INDEX_REGISTRY_ADDRESS);
    expect(deployment.rebalanceLog).toBe(REBALANCE_LOG_ADDRESS);
  }
});

test("no live network is marked as deployed", () => {
  expect(DEPLOYMENTS[BASE_MAINNET_CHAIN_ID].deployBlock).toBeNull();
  expect(DEPLOYMENTS[BASE_SEPOLIA_CHAIN_ID].deployBlock).toBeNull();
  expect(DEPLOYMENTS[LOCAL_CHAIN_ID].deployBlock).toBe(0n);
});

test("isSupportedChainId accepts exactly the chains of the map", () => {
  expect(isSupportedChainId(8453)).toBe(true);
  expect(isSupportedChainId(84_532)).toBe(true);
  expect(isSupportedChainId(31_337)).toBe(true);
  expect(isSupportedChainId(1)).toBe(false);
  expect(isSupportedChainId(Number.NaN)).toBe(false);
});
