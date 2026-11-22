import { describe, expect, test } from "bun:test";
import { base, mainnet } from "viem/chains";
import { addressExplorer, resolveNetworks, walletConnectProjectId } from "../../src/lib/wallet/chains";
import { createWalletConfig } from "../../src/lib/wallet/config";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("resolveNetworks", () => {
  test("Base mainnet first, then Base Sepolia, on the public endpoints by default", () => {
    expect(resolveNetworks({ NODE_ENV: "production" }).map(({ chain, rpcUrl }) => [chain.id, rpcUrl])).toEqual([
      [8453, "https://mainnet.base.org"],
      [84532, "https://sepolia.base.org"],
    ]);
  });

  test("the local Anvil chain exists in development only", () => {
    const ids = (NODE_ENV: string) => resolveNetworks({ NODE_ENV }).map(({ chain }) => chain.id);
    expect(ids("development")).toEqual([8453, 84532, 31337]);
    expect(ids("test")).toEqual([8453, 84532]);
    expect(resolveNetworks({ NODE_ENV: "development" })[2]?.rpcUrl).toBe("http://127.0.0.1:8545");
  });

  test("uses the configured endpoints", () => {
    const networks = resolveNetworks({
      NODE_ENV: "development",
      NEXT_PUBLIC_BASE_RPC_URL: " https://rpc.example/base ",
      NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "https://rpc.example/sepolia",
      NEXT_PUBLIC_ANVIL_RPC_URL: "http://localhost:9545",
    });
    expect(networks.map(({ rpcUrl }) => rpcUrl)).toEqual([
      "https://rpc.example/base",
      "https://rpc.example/sepolia",
      "http://localhost:9545",
    ]);
  });

  test("rejects an endpoint that is not an http or https URL", () => {
    expect(() => resolveNetworks({ NEXT_PUBLIC_BASE_RPC_URL: "wss://rpc.example" })).toThrow(
      "NEXT_PUBLIC_BASE_RPC_URL is not an http or https URL",
    );
    expect(() => resolveNetworks({ NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: "not a url" })).toThrow(
      "NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL",
    );
  });
});

describe("walletConnectProjectId", () => {
  test("is null unless a project id is set", () => {
    expect(walletConnectProjectId({})).toBeNull();
    expect(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "  " })).toBeNull();
    expect(walletConnectProjectId({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: " abc123 " })).toBe("abc123");
  });
});

describe("addressExplorer", () => {
  test("uses the explorer of the chain, or the Base one when the chain has none", () => {
    expect(addressExplorer(base, ACCOUNT).url).toBe(`https://basescan.org/address/${ACCOUNT}`);
    expect(addressExplorer(mainnet, ACCOUNT).url).toBe(`https://etherscan.io/address/${ACCOUNT}`);
    expect(addressExplorer(undefined, ACCOUNT)).toEqual({
      name: "Basescan",
      url: `https://basescan.org/address/${ACCOUNT}`,
    });
  });
});

describe("createWalletConfig", () => {
  test("configures the resolved chains for server rendering with cookie storage", () => {
    const config = createWalletConfig([], { NODE_ENV: "development" });
    expect(config.chains.map(({ id }) => id)).toEqual([8453, 84532, 31337]);
    expect(config.storage?.key).toBe("equityos.wallet");
    expect(config.connectors).toEqual([]);
    expect(createWalletConfig([], { NODE_ENV: "production" }).chains.map(({ id }) => id)).toEqual([8453, 84532]);
  });
});
