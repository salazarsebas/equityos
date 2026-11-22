import { describe, expect, test } from "bun:test";
import { DEPLOYMENTS } from "@equityos/contracts-abi";
import {
  RegistryConfigurationError,
  resolveChainId,
  resolveRegistryConfig,
  resolveRegistryRpcUrl,
} from "../../src/server/registry";
import { DEFAULT_LOG_CHUNK_BLOCKS, MULTICALL3_ADDRESS } from "../../src/server/registry/config";

describe("resolveChainId", () => {
  test("defaults to Base mainnet", () => {
    expect(resolveChainId({})).toBe(8453);
    expect(resolveChainId({ EQUITYOS_CHAIN_ID: "  " })).toBe(8453);
  });

  test("accepts the supported chain ids", () => {
    expect(resolveChainId({ EQUITYOS_CHAIN_ID: "8453" })).toBe(8453);
    expect(resolveChainId({ EQUITYOS_CHAIN_ID: " 84532 " })).toBe(84_532);
    expect(resolveChainId({ EQUITYOS_CHAIN_ID: "31337" })).toBe(31_337);
  });

  test.each(["1", "0", "-8453", "8453.0", "0x2105", "base", "08453", "8453 31337"])("rejects %p", (value) => {
    const attempt = () => resolveChainId({ EQUITYOS_CHAIN_ID: value });
    expect(attempt).toThrow(RegistryConfigurationError);
    expect(attempt).toThrow("EQUITYOS_CHAIN_ID is not a supported chain id (8453, 31337, 84532)");
  });
});

describe("resolveRegistryConfig", () => {
  test("Base mainnet is read through Multicall3, behind the head", () => {
    expect(resolveRegistryConfig({})).toEqual({
      chainId: 8453,
      deployment: DEPLOYMENTS[8453],
      multicall: MULTICALL3_ADDRESS,
      logChunkBlocks: DEFAULT_LOG_CHUNK_BLOCKS,
      confirmations: 12n,
    });
    expect(resolveRegistryConfig({ EQUITYOS_CHAIN_ID: "84532" })).toMatchObject({
      chainId: 84_532,
      deployment: DEPLOYMENTS[84_532],
      multicall: MULTICALL3_ADDRESS,
      confirmations: 12n,
    });
  });

  test("a local chain is read without Multicall3 and waits for no confirmation", () => {
    expect(resolveRegistryConfig({ EQUITYOS_CHAIN_ID: "31337" })).toEqual({
      chainId: 31_337,
      deployment: DEPLOYMENTS[31_337],
      multicall: "deployless",
      logChunkBlocks: DEFAULT_LOG_CHUNK_BLOCKS,
      confirmations: 0n,
    });
  });

  test("needs no RPC endpoint, so a chain without the registry is usable in production as it is", () => {
    expect(resolveRegistryConfig({ NODE_ENV: "production" }).deployment.deployBlock).toBeNull();
    expect(resolveRegistryConfig({ NODE_ENV: "production", EQUITYOS_CHAIN_ID: "84532" }).chainId).toBe(84_532);
  });

  test("the log range is configurable and must be a positive integer", () => {
    expect(resolveRegistryConfig({ EQUITYOS_LOG_CHUNK_BLOCKS: "500" }).logChunkBlocks).toBe(500n);
    for (const value of ["0", "-1", "1.5", "1e3", "ten", "1000000000000"]) {
      expect(() => resolveRegistryConfig({ EQUITYOS_LOG_CHUNK_BLOCKS: value })).toThrow(
        "EQUITYOS_LOG_CHUNK_BLOCKS is not a positive integer",
      );
    }
  });
});

describe("resolveRegistryRpcUrl", () => {
  test("Base mainnet uses BASE_RPC_URL, required in production", () => {
    expect(resolveRegistryRpcUrl(8453, { BASE_RPC_URL: "https://rpc.example/v1" })).toBe("https://rpc.example/v1");
    expect(resolveRegistryRpcUrl(8453, { EQUITYOS_RPC_URL: "https://ignored.example" })).toBe(
      "https://mainnet.base.org",
    );
    const attempt = () => resolveRegistryRpcUrl(8453, { NODE_ENV: "production" });
    expect(attempt).toThrow(RegistryConfigurationError);
    expect(attempt).toThrow(/^BASE_RPC_URL /);
  });

  test("a local chain defaults to the Anvil endpoint, also in production", () => {
    expect(resolveRegistryRpcUrl(31_337, { NODE_ENV: "production" })).toBe("http://127.0.0.1:8545");
    const custom = { EQUITYOS_RPC_URL: " http://127.0.0.1:9000 ", BASE_RPC_URL: "https://rpc.example" };
    expect(resolveRegistryRpcUrl(31_337, custom)).toBe("http://127.0.0.1:9000");
  });

  test("Base Sepolia uses EQUITYOS_RPC_URL, required in production", () => {
    expect(resolveRegistryRpcUrl(84_532, {})).toBe("https://sepolia.base.org");
    expect(resolveRegistryRpcUrl(84_532, { EQUITYOS_RPC_URL: "https://sepolia.example" })).toBe(
      "https://sepolia.example",
    );
    expect(() => resolveRegistryRpcUrl(84_532, { NODE_ENV: "production" })).toThrow("EQUITYOS_RPC_URL is not set");
  });

  test("a chain without a known endpoint has no default", () => {
    expect(() => resolveRegistryRpcUrl(1, {})).toThrow("EQUITYOS_RPC_URL is not set");
  });

  test.each(["ftp://rpc.example", "rpc.example", "ws://127.0.0.1:8545"])("rejects the RPC URL %p", (url) => {
    expect(() => resolveRegistryRpcUrl(31_337, { EQUITYOS_RPC_URL: url })).toThrow(
      "EQUITYOS_RPC_URL is not an http or https URL",
    );
  });
});
