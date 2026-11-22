import "server-only";
import { headers } from "next/headers";
import { cookieToInitialState, type State } from "wagmi";
import { storedAccount } from "@/lib/wallet/address";
import { createWalletConfig } from "@/lib/wallet/config";

/** Only its storage key is used, to find the cookie. It has no connectors and is never connected. */
const config = createWalletConfig();

export interface StoredWalletState {
  /** The connection state wagmi stored in its cookie, `undefined` when there is none. */
  readonly state: State | undefined;
  /** The account that state points at, `null` when there is none or the cookie is not well formed. */
  readonly account: string | null;
}

/**
 * Reads the wallet connection of the request from its cookie, as the wagmi SSR guide prescribes. The cookie
 * holds public data only: the connector, the accounts and the chain. It is a claim by the browser, good for
 * rendering and never for authorization.
 */
export async function readWalletState(): Promise<StoredWalletState> {
  const state = cookieToInitialState(config, (await headers()).get("cookie"));
  return { state, account: storedAccount(state) };
}
