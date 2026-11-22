import type { CreateConnectorFn } from "wagmi";
import { baseAccount, injected, walletConnect } from "wagmi/connectors";
import { site } from "@/lib/site";
import { type WalletEnvironment, walletConnectProjectId, walletEnvironment } from "./chains";

/**
 * Connectors of the browser configuration. This is the only module that imports wallet SDKs, and it is only
 * loaded in the browser.
 * - `injected`: the legacy `window.ethereum` provider. Wallets that announce themselves through EIP-6963 are
 *   discovered by wagmi and added as their own connectors, with their own name and icon.
 * - `baseAccount`: Base Account, through the `@base-org/account` SDK, which the connector loads on first use.
 * - `walletConnect`: only when a project id is configured. It shows its own QR code modal.
 */
export function walletConnectors(env: WalletEnvironment = walletEnvironment): CreateConnectorFn[] {
  const connectors: CreateConnectorFn[] = [injected(), baseAccount({ appName: site.name })];
  const projectId = walletConnectProjectId(env);
  if (projectId !== null) {
    const metadata = { name: site.name, description: site.tagline, url: site.url, icons: [] };
    connectors.push(walletConnect({ projectId, metadata }));
  }
  return connectors;
}
