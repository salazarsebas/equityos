import type { Chain } from "viem";
import { anvil, base, baseSepolia } from "viem/chains";

/** Base mainnet: the chain every balance and reference price of the app is read from. */
export const HOME_CHAIN = base;

/** Variables of the wallet layer. All are public: they are compiled into the browser bundle. */
export interface WalletEnvironment {
  readonly NODE_ENV?: string | undefined;
  readonly NEXT_PUBLIC_BASE_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_ANVIL_RPC_URL?: string | undefined;
  readonly NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?: string | undefined;
}

/** Next.js inlines a `NEXT_PUBLIC_*` variable only where it is read by its full name, so each is read here. */
export const walletEnvironment: WalletEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_BASE_RPC_URL: process.env.NEXT_PUBLIC_BASE_RPC_URL,
  NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  NEXT_PUBLIC_ANVIL_RPC_URL: process.env.NEXT_PUBLIC_ANVIL_RPC_URL,
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
};

export interface WalletNetwork {
  readonly chain: Chain;
  /** JSON-RPC endpoint the browser reads this chain from. */
  readonly rpcUrl: string;
}

function rpcUrl(variable: keyof WalletEnvironment, env: WalletEnvironment, fallback: string): string {
  const configured = env[variable]?.trim() ?? "";
  if (configured === "") return fallback;
  if (!URL.canParse(configured) || !/^https?:$/.test(new URL(configured).protocol)) {
    throw new Error(`${variable} is not an http or https URL`);
  }
  return configured;
}

/**
 * The chains a wallet can be on, Base mainnet first, each with the endpoint the browser reads it from.
 *
 * The fallbacks are the public endpoints. They are rate limited and best effort, so they suit local development
 * only: a deployment sets the `NEXT_PUBLIC_*_RPC_URL` variables. The local Anvil chain exists in development
 * builds only.
 *
 * @throws {Error} if a configured endpoint is not an http(s) URL.
 */
export function resolveNetworks(
  env: WalletEnvironment = walletEnvironment,
): readonly [WalletNetwork, ...WalletNetwork[]] {
  const networks: [WalletNetwork, ...WalletNetwork[]] = [
    { chain: base, rpcUrl: rpcUrl("NEXT_PUBLIC_BASE_RPC_URL", env, "https://mainnet.base.org") },
    { chain: baseSepolia, rpcUrl: rpcUrl("NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL", env, "https://sepolia.base.org") },
  ];
  if (env.NODE_ENV === "development") {
    networks.push({ chain: anvil, rpcUrl: rpcUrl("NEXT_PUBLIC_ANVIL_RPC_URL", env, "http://127.0.0.1:8545") });
  }
  return networks;
}

/** The WalletConnect project id, or `null` when none is configured and the option must not be offered. */
export function walletConnectProjectId(env: WalletEnvironment = walletEnvironment): string | null {
  const id = env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";
  return id === "" ? null : id;
}

export interface Explorer {
  readonly name: string;
  /** Page of the address on the explorer. */
  readonly url: string;
}

/**
 * Block explorer page of an address. A chain with no explorer of its own (a local node, or a chain the app does
 * not use) gets the Base mainnet one: an address is the same on every EVM chain.
 */
export function addressExplorer(chain: Chain | undefined, address: string): Explorer {
  const explorer = chain?.blockExplorers?.default ?? HOME_CHAIN.blockExplorers.default;
  return { name: explorer.name, url: `${explorer.url}/address/${address}` };
}
