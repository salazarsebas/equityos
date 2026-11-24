"use client";

import { type Address, isAddressEqual } from "viem";
import { useConnection } from "wagmi";
import { Link } from "@/components/ui/link";
import { WalletRuntime } from "@/components/wallet/runtime";

function Action({ identifier, creator }: { identifier: string; creator: Address }) {
  const { address } = useConnection();
  if (address === undefined || !isAddressEqual(address, creator)) return null;
  return <Link href={`/studio?index=${identifier}`}>Publish a new version</Link>;
}

/** The link to the Studio with this index loaded, shown when the connected account is the creator. */
export function NewVersionAction(props: { identifier: string; creator: Address }) {
  return (
    <WalletRuntime>
      <Action {...props} />
    </WalletRuntime>
  );
}
