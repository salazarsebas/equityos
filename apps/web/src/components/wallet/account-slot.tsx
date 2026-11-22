"use client";

import dynamic from "next/dynamic";
import { useLayoutEffect, useRef } from "react";
import { AccountButton } from "./account-button";
import { handoff, useWalletBoot } from "./boot";

/**
 * Stands in for the account control until its code has loaded. It shows the account stored in the cookie, so a
 * connected visitor never sees a disconnected state. A click is remembered and keyboard focus is handed over, so
 * the stand-in is never a dead control.
 */
function AccountStandIn() {
  const { account } = useWalletBoot();
  const ref = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const button = ref.current;
    return () => {
      handoff.focus = button !== null && document.activeElement === button;
    };
  }, []);
  return (
    <AccountButton
      ref={ref}
      account={account}
      onClick={() => {
        handoff.open = true;
      }}
    />
  );
}

const AccountControl = dynamic(() => import("./account-control").then((module) => module.AccountControl), {
  ssr: false,
  loading: AccountStandIn,
});

/**
 * The account control of the top bar. Everything that needs a wallet library is in a chunk that is fetched after
 * the page is interactive, so pages that do not use a wallet do not pay for one in their first load.
 */
export function AccountSlot() {
  return <AccountControl />;
}
