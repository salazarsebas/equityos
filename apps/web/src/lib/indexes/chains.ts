/**
 * Public facts about the chains the registry can be read from. The RPC endpoints here are the public ones
 * anyone can use to repeat a read. The endpoint the server itself is configured with is never shown.
 */
interface ChainFacts {
  readonly name: string;
  readonly publicRpcUrl: string;
  /** Base URL of a public block explorer. `null` for a chain that has none. */
  readonly explorerUrl: string | null;
}

const CHAINS: Readonly<Record<number, ChainFacts>> = {
  8453: { name: "Base", publicRpcUrl: "https://mainnet.base.org", explorerUrl: "https://basescan.org" },
  84532: {
    name: "Base Sepolia",
    publicRpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
  },
  31337: { name: "Local development chain", publicRpcUrl: "http://127.0.0.1:8545", explorerUrl: null },
};

/** Display name of a chain: `Base`, or `Chain 1` for one this application has no name for. */
export function chainName(chainId: number): string {
  return CHAINS[chainId]?.name ?? `Chain ${chainId}`;
}

/** The public JSON-RPC endpoint of a chain, or `null` when none is known. */
export function publicRpcUrl(chainId: number): string | null {
  return CHAINS[chainId]?.publicRpcUrl ?? null;
}

/** URL of an address on the public explorer of the chain, or `null` when the chain has no explorer. */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const base = CHAINS[chainId]?.explorerUrl ?? null;
  return base === null ? null : `${base}/address/${address}`;
}

/** URL of a transaction on the public explorer of the chain, or `null` when the chain has no explorer. */
export function explorerTransactionUrl(chainId: number, hash: string): string | null {
  const base = CHAINS[chainId]?.explorerUrl ?? null;
  return base === null ? null : `${base}/tx/${hash}`;
}
