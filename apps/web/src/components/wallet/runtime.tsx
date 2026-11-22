"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { hydrate } from "@wagmi/core";
import { type ReactNode, useState } from "react";
import { cookieToInitialState, WagmiContext } from "wagmi";
import { storedAccount } from "@/lib/wallet/address";
import { createWalletConfig, type WalletConfig } from "@/lib/wallet/config";
import { walletConnectors } from "@/lib/wallet/connectors";

interface Runtime {
  readonly config: WalletConfig;
  readonly queryClient: QueryClient;
}

let runtime: Runtime | undefined;

/**
 * Creates the one wagmi configuration and query cache of the page, the first time a region needs them.
 *
 * The connection state is stored in a cookie because a cookie can be read synchronously: `hydrate` puts the
 * stored state in place before the first render of any region, so a connected visitor is never shown a
 * disconnected control, and then verifies it against the wallet. It reconnects only when the cookie holds a
 * connection: a visitor who never connected does not load any wallet SDK.
 */
function startRuntime(): Runtime {
  if (runtime) return runtime;
  // Read before the configuration exists: creating it writes its empty initial state to the same cookie.
  const cookie = document.cookie;
  const config = createWalletConfig(walletConnectors());
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  const state = cookieToInitialState(config, cookie);
  const reconnectOnMount = storedAccount(state) !== null;
  void hydrate(config, { ...(state ? { initialState: state } : {}), reconnectOnMount }).onMount();
  runtime = { config, queryClient };
  return runtime;
}

/**
 * Provides wagmi and the query cache to a region that uses the wallet. Several regions (the header control, the
 * wallet page) each render one, and all share the same configuration, so they always agree.
 *
 * It must only be rendered in the browser: import the region with `next/dynamic` and `ssr: false`, and give it
 * a placeholder of the same size. That keeps the pages static, and keeps wallet SDKs out of the server bundle
 * and out of the first load of every page.
 */
export function WalletRuntime({ children }: { children: ReactNode }) {
  const [{ config, queryClient }] = useState(startRuntime);
  return (
    <WagmiContext value={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiContext>
  );
}
