"use client";

import dynamic from "next/dynamic";
import { ACCOUNT_SLOT } from "./account-button";

/**
 * What the server renders in place of the account control: a neutral block of exactly its size. The server does
 * not know whether the visitor has a wallet connected, so it shows neither state, and pages stay static.
 */
function AccountPlaceholder() {
  return (
    <div className={ACCOUNT_SLOT}>
      <span aria-hidden="true" className="block h-8 rounded-md bg-subtle pointer-coarse:h-11" />
    </div>
  );
}

const AccountControl = dynamic(() => import("./account-control").then((module) => module.AccountControl), {
  ssr: false,
  loading: AccountPlaceholder,
});

/**
 * The account control of the top bar. Everything that needs a wallet library is in a chunk that is fetched after
 * the page is interactive, so pages that do not use a wallet do not pay for one in their first load.
 */
export function AccountSlot() {
  return <AccountControl />;
}
