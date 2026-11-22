import { type CreateConnectorFn, cookieStorage, createConfig, createStorage, http, type Transport } from "wagmi";
import { resolveNetworks, type WalletEnvironment, walletEnvironment } from "./chains";

/** Prefix of the cookies that hold the connection state: which connector, which accounts, which chain. */
export const WALLET_STORAGE_KEY = "equityos.wallet";

/**
 * The wagmi configuration. It is created in the browser only, by `WalletRuntime`, with the connectors of
 * `connectors.ts`. `ssr` keeps wagmi from reading storage on its own, asynchronously: the runtime hands it the
 * state of the cookie instead, synchronously, with `cookieToInitialState` and `hydrate`.
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
