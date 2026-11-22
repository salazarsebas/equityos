import { type CreateConnectorFn, cookieStorage, createConfig, createStorage, http, type Transport } from "wagmi";
import { resolveNetworks, type WalletEnvironment, walletEnvironment } from "./chains";

/** Prefix of the cookies that hold the connection state: which connector, which accounts, which chain. */
export const WALLET_STORAGE_KEY = "equityos.wallet";

/**
 * The wagmi configuration, as its SSR guide prescribes for the App Router: `ssr` defers every read of browser
 * storage to after mount, and the connection state lives in a cookie so that the server can render it.
 *
 * The server calls this with no connectors, to read the cookie. The browser passes the connectors of
 * `connectors.ts`, which is the only module that imports wallet SDKs.
 */
export function createWalletConfig(
  connectors: readonly CreateConnectorFn[] = [],
  env: WalletEnvironment = walletEnvironment,
) {
  const [home, ...others] = resolveNetworks(env);
  const transports: Record<number, Transport> = {};
  for (const { chain, rpcUrl } of [home, ...others]) transports[chain.id] = http(rpcUrl);
  return createConfig({
    chains: [home.chain, ...others.map(({ chain }) => chain)],
    connectors: [...connectors],
    ssr: true,
    storage: createStorage({ storage: cookieStorage, key: WALLET_STORAGE_KEY }),
    transports,
  });
}

export type WalletConfig = ReturnType<typeof createWalletConfig>;
