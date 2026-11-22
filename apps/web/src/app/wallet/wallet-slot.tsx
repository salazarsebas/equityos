"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";

const ROWS = Array.from({ length: 5 }, (_, index) => index);

/** Shape of the wallet region while its code loads: the account facts and a table frame. */
function WalletLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the wallet</span>
      <Skeleton className="h-24" />
      <div className="overflow-hidden rounded-lg border bg-surface">
        <div className="border-b px-4 py-3">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="h-8 border-b bg-subtle" />
        {ROWS.map((row) => (
          <div key={row} className="flex h-9 items-center gap-6 border-b px-4 last:border-b-0">
            <Skeleton className="w-12 shrink-0" />
            <Skeleton className="w-40 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}

const WalletView = dynamic(() => import("./wallet-view").then((module) => module.WalletView), {
  ssr: false,
  loading: WalletLoading,
});

/** The wallet region of the page. Its code uses the wallet libraries, so it is loaded in the browser only. */
export function WalletSlot(props: ComponentProps<typeof WalletView>) {
  return <WalletView {...props} />;
}
