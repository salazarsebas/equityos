"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { State } from "wagmi";

interface WalletBoot {
  /** Connection state read from the cookie by the server, handed to wagmi when the wallet code has loaded. */
  readonly state: State | undefined;
  /** The account that state points at, for what is rendered before the wallet code has loaded. */
  readonly account: string | null;
}

const WalletBootContext = createContext<WalletBoot>({ state: undefined, account: null });

/**
 * Carries the stored connection from the server render to the wallet code, which loads after the page is
 * interactive. It holds data only: no wallet library is imported here, so it costs the pages nothing.
 */
export function WalletBootProvider({ state, account, children }: WalletBoot & { children: ReactNode }) {
  const value = useMemo(() => ({ state, account }), [state, account]);
  return <WalletBootContext value={value}>{children}</WalletBootContext>;
}

export function useWalletBoot(): WalletBoot {
  return useContext(WalletBootContext);
}

/**
 * What the account control must pick up from the button that stood in for it while its code loaded: a click
 * that asked for it, and keyboard focus. Written in the browser only.
 */
export const handoff = { open: false, focus: false };
