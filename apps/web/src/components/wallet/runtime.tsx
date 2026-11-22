"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { hydrate } from "@wagmi/core";
import { type ReactNode, useState } from "react";
import { type State, WagmiContext } from "wagmi";
import { storedAccount } from "@/lib/wallet/address";
import { createWalletConfig, type WalletConfig } from "@/lib/wallet/config";
import { walletConnectors } from "@/lib/wallet/connectors";
import { useWalletBoot } from "./boot";

interface Runtime {
  readonly config: WalletConfig;
  readonly queryClient: QueryClient;
}

let runtime: Runtime | undefined;

/**
 * Creates the one wagmi configuration and query cache of the page, the first time a region needs them.
 *
 * `hydrate` puts the connection state of the cookie in place synchronously, so the first render of any region
 * already shows the stored account, and then verifies it against the wallet. It reconnects only when the cookie
 * holds a connection: a visitor who never connected does not load any wallet SDK.
 */
function startRuntime(state: State | undefined): Runtime {
  if (runtime) return runtime;
  const config = createWalletConfig(walletConnectors());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  const reconnectOnMount = storedAccount(state) !== null;
  void hydrate(config, { ...(state ? { initialState: state } : {}), reconnectOnMount }).onMount();
  runtime = { config, queryClient };
  return runtime;
}

/**
 * Provides wagmi and the query cache to a region that uses the wallet. Several regions (the header control, the
 * wallet page) each render one, and all share the same configuration, so they always agree.
 *
 * It must only be rendered in the browser: import the region with `next/dynamic` and `ssr: false`. The server
 * renders a stand-in from the cookie state instead, which is what keeps wallet SDKs out of the server bundle and
 * out of the first load of every page.
 */
export function WalletRuntime({ children }: { children: ReactNode }) {
  const { state } = useWalletBoot();
  const [{ config, queryClient }] = useState(() => startRuntime(state));
  return (
    <WagmiContext value={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiContext>
  );
}
